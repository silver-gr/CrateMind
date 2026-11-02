"""Facets service: vocabularies, the single-value rule, presets, safe rename and delete."""
from __future__ import annotations

import re

import pytest
from sqlalchemy import text
from sqlmodel import select

from app.db import reindex_track
from app.models import Facet, SavedSearch, Tag, Track, TrackTag
from app.services import facets, search
from app.services.facet_presets import THERAPY_PRESET
from app.services.facets import FacetError

KEY_RE = re.compile(r"^[a-z][a-z0-9_]{1,30}$")


def _track(db, path="/a.mp3", **fields) -> Track:
    t = Track(absolute_path=path, **fields)
    db.add(t)
    db.commit()
    db.refresh(t)
    reindex_track(db, t.id)
    return t


def _link(db, track_id, tag_id):
    db.add(TrackTag(track_id=track_id, tag_id=tag_id))
    db.commit()
    reindex_track(db, track_id)


def _value(db, key, value) -> Tag:
    return db.exec(select(Tag).where(Tag.name == f"{key}:{value}")).one()


def _fts_tags(db, track_id) -> str:
    return db.execute(text("SELECT tags FROM track_search WHERE rowid = :id"), {"id": track_id}).scalar_one()


def _links(db):
    return sorted((r.track_id, r.tag_id) for r in db.exec(select(TrackTag)).all())


def test_preset_seed_is_idempotent_and_additive(db):
    first = facets.seed_preset(db, "therapy")
    assert first == {"created_facets": 8, "created_values": 47, "adopted_tags": 0}
    assert len(db.exec(select(Facet)).all()) == 8
    assert len(db.exec(select(Tag).where(Tag.category.is_not(None))).all()) == 47
    purpose = facets.get_by_key(db, "purpose")
    extra = facets.add_value(db, purpose.id, "δική μου")
    assert facets.seed_preset(db, "therapy") == {"created_facets": 0, "created_values": 0, "adopted_tags": 0}
    assert db.get(Tag, extra.id).name == "purpose:δική μου"
    assert len(db.exec(select(Facet)).all()) == 8


def test_seed_adopts_uncategorised_tag_and_errors_on_foreign_category(db):
    own = Tag(name="purpose:χαλάρωση")
    db.add(own)
    db.commit()
    result = facets.seed_preset(db, "therapy")
    assert result["adopted_tags"] == 1
    assert db.get(Tag, own.id).category == "purpose"


def test_seed_errors_on_foreign_category(db):
    db.add(Tag(name="mood:γαλήνια", category="other"))
    db.commit()
    with pytest.raises(FacetError) as error:
        facets.seed_preset(db, "therapy")
    assert error.value.code == "conflict"
    assert str(error.value) == "Η τιμή «γαλήνια» του λεξιλογίου «Διάθεση» υπάρχει ήδη ως tag της κατηγορίας «other»."
    assert db.exec(select(Facet)).all() == []  # before the rollback: nothing was flushed
    db.rollback()


def test_seed_refuses_adoption_that_breaks_single_value(db):
    t = _track(db, title="Track")
    a, b = Tag(name="voice:οργανικό"), Tag(name="voice:με στίχους")
    db.add_all([a, b])
    db.commit()
    _link(db, t.id, a.id)
    _link(db, t.id, b.id)
    fts_before, links_before = _fts_tags(db, t.id), _links(db)
    with pytest.raises(FacetError) as error:
        facets.seed_preset(db, "therapy")
    assert error.value.code == "conflict"
    assert str(error.value) == "Η υιοθέτηση θα έδινε σε 1 κομμάτι περισσότερες από μία τιμές στο λεξιλόγιο «Φωνή»."
    assert db.exec(select(Facet)).all() == []  # before the rollback: nothing was flushed
    db.rollback()
    assert db.get(Tag, a.id).category is None and db.get(Tag, b.id).category is None
    assert _links(db) == links_before
    assert _fts_tags(db, t.id) == fts_before


def test_slug_key(db):
    assert facets.slug_key(db, "Θεραπευτικός στόχος") == "therapeytikos_stochos"
    facets.create_facet(db, "Φωνή", True, key="foni")
    assert facets.slug_key(db, "Φωνή") == "foni_2"
    assert facets.slug_key(db, "Energy") == "f_energy"
    assert facets.slug_key(db, "1η φάση") == "f_1i_fasi"
    assert facets.slug_key(db, "!!!") == "facet"
    long_key = facets.slug_key(db, "Πολύ μεγάλο όνομα λεξιλογίου που ξεπερνά κάθε λογικό όριο εδώ")
    for label in ["Θεραπευτικός στόχος", "Φωνή", "Energy", "1η φάση", "!!!", "Α", "x" * 60]:
        assert KEY_RE.match(facets.slug_key(db, label)), label
    assert KEY_RE.match(long_key)
    assert facets.create_facet(db, "Νέο λεξιλόγιο", True).key == "neo_lexilogio"


def test_value_validation(db):
    f = facets.create_facet(db, "Θεραπευτικός στόχος", True, key="purpose")
    facets.add_value(db, f.id, "Χαλάρωση")
    cases = [
        ("χαλαρωση", "duplicate", "Υπάρχει ήδη τιμή «χαλαρωση» σε αυτό το λεξιλόγιο."),
        ('a"b', "invalid", "Η τιμή δεν επιτρέπεται να περιέχει διπλά εισαγωγικά."),
        ("   ", "invalid", "Η τιμή δεν μπορεί να είναι κενή."),
        ("*", "invalid", "Η τιμή «*» δεν επιτρέπεται."),
    ]
    for value, code, message in cases:
        with pytest.raises(FacetError) as error:
            facets.add_value(db, f.id, value)
        assert (error.value.code, str(error.value)) == (code, message), value
    assert facets.add_value(db, f.id, "  νέο  ").name == "purpose:νέο"
    assert facets.add_value(db, f.id, "a:b").name == "purpose:a:b"


def test_reserved_and_bad_keys(db):
    for key in ["energy", "folder", "collections", "tag", "valence"]:
        with pytest.raises(FacetError) as error:
            facets.create_facet(db, "Χ", True, key=key)
        assert error.value.code == "reserved_key", key
    for key in ["Bad Key", "1abc", "a", "x" * 32]:
        with pytest.raises(FacetError) as error:
            facets.create_facet(db, "Χ", True, key=key)
        assert error.value.code == "invalid", key
    facets.create_facet(db, "Φωνή", False, key="voice")
    with pytest.raises(FacetError) as error:
        facets.create_facet(db, "Φωνή 2", False, key="voice")
    assert error.value.code == "duplicate"


def test_reserved_keys_cover_every_field_compiler():
    reserved = facets.reserved_keys()
    assert set(search._FIELD_COMPILERS) <= reserved
    assert not {f["key"] for f in THERAPY_PRESET} & reserved


def _voice(db, multi=False):
    f = facets.create_facet(db, "Φωνή", multi, key="voice")
    return f, facets.add_value(db, f.id, "Α"), facets.add_value(db, f.id, "Β")


def test_single_value_replace_rule(db):
    t = _track(db)
    f, a, b = _voice(db)
    assert facets.apply_tag_changes(db, t.id, [a.id], []).added == [a.id]
    diff = facets.apply_tag_changes(db, t.id, [b.id], [])
    assert diff.added == [b.id] and diff.replaced == [a.id]
    assert _links(db) == [(t.id, b.id)]
    with pytest.raises(FacetError) as error:
        facets.apply_tag_changes(db, t.id, [a.id, b.id], [])
    assert error.value.code == "single_conflict"

    m = facets.create_facet(db, "Διάθεση", True, key="mood")
    x, y = facets.add_value(db, m.id, "χ"), facets.add_value(db, m.id, "ψ")
    facets.apply_tag_changes(db, t.id, [x.id], [])
    assert facets.apply_tag_changes(db, t.id, [y.id], []).replaced == []
    assert {x.id, y.id} <= {tag for _t, tag in _links(db)}


def test_plan_tag_changes_never_writes(db):
    t = _track(db)
    f, a, b = _voice(db)
    facets.apply_tag_changes(db, t.id, [a.id], [])
    diff = facets.plan_tag_changes(db, t.id, [b.id], [])
    assert diff.replaced == [a.id] and diff.added == [b.id]
    db.rollback()
    assert _links(db) == [(t.id, a.id)]


def test_multi_to_single_refused_with_count(db):
    t = _track(db)
    f, a, b = _voice(db, multi=True)
    facets.apply_tag_changes(db, t.id, [a.id, b.id], [])
    with pytest.raises(FacetError) as error:
        facets.update_facet(db, f.id, multi=False)
    assert error.value.code == "multi_to_single"
    assert str(error.value) == "Κομμάτια με περισσότερες από μία τιμές: 1. Αφαίρεσέ τες πρώτα."
    facets.apply_tag_changes(db, t.id, [], [b.id])
    assert facets.update_facet(db, f.id, multi=False)["multi"] is False


def test_delete_facet_requires_force_and_cascades(db):
    t1, t2 = _track(db, "/1.mp3"), _track(db, "/2.mp3")
    f = facets.create_facet(db, "Φωνή", True, key="voice")
    a, b, c = (facets.add_value(db, f.id, v) for v in ("οργανικό", "χορωδία", "σόλο"))
    facets.apply_tag_changes(db, t1.id, [a.id, b.id], [])
    facets.apply_tag_changes(db, t2.id, [c.id], [])
    with pytest.raises(FacetError) as error:
        facets.delete_facet(db, f.id)
    assert error.value.code == "needs_force"
    assert str(error.value) == "Το λεξιλόγιο «Φωνή» έχει 3 τιμές σε 2 κομμάτια. Επιβεβαίωσε για διαγραφή."
    assert facets.delete_facet(db, f.id, force=True) == {"deleted_values": 3, "untagged_tracks": 2}
    assert db.get(Facet, f.id) is None
    assert db.exec(select(Tag).where(Tag.category == "voice")).all() == []
    assert _links(db) == []
    assert search.search(db, "οργανικο") == []


def test_rename_rewrites_saved_searches_keeping_negation_and_quotes(db):
    facets.seed_preset(db, "therapy")
    t = _track(db)
    relax = _value(db, "purpose", "χαλάρωση")
    facets.apply_tag_changes(db, t.id, [relax.id], [])
    queries = ["purpose:χαλαρωση -mood:γαλήνια", '-purpose:"Χαλάρωση"', "PURPOSE:χαλάρωση", "energy:7+"]
    saved = [SavedSearch(name=f"s{i}", query=q) for i, q in enumerate(queries)]
    db.add_all(saved)
    db.commit()

    result = facets.rename_value(db, relax.id, "ηρεμία")
    assert result["rewritten_searches"] == 3 and result["value"] == "ηρεμία"
    assert [db.get(SavedSearch, s.id).query for s in saved] == [
        "purpose:ηρεμία -mood:γαλήνια", '-purpose:"ηρεμία"', "PURPOSE:ηρεμία", "energy:7+",
    ]
    assert [x.id for x in search.search(db, "ηρεμία")] == [t.id]
    assert search.search(db, "χαλάρωση") == []

    sleep = _value(db, "purpose", "ύπνος")
    with pytest.raises(FacetError) as error:
        facets.rename_value(db, sleep.id, "ΗΡΕΜΙΑ")
    assert error.value.code == "duplicate"
    db.rollback()
    assert db.get(Tag, sleep.id).name == "purpose:ύπνος"


def test_delete_value_reports_tracks_and_broken_searches(db):
    facets.seed_preset(db, "therapy")
    purpose = facets.get_by_key(db, "purpose")
    calm = facets.add_value(db, purpose.id, "ηρεμία")
    unused = facets.add_value(db, purpose.id, "αχρησιμοποίητη")
    t1, t2 = _track(db, "/1.mp3"), _track(db, "/2.mp3")
    for t in (t1, t2):
        facets.apply_tag_changes(db, t.id, [calm.id], [])
    db.add(SavedSearch(name="Ήρεμα", query="purpose:ηρεμια"))
    db.commit()

    with pytest.raises(FacetError) as error:
        facets.delete_value(db, calm.id)
    assert error.value.code == "needs_force"
    assert str(error.value) == (
        "Η τιμή «ηρεμία» χρησιμοποιείται σε 2 κομμάτια. Θα επηρεαστούν οι αναζητήσεις: «Ήρεμα». "
        "Επιβεβαίωσε για διαγραφή."
    )
    assert facets.delete_value(db, calm.id, force=True) == {"removed_assignments": 2, "broken_searches": ["Ήρεμα"]}
    assert db.get(Tag, calm.id) is None
    assert db.exec(select(SavedSearch)).one().query == "purpose:ηρεμια"

    t3 = _track(db, "/3.mp3")
    facets.apply_tag_changes(db, t3.id, [unused.id], [])
    with pytest.raises(FacetError) as error:
        facets.delete_value(db, unused.id)
    assert str(error.value) == "Η τιμή «αχρησιμοποίητη» χρησιμοποιείται σε 1 κομμάτι. Επιβεβαίωσε για διαγραφή."


def test_fts_indexes_only_the_value_part(db):
    facets.seed_preset(db, "therapy")
    t = _track(db)
    plain = Tag(name="my tag")
    db.add(plain)
    db.commit()
    facets.apply_tag_changes(db, t.id, [_value(db, "purpose", "χαλάρωση").id, plain.id], [])
    assert _fts_tags(db, t.id) == "χαλαρωση my tag"
    assert search.search(db, "purpose") == []


def test_count_text():
    assert facets.count_text(1, "κομμάτι", "κομμάτια") == "1 κομμάτι"
    assert facets.count_text(2, "κομμάτι", "κομμάτια") == "2 κομμάτια"


def _categorised(db, key, *values) -> list[Tag]:
    """`key:value` tags that already carry category == key before any vocabulary exists."""
    tags = [Tag(name=f"{key}:{value}", category=key) for value in values]
    db.add_all(tags)
    db.commit()
    return tags


def test_create_facet_checks_existing_category_tags(db):
    t = _track(db, title="Track")
    dup = _categorised(db, "voice", "Οργανικό", "οργανικο")
    with pytest.raises(FacetError) as error:
        facets.create_facet(db, "Φωνή", True, key="voice")
    assert error.value.code == "conflict"
    assert str(error.value) == "Το λεξιλόγιο «Φωνή» θα είχε διπλές τιμές: «Οργανικό» και «οργανικο»."
    assert db.exec(select(Facet)).all() == []  # before the rollback: nothing was flushed
    db.rollback()
    for tag in dup:
        db.delete(db.get(Tag, tag.id))
    db.commit()

    for bad in ("*", 'a"b', "   ", " a"):
        (tag,) = _categorised(db, "voice", bad)
        with pytest.raises(FacetError) as error:
            facets.create_facet(db, "Φωνή", True, key="voice")
        assert error.value.code == "conflict"
        assert str(error.value) == f"Η τιμή «{bad}» δεν είναι έγκυρη τιμή για το λεξιλόγιο «Φωνή»."
        assert db.exec(select(Facet)).all() == []  # before the rollback: nothing was flushed
        db.rollback()
        db.delete(db.get(Tag, tag.id))
        db.commit()

    a, b = _categorised(db, "voice", "a", "b")
    _link(db, t.id, a.id)
    _link(db, t.id, b.id)
    with pytest.raises(FacetError) as error:
        facets.create_facet(db, "Φωνή", False, key="voice")
    assert error.value.code == "conflict"
    assert db.exec(select(Facet)).all() == []  # before the rollback: nothing was flushed
    db.rollback()

    assert "voice:a" in _fts_tags(db, t.id)
    facets.create_facet(db, "Φωνή", True, key="voice")
    assert _fts_tags(db, t.id) == "a b"


def test_seed_checks_existing_category_tags_before_writing(db):
    t = _track(db, title="Track")
    a, b = _categorised(db, "voice", "a", "b")
    _link(db, t.id, a.id)
    _link(db, t.id, b.id)
    with pytest.raises(FacetError) as error:
        facets.seed_preset(db, "therapy")
    assert error.value.code == "conflict"
    assert str(error.value) == "Η υιοθέτηση θα έδινε σε 1 κομμάτι περισσότερες από μία τιμές στο λεξιλόγιο «Φωνή»."
    assert db.exec(select(Facet)).all() == []  # before the rollback: nothing was flushed
    db.rollback()

    db.delete(db.get(TrackTag, (t.id, b.id)))
    db.commit()
    reindex_track(db, t.id)
    assert _fts_tags(db, t.id) == "voice:a"
    facets.seed_preset(db, "therapy")
    assert _fts_tags(db, t.id) == "a"
    assert search.search(db, "voice") == []
