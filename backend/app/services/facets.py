"""User vocabularies ("facets"). This module is the only write path for them.

A facet value is an ordinary Tag row with ``category == facet.key`` and
``name == f"{facet.key}:{value}"``, so FTS, tag backup and the tag cloud keep
working. Values are compared folded (accent- and case-insensitive). A
single-value facet holds at most one value per track: adding a value replaces
the old one. Every writer takes ``commit``; with ``commit=False`` the caller
owns the transaction. Messages are Greek and never show a facet key.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime

from sqlalchemy import delete, func
from sqlmodel import Session, select

from .. import db as dbmod
from ..models import Facet, SavedSearch, Tag, Track, TrackTag
from . import audit
from .facet_presets import PRESETS
from .query_grammar import Token, serialize, tokenize
from .sql_ids import ids_in
from .text_fold import fold_text

KEY_RE = re.compile(r"^[a-z][a-z0-9_]{1,30}$")

_GREEK_TO_LATIN = str.maketrans({
    "α": "a", "β": "v", "γ": "g", "δ": "d", "ε": "e", "ζ": "z", "η": "i", "θ": "th",
    "ι": "i", "κ": "k", "λ": "l", "μ": "m", "ν": "n", "ξ": "x", "ο": "o", "π": "p",
    "ρ": "r", "σ": "s", "τ": "t", "υ": "y", "φ": "f", "χ": "ch", "ψ": "ps", "ω": "o",
})


class FacetError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass
class TagDiff:
    added: list[int] = field(default_factory=list)
    removed: list[int] = field(default_factory=list)
    replaced: list[int] = field(default_factory=list)  # single-value siblings dropped by an add

    @property
    def changed(self) -> bool:
        return bool(self.added or self.removed or self.replaced)


def count_text(n: int, one: str, many: str) -> str:
    return f"{n} {one if n == 1 else many}"


def _tracks_text(n: int) -> str:
    return count_text(n, "κομμάτι", "κομμάτια")


def reserved_keys() -> frozenset[str]:
    from . import search  # search imports this module at load time

    return frozenset(search._FIELD_COMPILERS) | {"collections", "folder", "tag", "valence"}


# --- lookups ----------------------------------------------------------------

def get_by_key(session: Session, key: str) -> Facet | None:
    return session.exec(select(Facet).where(Facet.key == key)).first()


def _facet(session: Session, facet_id: int) -> Facet:
    facet = session.get(Facet, facet_id)
    if facet is None:
        raise FacetError("not_found", "Το λεξιλόγιο δεν βρέθηκε.")
    return facet


def _value_part(key: str, name: str) -> str:
    return name[len(key) + 1:]


def _values(session: Session, facet: Facet) -> list[Tag]:
    rows = session.exec(select(Tag).where(Tag.category == facet.key).order_by(Tag.id)).all()
    return [tag for tag in rows if tag.name.startswith(f"{facet.key}:")]


def _facet_of_tag(session: Session, tag: Tag) -> Facet | None:
    if tag.category and tag.name.startswith(f"{tag.category}:"):
        return get_by_key(session, tag.category)
    return None


def _value_tag(session: Session, tag_id: int) -> tuple[Tag, Facet]:
    tag = session.get(Tag, tag_id)
    facet = _facet_of_tag(session, tag) if tag is not None else None
    if facet is None:
        raise FacetError("not_found", "Η τιμή δεν βρέθηκε.")
    return tag, facet


def is_facet_name(session: Session, name: str) -> bool:
    key, sep, _value = (name or "").partition(":")
    return bool(sep) and get_by_key(session, key) is not None


def is_facet_tag(session: Session, tag: Tag) -> bool:
    return _facet_of_tag(session, tag) is not None


def value_ids(session: Session, facet: Facet, folded: str) -> list[int]:
    return [tag.id for tag in _values(session, facet) if fold_text(_value_part(facet.key, tag.name)) == folded]


def _track_ids(session: Session, tag_ids: list[int]) -> list[int]:
    if not tag_ids:
        return []
    return list(session.exec(
        select(TrackTag.track_id).where(ids_in(TrackTag.tag_id, tag_ids)).distinct().order_by(TrackTag.track_id)
    ).all())


def _tracks_with_many(session: Session, tag_ids: list[int]) -> int:
    """Tracks holding more than one of these tags."""
    if not tag_ids:
        return 0
    many = (
        select(TrackTag.track_id).where(ids_in(TrackTag.tag_id, tag_ids))
        .group_by(TrackTag.track_id).having(func.count() > 1).subquery()
    )
    return int(session.execute(select(func.count()).select_from(many)).scalar_one())


def _usage(session: Session, tag_ids: list[int]) -> dict[int, int]:
    if not tag_ids:
        return {}
    rows = session.exec(
        select(TrackTag.tag_id, func.count()).where(ids_in(TrackTag.tag_id, tag_ids)).group_by(TrackTag.tag_id)
    ).all()
    return {tag_id: count for tag_id, count in rows}


def _value_dict(facet: Facet, tag: Tag, count: int) -> dict:
    return {"id": tag.id, "value": _value_part(facet.key, tag.name), "count": count}


def _facet_dict(session: Session, facet: Facet, usage: dict[int, int] | None = None) -> dict:
    values = _values(session, facet)
    if usage is None:
        usage = _usage(session, [tag.id for tag in values])
    return {
        "id": facet.id, "key": facet.key, "label": facet.label, "multi": facet.multi,
        "sort_order": facet.sort_order,
        "values": [_value_dict(facet, tag, usage.get(tag.id, 0)) for tag in values],
    }


def list_facets(session: Session) -> list[dict]:
    rows = session.exec(select(Facet).order_by(Facet.sort_order, Facet.id)).all()
    keys = [facet.key for facet in rows]
    usage: dict[int, int] = {}
    if keys:
        usage = {tag_id: count for tag_id, count in session.exec(
            select(TrackTag.tag_id, func.count()).join(Tag, Tag.id == TrackTag.tag_id)
            .where(ids_in(Tag.category, keys)).group_by(TrackTag.tag_id)
        ).all()}
    return [_facet_dict(session, facet, usage) for facet in rows]


# --- validation -------------------------------------------------------------

def _clean_label(label: str | None) -> str:
    cleaned = (label or "").strip()
    if not cleaned:
        raise FacetError("invalid", "Το όνομα του λεξιλογίου δεν μπορεί να είναι κενό.")
    return cleaned


def _clean_value(value: str | None) -> str:
    cleaned = (value or "").strip()
    if not cleaned:
        raise FacetError("invalid", "Η τιμή δεν μπορεί να είναι κενή.")
    if '"' in cleaned:
        raise FacetError("invalid", "Η τιμή δεν επιτρέπεται να περιέχει διπλά εισαγωγικά.")
    if cleaned == "*":  # would collide with the `key:*` search token
        raise FacetError("invalid", "Η τιμή «*» δεν επιτρέπεται.")
    return cleaned


def _check_unique_value(session: Session, facet: Facet, value: str, *, exclude_id: int | None = None) -> None:
    folded = fold_text(value)
    for tag in _values(session, facet):
        if tag.id != exclude_id and fold_text(_value_part(facet.key, tag.name)) == folded:
            raise FacetError("duplicate", f"Υπάρχει ήδη τιμή «{value}» σε αυτό το λεξιλόγιο.")


def _check_adoption(session: Session, label: str, multi: bool, value_tag_ids: list[int]) -> None:
    if multi:
        return
    many = _tracks_with_many(session, value_tag_ids)
    if many:
        raise FacetError(
            "conflict",
            f"Η υιοθέτηση θα έδινε σε {_tracks_text(many)} περισσότερες από μία τιμές στο λεξιλόγιο «{label}».",
        )


def _foreign_tag_error(value: str, label: str, category: str) -> FacetError:
    return FacetError(
        "conflict", f"Η τιμή «{value}» του λεξιλογίου «{label}» υπάρχει ήδη ως tag της κατηγορίας «{category}».",
    )


def slug_key(session: Session, label: str) -> str:
    """A readable ASCII key from a (Greek) label; always matches KEY_RE."""
    reserved = reserved_keys()
    base = re.sub(r"[^a-z0-9]+", "_", fold_text(label or "").translate(_GREEK_TO_LATIN)).strip("_")
    base = base or "facet"
    if base in reserved or not base[0].isalpha() or len(base) < 2:
        base = f"f_{base}"
    base = base[:28].rstrip("_")
    candidate, n = base, 2
    while candidate in reserved or get_by_key(session, candidate) is not None:
        candidate, n = f"{base}_{n}", n + 1
    return candidate


def _reindex(session: Session, track_ids: list[int]) -> None:
    for track_id in track_ids:
        dbmod.reindex_track(session, track_id, commit=False)


# --- facets -----------------------------------------------------------------

def create_facet(session: Session, label: str, multi: bool, key: str | None = None, *, commit: bool = True) -> Facet:
    label = _clean_label(label)
    if key is None:
        key = slug_key(session, label)
    elif key in reserved_keys():
        raise FacetError("reserved_key", "Αυτό το κλειδί το χρησιμοποιεί ήδη η αναζήτηση.")
    elif not KEY_RE.match(key):
        raise FacetError("invalid", "Το κλειδί δέχεται μόνο λατινικά πεζά, ψηφία και _ (2 έως 31 χαρακτήρες).")
    elif get_by_key(session, key) is not None:
        raise FacetError("duplicate", "Υπάρχει ήδη λεξιλόγιο με αυτό το κλειδί.")
    last = session.execute(select(func.max(Facet.sort_order))).scalar_one()
    facet = Facet(key=key, label=label, multi=bool(multi), sort_order=0 if last is None else last + 1)
    session.add(facet)
    session.flush()
    if commit:
        session.commit()
    return facet


def update_facet(
    session: Session, facet_id: int, *, label: str | None = None, multi: bool | None = None,
    sort_order: int | None = None, commit: bool = True,
) -> dict:
    facet = _facet(session, facet_id)
    if label is not None:
        facet.label = _clean_label(label)
    if multi is not None:
        if facet.multi and not multi:
            many = _tracks_with_many(session, [tag.id for tag in _values(session, facet)])
            if many:
                raise FacetError(
                    "multi_to_single", f"Κομμάτια με περισσότερες από μία τιμές: {many}. Αφαίρεσέ τες πρώτα.",
                )
        facet.multi = bool(multi)
    if sort_order is not None:
        facet.sort_order = sort_order
    session.add(facet)
    session.flush()
    if commit:
        session.commit()
    return _facet_dict(session, facet)


def delete_facet(session: Session, facet_id: int, *, force: bool = False, commit: bool = True) -> dict:
    facet = _facet(session, facet_id)
    values = _values(session, facet)
    ids = [tag.id for tag in values]
    tracks = _track_ids(session, ids)
    if not force:
        raise FacetError(
            "needs_force",
            f"Το λεξιλόγιο «{facet.label}» έχει {count_text(len(values), 'τιμή', 'τιμές')} "
            f"σε {_tracks_text(len(tracks))}. Επιβεβαίωσε για διαγραφή.",
        )
    if ids:
        session.execute(delete(TrackTag).where(ids_in(TrackTag.tag_id, ids)))
        session.execute(delete(Tag).where(ids_in(Tag.id, ids)))
    session.delete(facet)
    session.flush()
    _reindex(session, tracks)
    if commit:
        session.commit()
    return {"deleted_values": len(values), "untagged_tracks": len(tracks)}


# --- values -----------------------------------------------------------------

def add_value(session: Session, facet_id: int, value: str, *, commit: bool = True) -> Tag:
    facet = _facet(session, facet_id)
    value = _clean_value(value)
    _check_unique_value(session, facet, value)
    name = f"{facet.key}:{value}"
    tag = session.exec(select(Tag).where(Tag.name == name)).first()
    if tag is None:
        tag = Tag(name=name, category=facet.key)
        session.add(tag)
        session.flush()
    elif tag.category is not None and tag.category != facet.key:
        raise _foreign_tag_error(value, facet.label, tag.category)
    else:  # an uncategorised tag with this exact name becomes the value
        _check_adoption(session, facet.label, facet.multi, [t.id for t in _values(session, facet)] + [tag.id])
        tag.category = facet.key
        session.add(tag)
        session.flush()
        _reindex(session, _track_ids(session, [tag.id]))
    if commit:
        session.commit()
    return tag


def _matching_searches(session: Session, key: str, value: str) -> list[tuple[SavedSearch, list[Token], set[int]]]:
    """Saved searches holding a `key:value` token (field case-insensitive, value folded)."""
    folded = fold_text(value)
    out = []
    for saved in session.exec(select(SavedSearch).order_by(SavedSearch.id)).all():
        tokens = tokenize(saved.query)
        hits = {i for i, tok in enumerate(tokens)
                if tok.field and tok.field.lower() == key and fold_text(tok.value) == folded}
        if hits:
            out.append((saved, tokens, hits))
    return out


def rename_value(session: Session, tag_id: int, value: str, *, commit: bool = True) -> dict:
    """Rename a value, rewrite saved searches that use it and reindex, in one transaction."""
    tag, facet = _value_tag(session, tag_id)
    value = _clean_value(value)
    _check_unique_value(session, facet, value, exclude_id=tag.id)
    name = f"{facet.key}:{value}"
    if name != tag.name and session.exec(select(Tag).where(Tag.name == name)).first() is not None:
        raise FacetError("conflict", f"Υπάρχει ήδη tag με το όνομα της τιμής «{value}».")
    old = _value_part(facet.key, tag.name)
    rewritten = 0
    for saved, tokens, hits in _matching_searches(session, facet.key, old):
        saved.query = serialize(replace(tok, value=value) if i in hits else tok for i, tok in enumerate(tokens))
        saved.updated_at = datetime.now(UTC)
        session.add(saved)
        rewritten += 1
    tag.name = name
    session.add(tag)
    session.flush()
    tracks = _track_ids(session, [tag.id])
    _reindex(session, tracks)
    if commit:
        session.commit()
    return {**_value_dict(facet, tag, len(tracks)), "rewritten_searches": rewritten}


def delete_value(session: Session, tag_id: int, *, force: bool = False, commit: bool = True) -> dict:
    """Delete a value. Saved searches that use it are reported, never edited."""
    tag, facet = _value_tag(session, tag_id)
    value = _value_part(facet.key, tag.name)
    tracks = _track_ids(session, [tag.id])
    broken = [saved.name for saved, _tokens, _hits in _matching_searches(session, facet.key, value)]
    if tracks and not force:
        message = f"Η τιμή «{value}» χρησιμοποιείται σε {_tracks_text(len(tracks))}."
        if broken:
            message += " Θα επηρεαστούν οι αναζητήσεις: " + ", ".join(f"«{n}»" for n in broken) + "."
        raise FacetError("needs_force", message + " Επιβεβαίωσε για διαγραφή.")
    session.execute(delete(TrackTag).where(TrackTag.tag_id == tag.id))
    session.delete(tag)
    session.flush()
    _reindex(session, tracks)
    if commit:
        session.commit()
    return {"removed_assignments": len(tracks), "broken_searches": broken}


# --- assignments ------------------------------------------------------------

def validate_tag_ids(session: Session, add_ids, remove_ids) -> dict[int, Facet]:
    """Check a tag change before any write: known ids, no id both added and
    removed, at most one added value per single-value facet. Returns the
    single-value facet of each added id that has one."""
    add, remove = list(dict.fromkeys(add_ids)), list(dict.fromkeys(remove_ids))
    if set(add) & set(remove):
        raise FacetError("invalid", "Το ίδιο tag δεν μπορεί να προστεθεί και να αφαιρεθεί μαζί.")
    tags = {tag.id: tag for tag in session.exec(select(Tag).where(ids_in(Tag.id, add + remove))).all()}
    if len(tags) != len(set(add + remove)):
        raise FacetError("not_found", "Άγνωστο tag.")
    single: dict[int, Facet] = {}
    for tag_id in add:
        facet = _facet_of_tag(session, tags[tag_id])
        if facet is None or facet.multi:
            continue
        if any(other.key == facet.key for other in single.values()):
            raise FacetError("single_conflict", f"Το λεξιλόγιο «{facet.label}» δέχεται μία μόνο τιμή.")
        single[tag_id] = facet
    return single


def _diff(session: Session, track_id: int, add_ids, remove_ids) -> TagDiff:
    add, remove = list(dict.fromkeys(add_ids)), list(dict.fromkeys(remove_ids))
    single = validate_tag_ids(session, add, remove)
    if session.get(Track, track_id) is None:
        raise FacetError("not_found", "Το κομμάτι δεν βρέθηκε.")
    current = set(session.exec(select(TrackTag.tag_id).where(TrackTag.track_id == track_id)).all())
    replaced: set[int] = set()
    for tag_id, facet in single.items():
        siblings = {tag.id for tag in _values(session, facet)}
        replaced |= (current & siblings) - {tag_id} - set(remove)
    return TagDiff(
        added=[t for t in add if t not in current],
        removed=[t for t in remove if t in current],
        replaced=sorted(replaced),
    )


def plan_tag_changes(session: Session, track_id: int, add_ids, remove_ids) -> TagDiff:
    """The TagDiff apply_tag_changes would produce. Never writes."""
    return _diff(session, track_id, add_ids, remove_ids)


def apply_tag_changes(
    session: Session, track_id: int, add_ids, remove_ids, *, commit: bool = True, reindex: bool = True,
) -> TagDiff:
    """Link and unlink tags on one track, enforcing single-value facets.

    With ``reindex=False`` it neither reindexes nor audits: bulk callers own both.
    """
    diff = _diff(session, track_id, add_ids, remove_ids)
    for tag_id in diff.added:
        session.add(TrackTag(track_id=track_id, tag_id=tag_id))
    dropped = diff.removed + diff.replaced
    if dropped:
        session.execute(delete(TrackTag).where(TrackTag.track_id == track_id, ids_in(TrackTag.tag_id, dropped)))
    session.flush()
    if reindex and diff.changed:
        dbmod.reindex_track(session, track_id, commit=False)
        audit.log(session, "tags_update", "track", track_id,
                  {"tags_removed": dropped}, {"tags_added": diff.added}, commit=False)
    if commit:
        session.commit()
    return diff


# --- presets ----------------------------------------------------------------

def seed_preset(session: Session, name: str, *, commit: bool = True) -> dict:
    """Idempotent and additive: creates missing facets and values, adopts an
    uncategorised tag with the same name, and refuses (before writing anything)
    a tag owned by another category or an adoption that breaks single-value."""
    preset = PRESETS.get(name)
    if preset is None:
        raise FacetError("not_found", "Άγνωστο προτεινόμενο λεξιλόγιο.")
    plan = []
    for spec in preset:
        key = spec["key"]
        facet = get_by_key(session, key)
        label = facet.label if facet else spec["label"]
        multi = facet.multi if facet else spec["multi"]
        existing = _values(session, facet) if facet else []
        present = {fold_text(_value_part(key, tag.name)) for tag in existing}
        actions = []
        for value in spec["values"]:
            if fold_text(value) in present:
                continue
            tag = session.exec(select(Tag).where(Tag.name == f"{key}:{value}")).first()
            if tag is not None and tag.category not in (None, key):
                raise _foreign_tag_error(value, label, tag.category)
            actions.append((value, tag))
        adopted = [tag.id for _value, tag in actions if tag is not None]
        if adopted:
            _check_adoption(session, label, multi, [tag.id for tag in existing] + adopted)
        plan.append((facet, spec, actions))

    result = {"created_facets": 0, "created_values": 0, "adopted_tags": 0}
    touched: list[int] = []
    for facet, spec, actions in plan:
        if facet is None:
            create_facet(session, spec["label"], spec["multi"], key=spec["key"], commit=False)
            result["created_facets"] += 1
        for value, tag in actions:
            if tag is None:
                session.add(Tag(name=f"{spec['key']}:{value}", category=spec["key"]))
                result["created_values"] += 1
            else:
                tag.category = spec["key"]
                session.add(tag)
                result["adopted_tags"] += 1
                touched.append(tag.id)
    session.flush()
    _reindex(session, _track_ids(session, touched))
    if commit:
        session.commit()
    return result
