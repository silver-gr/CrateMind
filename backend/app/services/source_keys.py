"""Text keys that say when a local track and a remote record, or two remote records, are the same recording.

Pure functions on plain records (id, service, title, artist, dur, album, uploader, file_name, sc_pub_artist, isrc):
no database and no files. Ported from the measured prototype in .omc/research/source-linking-2026-11-26/prototype
(keys.py, s2.py, s3.py, s3c.py, s5.py); its precision numbers hold for these rules as written, so re-measure
before changing one.
"""
from __future__ import annotations

import bisect
import re
import unicodedata
from collections import defaultdict
from difflib import SequenceMatcher

# Link rules, tightest first. The last two match on the title alone.
LINK_RULES = ('text_exact', 'text_clean', 'artist_variant', 'artist_in_title', 'same_words',
              'title_unknown_artist', 'title_supported')
TITLE_ONLY_RULES = ('title_unknown_artist', 'title_supported')
FOLD_RULES = ('isrc_duration', 'text_exact', 'text_clean', 'artist_in_title')
# Matches that are never automatic: the title alone with no support, and the same song in another version.
RANK = {rule: i for i, rule in enumerate(LINK_RULES + ('title_only', 'version'))}

EXT = re.compile(r"\.(?:aac|aiff?|alac|flac|m4a|mp3|ogg|opus|wav|wma)\s*$", re.I)
VERSION_RE = re.compile(
    r"\b(?:remix|rmx|rmix|edit|mix|version|vers|live|remaster(?:ed)?|rework|bootleg|vip|dub|instrumental|extended|radio|flip|"
    r"refix|remake|cover|mashup|mash up|re edit|reedit|acoustic|reprise|rebuild|redux|remode|retouch|revision|reboot|rewerk|"
    r"preview|teaser|clip|snippet|sample|demo|wip|unmastered|unreleased|part|pt)\b", re.I)
ORIGINAL_RE = re.compile(r"^\s*(?:the\s+)?original(?:\s+(?:mix|version|edit))?\s*$", re.I)
NOISE_BRACKET_RE = re.compile(
    r"free\s*(?:download|dl|dowload)|\bdownload\b|out\s+now|out\s+on|\bsoon\b|forthcoming|released|premiere|official|\bfull\s+track\b|"
    r"\brecords?\b|\brecs?\b|\brecordings\b|\bmusic\b|\bv\.?\s?a\.?\b|\bep\b|\balbum\b|\bmaster(?:ed|ing)?\b|buy|bandcamp|beatport|"
    r"spotify|soundcloud|youtube|^\s*\d{2,3}(?:[.,]\d+)?\s*(?:bpm)?\s*$|^\s*(?:19|20)\d{2}\s*$|\bbpm\b|"
    r"^\s*[a-g][#b]?\s*(?:m|min|maj|minor|major)?\s*$|^\s*[A-Z]{2,8}[-_ ]?\d{2,6}\s*$", re.I)
INLINE_NOISE = (
    re.compile(r"_+\s*free\s*(?:download|dl)\s*_+", re.I),
    re.compile(r"[/|>*!~-]*\s*\bfree\s*(?:download|dl|dowload)\b.*$", re.I),
    re.compile(r"\b(?:out\s+now|premiere\s*:?|preview\s*:)\b.*$", re.I),
    re.compile(r"\b\d{2,3}(?:[.,]\d+)?\s*bpm\b", re.I),
    re.compile(r"\b(?:official\s+(?:audio|video|music\s+video))\b", re.I),
)
LEAD_NUM = re.compile(r"^\s*(?:[a-d]\d\s*[-._)]\s+|\d{1,3}\s*[-._)]\s*|\d{1,3}\s+(?=\S))")
FEAT_RE = re.compile(r"\b(?:feat(?:uring)?|ft)\b\.?", re.I)
ARTIST_SPLIT = re.compile(r"\s*(?:,|;|&|\+|/|\bx\b|\bvs\b\.?|\bversus\b|\band\b|\bfeat(?:uring)?\b\.?|\bft\b\.?|\bwith\b|\bmeets\b)\s*", re.I)
WEAK_ARTISTS = {"unknown artist", "unknown", "various artists", "various", "va", "v a", "n a", "", "artist"}
BRACKETS = re.compile(r"[\[(【〔{]([^\[\](){}【】〔〕]*)[\])】〕}]")
DECOR = re.compile(r"[ૐ◉★☆♫♪•●▶►◄✦✧❖◆◇■□▲△▼▽✪✩⚡️❤️🔥💎👽🫠💥🔮💀🤘🍄👁🌀🕉️✨]+")
DASH = re.compile(r"\s+-\s+")
BAG_STOP = {"and", "the", "a", "vs", "feat", "ft", "x"}
FUZZY_STOP = BAG_STOP | {"of", "in", "to", "mix", "original", "remix", "edit", "version"}


def norm(text):
    """Case and accents folded, '&' read as 'and', punctuation as spaces."""
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(ch for ch in text if not unicodedata.combining(ch)).casefold().replace("&", " and ")
    return re.sub(r"\s+", " ", re.sub(r"[^\w]+", " ", text).replace("_", " ")).strip()


def _spell(text):
    for pattern, word in ((r"\brmx\b|\brmix\b", "remix"), (r"\bremastered\b", "remaster"), (r"\bvers\b", "version"), (r"\bpt\b", "part")):
        text = re.sub(pattern, word, text)
    return text


def version_text(text):
    """One version phrase in a single spelling; 'Original Mix' is no version."""
    text = re.sub(r"^the ", "", _spell(norm(text)))
    return "" if ORIGINAL_RE.match(text) else text


def split_artists(text):
    text = DECOR.sub(" ", BRACKETS.sub(" ", unicodedata.normalize("NFKC", text or "")))
    return [name for name in map(norm, ARTIST_SPLIT.split(text)) if name not in WEAK_ARTISTS]


def parse_title(title):
    """A title as dash-separated segments, its version text, featured artists and the other bracket texts."""
    text = unicodedata.normalize("NFKC", title or "")
    text = DECOR.sub(" ", EXT.sub("", text).replace("—", "-").replace("–", "-"))
    for noise in INLINE_NOISE:
        text = noise.sub(" ", text)
    versions, feats, extra = [], [], []

    def bracket(match):
        inner = match.group(1).strip()
        if not inner:
            return " "
        if FEAT_RE.search(inner):
            before, after = FEAT_RE.split(inner, 1)
            feats.extend(split_artists(after))
            if before.strip():
                extra.append(norm(before))
        elif VERSION_RE.search(inner):
            versions.append(version_text(inner))
        elif not NOISE_BRACKET_RE.search(inner):
            extra.append(norm(inner))
        return " "

    for _ in range(3):
        stripped = BRACKETS.sub(bracket, text)
        if stripped == text:
            break
        text = stripped
    head, *tail = FEAT_RE.split(text, 1)
    if tail:  # "Title feat. X - Remix"
        featured, *rest = DASH.split(tail[0], 1)
        feats.extend(split_artists(featured))
        text = head + (" - " + rest[0] if rest else "")
    parts = DASH.split(text)
    if len(parts) >= 2 and (VERSION_RE.search(parts[-1]) or ORIGINAL_RE.match(parts[-1])):  # "Title - X Remix"
        versions.append(version_text(parts.pop()))
    text = " - ".join(parts)
    unnumbered = LEAD_NUM.sub("", text)
    if re.search(r"[A-Za-zͰ-Ͽ]", unnumbered):
        text = unnumbered
    return {"segments": [p.strip() for p in DASH.split(text) if p.strip()], "version": " ".join(sorted(set(filter(None, versions)))),
            "feats": feats, "extra": tuple(sorted(set(filter(None, extra))))}


def views(record):
    """Every reading of one record as (basis, artists, title base, version, other brackets)."""
    parsed = parse_title(record["title"])
    segments, feats = parsed["segments"], parsed["feats"]
    tail = (parsed["version"], parsed["extra"])
    field_artists = split_artists(record["artist"])
    whole = norm(" ".join(segments))
    found = []
    if whole:
        found.append(("field", frozenset(field_artists + feats), whole, *tail))
    if len(segments) >= 2:  # "Artist - Title", and the same title under the tagged artist
        rest = norm(" ".join(segments[1:]))
        found.append(("title_prefix", frozenset(split_artists(segments[0]) + feats), rest, *tail))
        found.append(("title_prefix_field", frozenset(field_artists + feats), rest, *tail))
    if len(segments) >= 3:  # "Label - Artist - Title"
        found.append(("label_prefix", frozenset(split_artists(segments[1]) + feats), norm(" ".join(segments[2:])), *tail))
    if record["service"] == "local" and record.get("file_name"):
        named = parse_title(record["file_name"])
        parts, named_tail = named["segments"], (named["version"], named["extra"])
        if len(parts) >= 2:
            found.append(("file_prefix", frozenset(split_artists(parts[0]) + named["feats"]), norm(" ".join(parts[1:])), *named_tail))
        if parts:
            found.append(("file_field", frozenset(field_artists + named["feats"]), norm(parts[-1]), *named_tail))
    if record["service"] == "soundcloud" and whole:
        for other in (record.get("sc_pub_artist"), record.get("uploader")):
            artists = split_artists(other or "")
            if artists:
                found.append(("sc_alt_artist", frozenset(artists + feats), whole, *tail))
                if len(segments) >= 2:
                    found.append(("sc_alt_artist_prefix", frozenset(artists + feats), norm(" ".join(segments[1:])), *tail))
    seen, result = set(), []
    for view in found:
        if view[2] and view[1:] not in seen:
            seen.add(view[1:])
            result.append(view)
    return result


def _bag(*texts):
    words = set()
    for text in texts:
        parsed = parse_title(text)
        words |= set(norm(" ".join(parsed["segments"])).split()) | set(parsed["version"].split())
        words |= {word for name in parsed["feats"] for word in name.split()}
    return frozenset(words - BAG_STOP)


def bags(record):
    """Order-free word sets of a record as {(words, holds the artist's words)}; three words or more."""
    artists = split_artists(record["artist"])
    title = _bag(record["title"])
    found = {(title | (frozenset(word for name in artists for word in name.split()) - BAG_STOP), bool(artists)), (title, False)}
    if record["service"] == "local" and record.get("file_name"):
        found |= {(_bag(" ".join(artists), record["file_name"]), bool(artists)), (_bag(record["file_name"]), False)}
    return {(words, has_artist) for words, has_artist in found if len(words) >= 3}


def version_marks(record):
    """What tells versions of a song apart, per reading of a record (its title; a local file's name too): the
    version words anywhere in the text ('Original Mix' is none), the other words of its version text (a remixer,
    a year) and the words of its other brackets ('Chapter One')."""
    found = []
    for text in (record["title"], record.get("file_name") if record["service"] == "local" else None):
        if (text or "").strip():
            parsed = parse_title(text)
            words = frozenset(VERSION_RE.findall(re.sub(r"\boriginal (?:mix|version|edit)\b", " ", _spell(norm(EXT.sub("", text))))))
            found.append((words, frozenset(parsed["version"].split()) - words,
                          frozenset(word for bracket in parsed["extra"] for word in bracket.split())))
    return found or [(frozenset(), frozenset(), frozenset())]


def same_version(a, b):
    """Two records' version_marks agree in some reading: the same version words, no clash between the names in
    the version text, and no bracket text on one side that contradicts the other's."""
    return any(words == other_words and (not names or not other_names or names & other_names)
               and (extra <= other_extra or other_extra <= extra)
               for words, names, extra in a for other_words, other_names, other_extra in b)


def supported(local, remote):
    """A title-only match is supported when the remote artist is named on the local side, or the albums agree."""
    hay = " " + "   ".join(norm(local.get(k) or "") for k in ("file_name", "album", "title", "artist")) + " "
    local_words = set(norm(local["artist"]).split())
    for name in split_artists(remote["artist"]) + split_artists(remote.get("uploader") or ""):
        if len(name) >= 4 and f" {name} " in hay:
            return True
        if any(len(word) >= 6 and word in local_words for word in name.split()):
            return True
    remote_album = norm(remote.get("album") or "")
    local_album = norm(re.sub(r"^\s*(v\s*/?\.?\s*a\.?|va)\b[\s\-:]*", "", local.get("album") or "", flags=re.I))
    return bool(remote_album and local_album and len(remote_album) >= 6 and local_album != "unknown album"
                and (remote_album in local_album or local_album in remote_album))


def fold_keys(record):
    """Per fold rule, the keys under which two remote records with the same key and length are one recording.
    The text keys ignore a bracket that is not a version word, as measured."""
    field = (norm(record["artist"]), norm(record["title"]))
    readings = views(record)
    return {
        "isrc_duration": [record["isrc"]] if record.get("isrc") else [],
        "text_exact": [field] if all(field) and field[0] not in WEAK_ARTISTS else [],
        "text_clean": sorted({(artist, v[2], v[3]) for v in readings if v[0] == "field" for artist in v[1]}),
        "artist_in_title": sorted({(artist, v[2], v[3]) for v in readings for artist in v[1]}),
    }


def _words(text):
    return {word for word in norm(text).split() if word not in FUZZY_STOP and len(word) >= 2}


def _ratio(a, b):
    matcher = SequenceMatcher(None, a, b, autojunk=False)
    return 0.0 if matcher.real_quick_ratio() < .6 or matcher.quick_ratio() < .6 else matcher.ratio()


class RemoteIndex:
    """Remote records indexed for the link rules."""

    def __init__(self, remotes):
        self.records = {r["id"]: r for r in remotes}
        self.raw, self.field, self.base, self.bag = (defaultdict(list) for _ in range(4))
        self.fuzzy_rows = []
        for r in remotes:
            readings = views(r)
            raw = ((r["artist"] or "").strip().casefold(), (r["title"] or "").strip().casefold())
            if all(raw):
                self.raw[raw].append(r["id"])
            field = (norm(r["artist"]), norm(r["title"]))
            if all(field):
                self.field[field].append(r["id"])
            for view in readings:
                self.base[view[2]].append((r["id"], view))
            for words, has_artist in bags(r):
                self.bag[words].append((r["id"], has_artist))
            if r["dur"]:
                uploader = _words(r.get("uploader") or "")
                self.fuzzy_rows.append((r["dur"], r["id"], sorted({v[2] for v in readings}),
                                        _words(r["artist"]) | _words(r["title"]) | uploader,
                                        {word for v in readings for name in v[1] for word in name.split()} | uploader))
        self.fuzzy_rows.sort(key=lambda row: row[:2])
        self.durations = [row[0] for row in self.fuzzy_rows]

    def pairs(self, local):
        """{remote id: (rule, what matched)} with the tightest rule per remote record. Rules outside LINK_RULES
        ('title_only', 'version') are matches that must not link on their own."""
        best = {}

        def put(rid, rule, basis):
            if rid not in best or RANK[rule] < RANK[best[rid][0]]:
                best[rid] = (rule, basis)

        def title_only(rid, basis):
            if weak_local:
                put(rid, "title_unknown_artist", basis)
            else:
                put(rid, "title_supported" if supported(local, self.records[rid]) else "title_only", basis)

        weak_local = not split_artists(local["artist"])
        if norm(local["artist"]) not in WEAK_ARTISTS:
            for rid in self.raw.get(((local["artist"] or "").strip().casefold(), (local["title"] or "").strip().casefold()), ()):
                put(rid, "text_exact", "same text")
            for rid in self.field.get((norm(local["artist"]), norm(local["title"])), ()):
                put(rid, "text_exact", "same text after folding")
        for mine in views(local):
            for rid, theirs in self.base.get(mine[2], ()):
                shared = mine[1] & theirs[1]
                basis = f"{mine[0]}~{theirs[0]}"
                both_fields = mine[0] == theirs[0] == "field"
                if mine[3] != theirs[3]:
                    if shared:
                        put(rid, "version", f"{basis} [{mine[3]}] vs [{theirs[3]}]")
                elif both_fields and mine[1] and mine[1] == theirs[1] and mine[4] == theirs[4]:
                    put(rid, "text_clean", basis)
                elif both_fields and shared:
                    put(rid, "artist_variant", basis)
                elif shared:
                    put(rid, "artist_in_title", basis)
                elif weak_local and mine[0] in ("field", "file_field"):
                    put(rid, "title_unknown_artist", basis)
                elif mine[1] and theirs[1] and mine[0] == "field" and theirs[0] in ("field", "title_prefix"):
                    title_only(rid, basis)
        for words, has_artist in bags(local):
            for rid, remote_has_artist in self.bag.get(words, ()):
                # The same words count as artist evidence only when one side's word set holds its artist.
                if has_artist or remote_has_artist:
                    put(rid, "same_words", "words")
                else:
                    title_only(rid, "title words")
        return best

    def fuzzy(self, local, window=3.0):
        """The closest similar title within `window` seconds, as (remote id, delta, has artist evidence and a near
        or contained title), or None. A lead for manual review, never a link."""
        if not local["dur"]:
            return None
        readings = views(local)
        bases = sorted({v[2] for v in readings})
        artist_words = {word for v in readings for name in v[1] for word in name.split() if len(word) >= 3}
        words = _words(local["artist"]) | _words(local["title"]) | _words(EXT.sub("", local.get("file_name") or ""))
        best = None
        lo = bisect.bisect_left(self.durations, local["dur"] - window)
        hi = bisect.bisect_right(self.durations, local["dur"] + window)
        for dur, rid, their_bases, their_words, their_artist_words in self.fuzzy_rows[lo:hi]:
            if not words & their_words:
                continue
            similarity = max((_ratio(a, b) for a in bases for b in their_bases), default=0.0)
            contained = 0.0
            for a in bases:
                for b in their_bases:
                    ta, tb = set(a.split()), set(b.split())
                    if ta and tb:
                        short = min(len(ta), len(tb))
                        contained = max(contained, len(ta & tb) / short if short >= 2 else float(ta == tb))
            artist = bool(artist_words & (their_artist_words | their_words))
            key = ((similarity >= .9) + (similarity >= .75) + (contained >= 1.0) + artist, similarity, -abs(local["dur"] - dur))
            if best is None or key > best[0]:
                best = (key, rid, abs(local["dur"] - dur), artist and (similarity >= .75 or contained >= 1.0))
        return best and best[1:]
