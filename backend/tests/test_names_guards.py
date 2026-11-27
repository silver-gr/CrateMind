"""«Καθαρισμός ονομάτων» stage 1 guards: no I/O in the engine, metadata_reader.py byte-identical, nothing in the app
imports the engine yet, determinism, idempotence, the library-wide invariants and the golden corpus."""
from __future__ import annotations

import ast
import hashlib
import json
import re
from pathlib import Path

from app.services import names
from app.services.names import RULESET, Link, References, TrackInput, resolve
from app.services.names.text import fold_words

PACKAGE = Path(names.__file__).resolve().parent
APP = PACKAGE.parents[1]
GOLDEN = Path(__file__).with_name("names_golden.json")
FORBIDDEN = {"open", "Path", "PurePath", "PurePosixPath", "os", "sqlite3", "mutagen", "metadata_reader", "tag_writer",
             "pathlib", "io", "subprocess", "socket", "urllib", "requests", "httpx", "time", "datetime", "random"}


def test_the_engine_does_no_io():
    offenders = []
    for path in sorted(PACKAGE.glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            names_used = []
            if isinstance(node, ast.Name):
                names_used.append(node.id)
            elif isinstance(node, ast.Attribute):
                names_used.append(node.attr)
            elif isinstance(node, ast.Import):
                names_used += [a.name.split(".")[0] for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                names_used += [(node.module or "").split(".")[-1]] + [a.name for a in node.names]
            offenders += [f"{path.name}:{getattr(node, 'lineno', 0)} {n}" for n in names_used if n in FORBIDDEN]
    assert offenders == []


def test_metadata_reader_is_byte_identical_to_the_base():
    data = (APP / "services" / "metadata_reader.py").read_bytes()
    assert hashlib.sha256(data).hexdigest() == "c254a342117ed34732a00cbf4d52690e85584e763a1197a773cfe4a8c331df84"


def test_nothing_in_the_app_imports_names():
    users = []
    for p in APP.rglob("*.py"):
        if PACKAGE in p.parents:
            continue
        text = p.read_text(encoding="utf-8")
        if re.search(r"services\.names\b|from \.names\b|from \.\.names\b|import names\b", text):
            users.append(p.relative_to(APP).as_posix())
    assert users == []


# ---------------------------------------------------------------- a corpus of invented names, one per rule shape
CORPUS = [
    TrackInput(1, "Last Light Fades (Zarvo & Mintrel Remix)", "245", bpm_grid=245.0),
    TrackInput(2, "Zarvo", "Tide"), TrackInput(3, "Mintrel", "Floor"),
    TrackInput(4, "[Prog] Kelvaro", "Arc (Original Mix)"), TrackInput(5, "Kelvaro", "Bow [190bpm]"),
    TrackInput(6, "Durovan(Pexlo & Marumba)", "Aho"), TrackInput(7, "GLASSY TIDES (Orvek vs Spirol)", "X"),
    TrackInput(8, "Glassy Tides", "Shore"), TrackInput(9, " [Hitech Psytrance] Mimo Vex Remix 200 Bpm ▱ Eurythma",
                                                       "Slowly Drifting .·๑"),
    TrackInput(10, "[HiTech Darkpsy Psytrance] MimoVex", "Slowly Drifting Rmx 200 Bpm - Eurythma"),
    TrackInput(11, "Mimo Vex", "Other"), TrackInput(12, "Smoke Three Pipes", "Cojo vs Sifu"),
    TrackInput(13, "Cojo", "A"), TrackInput(14, "Sifu", "B"), TrackInput(15, "15", "Sadhu X - Elemental [198]"),
    TrackInput(16, "10 Ajjo & Nirmo", "Daze"), TrackInput(17, "Ajjo", "Solo"),
    TrackInput(18, "Nobra & Dyvel", "S3", "Tidal EP", folder="Nobra & Dyvel/Tidal EP"),
    TrackInput(19, "Nobra & Dyvel", "Eternity", "Tidal EP", folder="Nobra & Dyvel/Tidal EP"),
    TrackInput(20, "Nobra", "Solo"), TrackInput(21, "COSMA VS GOTALO", "Danc 190 FREE DOWNLOAD !!!"),
    TrackInput(22, "Cosma", "B"), TrackInput(23, "Gotalo", "C"), TrackInput(24, "Rajju Bobo 🔱", "A"),
    TrackInput(25, "PeePace (ॐ)", "B"), TrackInput(26, "Liquid Sol", "& Alkimyst - Tranceform"),
    TrackInput(27, "Velkro", "Velkro - Own Head"), TrackInput(28, "Velkro", "7 Skies", bpm_grid=145.0),
    TrackInput(29, "", "Lonely Title", folder="Unknown Artist/Unknown Album"),
    TrackInput(30, "Gravo (DE), Opax", "Electric (Freedownload)"),
    TrackInput(31, "Velkro", "Rise", links=(Link("spotify", ("Velkro", "Orbalo"), "Rise"),)),
    TrackInput(32, "", "Song Of Night", links=(Link("soundcloud", ("Kelvaro",), "Song Of Night", "Label Uploads"),)),
    TrackInput(33, "Kaltu (Pexlo & Grey Murmur)", "X"), TrackInput(34, "Kaltu", "Y"),
    TrackInput(35, "4. Darqo", "Vah Ruta 160 BPM"), TrackInput(36, "Shanti Folk", "Hanu (Tech Hitch Remix)"),
    TrackInput(37, "O - Zona", "Silent"), TrackInput(38, "In The Dark (Simox Remix", "Lincoln Parx)- FREE DOWNLOAD"),
]
REFS = References(spotify=(("Lincoln Parx", 2), ("Orbalo", 1)))


def _out(res):
    return {str(i): [r.artist, r.title, r.folder, r.status, r.open_code, r.tempo_hint,
                     {k: v for k, v in sorted(r.notes.items())}, list(r.rules)] for i, r in sorted(res.tracks.items())}


def test_determinism():
    assert _out(resolve(CORPUS, REFS)) == _out(resolve(list(reversed(CORPUS)), REFS))


def test_idempotence_no_field_emptied_no_new_words():
    first = resolve(CORPUS, REFS)
    again = resolve([TrackInput(t.id, first.tracks[t.id].artist if first.tracks[t.id].status != "none" else "",
                                first.tracks[t.id].title, t.album, t.track_no, t.file_name, t.folder, t.bpm_grid,
                                t.bpm_analyzed, t.links) for t in CORPUS], REFS)
    for t in CORPUS:
        a, b = first.tracks[t.id], again.tracks[t.id]
        assert (a.artist, a.title) == (b.artist, b.title), t.id
        assert a.title.strip() and a.artist.strip()
        source = re.sub(r"\W", "", fold_words(" ".join([t.artist, t.title, t.album, t.file_name, t.folder] + [
            " ".join(ln.artists) + " " + ln.title + " " + ln.uploader for ln in t.links])))
        for w in re.findall(r"\w+", fold_words(a.artist + " " + a.title)):
            assert w in source or w in ("remix", "feat", "unknown", "artist"), (t.id, w)


def test_golden_corpus_is_pinned_to_the_ruleset():
    golden = json.loads(GOLDEN.read_text(encoding="utf-8"))
    out = json.loads(json.dumps(_out(resolve(CORPUS, REFS)), ensure_ascii=False))
    if golden["ruleset"] == RULESET:
        assert out == golden["outputs"], "an output changed without a RULESET bump"
