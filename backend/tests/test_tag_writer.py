"""The tag writer (stage 1a). Every file here is built by hand in tmp_path, frame by frame, the way the library's
files are (text frames with a trailing NUL, frames out of mutagen's order, other apps' frames), so a writer that
re-serialises a tag cannot pass. No real audio file is ever opened."""
from __future__ import annotations

import dataclasses
import hashlib
import json
import os
from pathlib import Path

import pytest
from mutagen.id3 import ID3
from sqlalchemy import text as sql
from sqlmodel import select

from app.models import AuditLog, TagWrite, Track
from app.services import hashing, scanner, tag_writer
from app.services.tag_writer import Refused, WriteFailed

AUDIO = b"".join(b"\xff\xfb\x90\x00" + bytes((i * 7 + j) % 251 for j in range(413)) for i in range(40))
NEW = {"title": "Shivastra", "artist": "Hurakaniki", "genre": "Hi-Tech"}
TICKED = ("TIT2", "TPE1", "TCON")


def _syncsafe(n: int) -> bytes:
    return bytes((n >> 21 & 127, n >> 14 & 127, n >> 7 & 127, n & 127))


def frame(frame_id: str, body: bytes, version: int = 3, flags: bytes = b"\0\0") -> bytes:
    size = len(body).to_bytes(4, "big") if version == 3 else _syncsafe(len(body))
    return frame_id.encode() + size + flags + body


def text(frame_id: str, value: str, version: int = 3, nul: bool = True) -> bytes:
    return frame(frame_id, b"\x00" + value.encode("latin-1") + (b"\x00" if nul else b""), version)


def library_frames(version: int = 3, *, genre: str | None = "hitech", comment: bool = True,
                   artwork: int = 700) -> list[bytes]:
    """Frames as Serato, Traktor and old taggers leave them, artwork first."""
    frames = [
        frame("APIC", b"\x00image/jpeg\x00\x03\x00\xff\xd8\xff\xe0" + bytes(i % 256 for i in range(artwork)), version),
        frame("GEOB", b"\x00application/octet-stream\x00\x00Serato Overview\x00\x01\x05" + bytes(range(200)), version),
        text("TIT2", "Shivastra (183)", version),
        frame("PRIV", b"TRAKTOR4\x00DMRT" + bytes(range(64)), version),
        text("TPE1", "4. Hurakaniki", version),
        frame("TXXX", b"\x00Serato Import ID\x001763489012\x00", version),
        frame("RVA2", b"SeratoGain\x00\x01\x00\x00\x00", version),
        text("TSOP", "Hurakaniki", version),
        text("TSOT", "Shivastra", version),
        text("TALB", "Some Album", version),
        frame("TBPM", b"\x00183.000000\x00", version),
    ]
    if comment:
        frames.insert(5, frame("COMM", b"\x00eng\x00a v2 comment\x00", version))
    if genre:
        frames.insert(7, text("TCON", genre, version))
    return frames


def block(frames: list[bytes], version: int = 3, padding: int = 1024, flags: int = 0) -> bytes:
    body = b"".join(frames) + bytes(padding)
    return b"ID3" + bytes((version, 0, flags)) + _syncsafe(len(body)) + body


def v1(title: bytes = b"Shivastra (183)", artist: bytes = b"4. Hurakaniki", genre: int = 12) -> bytes:
    """An ID3v1 block whose album and comment are not what ID3v2 holds."""
    return (b"TAG" + title.ljust(30, b"\0") + artist.ljust(30, b"\0") + b"Only in v1".ljust(30, b"\0") + b"2019"
            + b"v1 comment".ljust(28, b"\0") + b"\0\x07" + bytes((genre,)))


def make(path: Path, frames: list[bytes] | None = None, version: int = 3, padding: int = 1024,
         trailer: bytes | None = None, flags: int = 0) -> bytes:
    data = (block(library_frames(version) if frames is None else frames, version, padding, flags) + AUDIO
            + (v1() if trailer is None else trailer))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return data


def frames_of(data: bytes) -> list[tuple[str, bytes]]:
    """The test's own walk of an ID3v2 block, independent of the writer's."""
    version, length = data[3], data[6] << 21 | data[7] << 14 | data[8] << 7 | data[9]
    body, found, pos = data[10:10 + length], [], 0
    while pos + 10 <= len(body) and body[pos]:
        raw = body[pos + 4:pos + 8]
        size = int.from_bytes(raw, "big") if version == 3 else raw[0] << 21 | raw[1] << 14 | raw[2] << 7 | raw[3]
        found.append((body[pos:pos + 4].decode(), body[pos:pos + 10 + size]))
        pos += 10 + size
    assert not body[pos:].strip(b"\0")
    return found


def block_length(data: bytes) -> int:
    return 10 + (data[6] << 21 | data[7] << 14 | data[8] << 7 | data[9])


def audio_of(data: bytes) -> bytes:
    end = len(data) - 128 if data[-128:-125] == b"TAG" else len(data)
    return data[block_length(data):end]


def replace_frame(data: bytes, frame_id: str, raw: bytes) -> bytes:
    """What another app does: one frame rewritten in place, same length, everything else as it was."""
    (old,) = [r for i, r in frames_of(data) if i == frame_id]
    assert len(raw) == len(old)
    return data.replace(old, raw, 1)


def stamp(path: Path) -> tuple[bytes, int]:
    return path.read_bytes(), path.stat().st_mtime_ns


def rows(db) -> list[TagWrite]:
    return list(db.exec(select(TagWrite).order_by(TagWrite.id)).all())


def log_lines(tmp_path: Path) -> list[dict]:
    log = tmp_path / "tag-writes.jsonl"
    return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []


@pytest.fixture(autouse=True)
def no_dj_apps(monkeypatch):
    """The process check is real in the app; a test must not depend on what runs on this Mac."""
    monkeypatch.setattr(tag_writer, "running_dj_apps", list)


@pytest.fixture
def lib(tmp_path) -> Path:
    folder = tmp_path / "lib"
    folder.mkdir()
    return folder


def scanned(db, lib: Path, path: Path) -> Track:
    scanner.scan(db, [lib])
    return db.exec(select(Track).where(Track.file_name == path.name)).one()


# ---- a write, and proof that nothing else changed ----

@pytest.mark.parametrize("version", [3, 4])
def test_write_changes_the_three_frames_and_nothing_else(db, lib, tmp_path, version):
    path = lib / "Hurakaniki - Shivastra.mp3"
    original = make(path, version=version)
    track = scanned(db, lib, path)
    old_quick, old_mtime = track.quick_hash, path.stat().st_mtime_ns

    plan = tag_writer.plan_write(path, NEW)
    assert stamp(path) == (original, old_mtime)  # the dry run wrote nothing
    assert plan.fields["title"] == {"before": "Shivastra (183)", "after": "Shivastra"}
    row = tag_writer.write(db, plan, batch_id="b1", track_id=track.id)
    written = path.read_bytes()

    # A write happened: bytes, time, the values as another reader sees them, and the catalog.
    assert hashlib.sha256(written).digest() != hashlib.sha256(original).digest()
    assert path.stat().st_mtime_ns != old_mtime
    tags = ID3(path, translate=False, load_v1=False)
    assert tags.version[1] == version
    assert [tags[i].text for i in TICKED] == [["Shivastra"], ["Hurakaniki"], ["Hi-Tech"]]
    db.refresh(track)
    assert track.quick_hash == hashing.quick_hash(path) != old_quick
    assert (track.title, track.artist, track.genre) == ("Shivastra", "Hurakaniki", "Hi-Tech")
    assert (track.file_size, track.modified_time) == (len(written), path.stat().st_mtime)

    # Nothing else did: size, audio, every other frame byte for byte and in order, ID3v1 outside its three fields.
    assert len(written) == len(original) and written[:10] == original[:10]
    assert audio_of(written) == audio_of(original) == AUDIO
    before, after = frames_of(original), frames_of(written)
    assert [i for i, _ in after] == [i for i, _ in before]
    assert [f for f in after if f[0] not in TICKED] == [f for f in before if f[0] not in TICKED]
    old_v1, new_v1 = original[-128:], written[-128:]
    assert new_v1[:3] + new_v1[63:127] == old_v1[:3] + old_v1[63:127]
    assert new_v1[3:33] == b"Shivastra".ljust(30, b"\0") and new_v1[33:63] == b"Hurakaniki".ljust(30, b"\0")
    assert new_v1[127] == 255  # "Hi-Tech" is not an ID3v1 genre

    assert (row.state, row.error, row.track_id, row.size) == ("done", None, track.id, len(original))
    assert row.quick_hash_before == old_quick and row.quick_hash_after == track.quick_hash
    assert row.audio_sha256 == hashlib.sha256(AUDIO).hexdigest()
    assert row.block_sha256_after == hashlib.sha256(written[:block_length(written)]).hexdigest()
    assert not (tmp_path / "tag-writes-pending" / f"{row.id}.bin").exists()
    assert [line["event"] for line in log_lines(tmp_path)] == ["write", "done"]


@pytest.mark.parametrize("version", [3, 4])
def test_undo_gives_back_the_original_file_byte_for_byte(db, lib, version):
    path = lib / "Hurakaniki - Shivastra.mp3"
    original = make(path, version=version)
    track = scanned(db, lib, path)
    old_quick = track.quick_hash
    row = tag_writer.write(db, tag_writer.plan_write(path, NEW), batch_id="b1", track_id=track.id)
    assert path.read_bytes() != original

    result = tag_writer.undo(db, row.id)

    assert path.read_bytes() == original
    assert (result["exact"], result["restored"], result["left_alone"]) == (True, ["title", "artist", "genre"], [])
    db.refresh(row)
    db.refresh(track)
    assert row.undone_at is not None
    assert (result["row"].state, result["row"].undo_of) == ("done", row.id)
    assert track.quick_hash == old_quick == hashing.quick_hash(path)
    assert track.genre == "hitech"


def test_filling_an_empty_genre_adds_one_frame_and_undo_removes_it(db, tmp_path):
    path = tmp_path / "track.mp3"
    original = make(path, library_frames(genre=None))
    row = tag_writer.write(db, tag_writer.plan_write(path, {"genre": "Forest"}), batch_id="b1")

    written = path.read_bytes()
    assert frames_of(written) == [*frames_of(original), ("TCON", b"TCON\0\0\0\x07\0\0\0Forest")]
    assert written[-128:-1] == original[-128:-1] and written[-1] == 255
    assert json.loads(row.fields_json) == {"genre": {"before": None, "after": "Forest"}}

    assert tag_writer.undo(db, row.id)["exact"] is True
    assert path.read_bytes() == original


def test_a_file_without_an_id3v1_block_does_not_gain_one(db, tmp_path):
    path = tmp_path / "track.mp3"
    original = make(path, trailer=b"")
    plan = tag_writer.plan_write(path, NEW)
    assert plan.pieces["title"]["v1_old"] is None and plan.pieces["title"]["v1_new"] is None
    row = tag_writer.write(db, plan, batch_id="b1")

    written = path.read_bytes()
    assert len(written) == len(original) and written[block_length(written):] == AUDIO
    assert row.v1_sha256_before is None and row.v1_sha256_after is None
    tag_writer.undo(db, row.id)
    assert path.read_bytes() == original


def test_v2_gains_no_comment_frame_from_the_id3v1_comment(db, tmp_path):
    path = tmp_path / "track.mp3"
    original = make(path, library_frames(comment=False))
    tag_writer.write(db, tag_writer.plan_write(path, NEW), batch_id="b1")
    assert [i for i, _ in frames_of(path.read_bytes())] == [i for i, _ in frames_of(original)]
    assert "COMM" not in [i for i, _ in frames_of(path.read_bytes())]


def test_text_outside_latin1_is_written_as_utf16_and_leaves_the_id3v1_title(db, tmp_path):
    path = tmp_path / "track.mp3"
    original = make(path)
    row = tag_writer.write(db, tag_writer.plan_write(path, {"title": "Ψυχεδέλεια"}), batch_id="b1")

    written = path.read_bytes()
    (title,) = [raw for i, raw in frames_of(written) if i == "TIT2"]
    assert title[10:] == b"\x01\xff\xfe" + "Ψυχεδέλεια".encode("utf-16-le")
    assert ID3(path, translate=False, load_v1=False)["TIT2"].text == ["Ψυχεδέλεια"]
    assert written[-128:] == original[-128:]  # ID3v1 cannot hold Greek: left as it was, no question marks
    tag_writer.undo(db, row.id)
    assert path.read_bytes() == original


@pytest.mark.parametrize(("genre", "number"), [("Trance", 31), ("Psytrance", 177), ("Goa Trance", 255)])
def test_the_id3v1_genre_number_follows_the_written_genre(db, tmp_path, genre, number):
    path = tmp_path / "track.mp3"
    make(path)
    tag_writer.write(db, tag_writer.plan_write(path, {"genre": genre}), batch_id="b1")
    assert path.read_bytes()[-1] == number  # mutagen's table, the one its own ID3v1 writer uses; 255 = none


def test_a_field_the_file_already_holds_is_left_out(db, tmp_path):
    path = tmp_path / "track.mp3"
    make(path)
    plan = tag_writer.plan_write(path, {"title": "Shivastra (183)", "artist": "Hurakaniki"})
    assert list(plan.values) == ["artist"] and list(plan.pieces) == ["artist"]
    before = stamp(path)
    with pytest.raises(Refused) as refused:
        tag_writer.plan_write(path, {"title": "Shivastra (183)", "genre": "hitech"})
    assert refused.value.reason == "same" and stamp(path) == before


def test_a_block_with_no_padding_takes_a_frame_of_the_same_size(db, tmp_path):
    path = tmp_path / "track.mp3"
    original = make(path, [text("TIT2", "Transitionz", nul=False), text("TPE1", "Someone")], padding=0)
    row = tag_writer.write(db, tag_writer.plan_write(path, {"title": "Transitions"}), batch_id="b1")
    assert frames_of(path.read_bytes())[0] == ("TIT2", b"TIT2\0\0\0\x0c\0\0\0Transitions")
    assert len(path.read_bytes()) == len(original)
    tag_writer.undo(db, row.id)
    assert path.read_bytes() == original


# ---- refusals: the file and its modification time stay as they were, and nothing is logged ----

def refused(db, tmp_path, path: Path, values: dict, reason: str) -> Refused:
    before = stamp(path) if path.is_file() else None
    with pytest.raises(Refused) as caught:
        tag_writer.write(db, tag_writer.plan_write(path, values), batch_id="b1")
    assert caught.value.reason == reason
    assert (stamp(path) if path.is_file() else None) == before
    assert rows(db) == [] and log_lines(tmp_path) == []
    assert not (tmp_path / "tag-writes-pending").exists()
    return caught.value


def test_no_room_in_the_block_is_refused(db, tmp_path):
    path = tmp_path / "track.mp3"
    make(path, padding=0)
    refused(db, tmp_path, path, {"title": "A title longer than the one in the file"}, "no_room")
    make(path, padding=5)  # the new genre frame needs 18 bytes
    refused(db, tmp_path, path, {"genre": "Full-On Morning"}, "no_room")


def test_a_file_with_no_tag_at_all_is_refused(db, tmp_path):
    path = tmp_path / "track.mp3"
    path.write_bytes(AUDIO + v1())
    refused(db, tmp_path, path, NEW, "no_tag")
    path.write_bytes(AUDIO)
    refused(db, tmp_path, path, NEW, "no_tag")


@pytest.mark.parametrize("case", ["unsynchronisation", "extended header", "footer", "frame flag",
                                  "no zero padding", "plain sizes in v2.4", "v2.4 sizes that read two ways",
                                  "two title frames", "v2.2", "block longer than the file"])
def test_a_tag_the_walk_does_not_fully_understand_is_refused(db, tmp_path, case):
    path = tmp_path / "track.mp3"
    frames = library_frames()
    if case == "unsynchronisation":
        make(path, flags=0x80)
    elif case == "extended header":
        make(path, [b"\0\0\0\x06\0\0\0\0\0\0", *frames], flags=0x40)
    elif case == "footer":
        data = block(library_frames(4), 4, flags=0x10)
        path.write_bytes(data + b"3DI" + data[3:10] + AUDIO + v1())
    elif case == "frame flag":
        make(path, [*frames, frame("TPUB", b"\x00Label\x00", flags=b"\x40\x00")])
    elif case == "no zero padding":
        make(path, [*frames, bytes(16) + b"left over" + bytes(16)])
    elif case == "plain sizes in v2.4":
        make(path, frames, version=4)  # frames with v2.3 sizes under a v2.4 header, as old iTunes wrote
    elif case == "v2.4 sizes that read two ways":
        # The last frame is large and the padding is long: read as a plain number its size ends inside the
        # padding, so where the frame stops cannot be told.
        make(path, [text("TIT2", "Shivastra (183)", 4), frame("APIC", b"\x00image/jpeg\x00\x03\x00" + bytes(700), 4)],
             version=4)
    elif case == "two title frames":
        make(path, [*frames, text("TIT2", "Another title")])
    elif case == "v2.2":
        path.write_bytes(b"ID3\x02\x00\x00" + _syncsafe(32) + b"TT2\0\0\x06\0Title" + bytes(20) + AUDIO)
    else:
        path.write_bytes(block(frames)[:-200])
    refused(db, tmp_path, path, NEW, "unsupported_tag")


def test_only_mp3_is_written(db, tmp_path):
    for name in ("track.m4a", "track.wav", "track.flac", "track"):
        make(tmp_path / name)
        refused(db, tmp_path, tmp_path / name, NEW, "not_mp3")
    path = tmp_path / "renamed.mp3"  # a tag in front of something that is not MPEG audio
    for payload in (b"fLaC" + bytes(4096), bytes((i * 37 + 11) % 256 for i in range(20000)), b""):
        path.write_bytes(block(library_frames()) + payload)
        refused(db, tmp_path, path, NEW, "not_mp3")


def test_refused_where_the_system_cannot_write_in_place(db, tmp_path, monkeypatch):
    path = tmp_path / "track.mp3"
    make(path)
    monkeypatch.delattr(os, "pwrite")  # Windows has none
    refused(db, tmp_path, path, NEW, "not_here")


def test_refused_while_a_dj_app_runs(db, tmp_path, monkeypatch):
    path = tmp_path / "track.mp3"
    make(path)
    monkeypatch.setattr(tag_writer, "running_dj_apps", lambda: ["Serato DJ Pro", "djay Pro"])
    assert "Serato DJ Pro, djay Pro" in str(refused(db, tmp_path, path, NEW, "dj_app"))


def test_dj_apps_are_found_in_a_process_list():
    listing = ("/sbin/launchd\n/Applications/djay Pro.app/Contents/MacOS/djay Pro\n"
               "/Applications/Serato DJ Pro.app/Contents/MacOS/Serato DJ Pro\n/usr/bin/python3\n"
               "/Applications/Native Instruments/Traktor Pro 4/Traktor Pro 4.app/Contents/MacOS/Traktor Pro 4\n")
    assert tag_writer.dj_apps_in(listing) == ["Serato DJ Pro", "Traktor Pro 4", "djay Pro"]
    assert tag_writer.dj_apps_in("/sbin/launchd\n/Applications/CrateMind.app/Contents/MacOS/cratemind-native\n") == []


def test_a_missing_or_locked_file_is_refused(db, tmp_path):
    refused(db, tmp_path, tmp_path / "gone.mp3", NEW, "missing")
    (tmp_path / "folder.mp3").mkdir()
    refused(db, tmp_path, tmp_path / "folder.mp3", NEW, "missing")
    path = tmp_path / "track.mp3"
    make(path)
    path.chmod(0o444)
    try:
        refused(db, tmp_path, path, NEW, "read_only")
    finally:
        path.chmod(0o644)


@pytest.mark.parametrize("values", [{}, {"title": ""}, {"title": "   "}, {"title": "a\x00b"}, {"artist": "two\nlines"},
                                    {"album": "Not offered"}, {"title": None}, {"title": "lone \ud800 surrogate"}])
def test_an_empty_or_unwritable_value_is_refused(db, tmp_path, values):
    path = tmp_path / "track.mp3"
    make(path)
    refused(db, tmp_path, path, values, "bad_value")


@pytest.mark.parametrize("values", [{"title": "Horror Disasters 160"}, {"title": "Rebirth of the Sun - Deadhand Remix"},
                                    {"artist": "220 Volt"}, {"genre": "17"}, {"genre": "(17)"}])
def test_a_value_cratemind_or_mutagen_would_read_back_differently_is_refused(db, tmp_path, values):
    path = tmp_path / "track.mp3"
    make(path)
    refused(db, tmp_path, path, values, "reads_back")


# ---- the checks in memory, tested by sabotage: refused before any byte is written ----

def swapped(block_bytes: bytes, first: str, second: str) -> bytes:
    found = dict(frames_of(block_bytes))
    return block_bytes.replace(found[first], b"\1" * len(found[first]), 1).replace(found[second], found[first], 1) \
        .replace(b"\1" * len(found[first]), found[second], 1)


@pytest.mark.parametrize("sabotage", ["reorders", "re-encodes", "drops", "grows the block", "moves a written frame"])
def test_a_builder_that_touches_another_frame_is_refused_before_writing(db, tmp_path, monkeypatch, sabotage):
    path = tmp_path / "track.mp3"
    make(path)
    real = tag_writer._splice

    def bad(old, frames, changes):
        built = real(old, frames, changes)
        if sabotage == "reorders":
            return swapped(built, "TSOP", "TSOT")
        if sabotage == "moves a written frame":  # the new title after the last frame instead of in its place
            found = frames_of(built)
            body = b"".join(raw for frame_id, raw in found if frame_id != "TIT2") + dict(found)["TIT2"]
            return built[:10] + body.ljust(len(built) - 10, b"\0")
        if sabotage == "re-encodes":  # what mutagen's own writer does: the trailing NUL goes
            return built.replace(text("TALB", "Some Album"), text("TALB", "Some Album", nul=False) + b"\0", 1)
        if sabotage == "drops":
            raw = dict(frames_of(built))["PRIV"]
            return built.replace(raw, b"", 1) + bytes(len(raw))
        return built + bytes(16)

    monkeypatch.setattr(tag_writer, "_splice", bad)
    refused(db, tmp_path, path, NEW, "check_failed")


def test_the_check_refuses_an_id3v1_byte_outside_the_written_fields(tmp_path):
    path = tmp_path / "track.mp3"
    make(path)
    plan, file, new_block, new_v1 = tag_writer._prepare(path, {"title": "Shivastra"})
    frames = tag_writer._walk(file.block)
    changes = {"TIT2": plan.pieces["title"]["new"]}
    expect = {"TIT2": tag_writer._expected("TIT2", "Shivastra")}
    tag_writer._check(path, file, frames, new_block, new_v1, changes, {"title"}, expect, plan.values)
    for index in (0, 40, 70, 126, 127):  # the "TAG" mark, the artist, the album, the track number, the genre
        bad = bytearray(new_v1)
        bad[index] ^= 0x01
        with pytest.raises(Refused) as caught:
            tag_writer._check(path, file, frames, new_block, bytes(bad), changes, {"title"}, expect, plan.values)
        assert caught.value.reason == "check_failed"


# ---- the file changed under us ----

def test_a_file_changed_since_the_dry_run_is_refused(db, tmp_path):
    path = tmp_path / "track.mp3"
    original = make(path)
    plan = tag_writer.plan_write(path, NEW)
    old = path.stat()

    os.utime(path, ns=(old.st_atime_ns, old.st_mtime_ns + 1_000_000_000))  # touched, same bytes
    with pytest.raises(Refused) as caught:
        tag_writer.write(db, plan, batch_id="b1")
    assert caught.value.reason == "changed" and path.read_bytes() == original

    # Another app rewrote the artist in place and the size and time happen to match: the old bytes do not.
    foreign = replace_frame(original, "TPE1", text("TPE1", "9. Hurakaniki"))
    path.write_bytes(foreign)
    os.utime(path, ns=(old.st_atime_ns, old.st_mtime_ns))
    with pytest.raises(Refused) as caught:
        tag_writer.write(db, plan, batch_id="b1")
    assert caught.value.reason == "changed" and path.read_bytes() == foreign
    assert rows(db) == []


@pytest.mark.parametrize("same_stamp", [False, True])
def test_a_file_changed_between_the_read_and_the_write_is_left_alone(db, tmp_path, monkeypatch, same_stamp):
    """The last look happens on the descriptor the write will use: size, time, then the bytes themselves."""
    path = tmp_path / "track.mp3"
    original = make(path)
    plan = tag_writer.plan_write(path, NEW)
    foreign = replace_frame(original, "TSOP", text("TSOP", "Hurakanikx"))
    real = tag_writer._log

    def log_then_foreign_write(entry):
        real(entry)
        if entry["event"] == "write":
            old = path.stat()
            with path.open("r+b") as other_app:
                other_app.write(foreign)
            if same_stamp:
                os.utime(path, ns=(old.st_atime_ns, old.st_mtime_ns))

    monkeypatch.setattr(tag_writer, "_log", log_then_foreign_write)
    with pytest.raises(Refused) as caught:
        tag_writer.write(db, plan, batch_id="b1")

    assert caught.value.reason == "changed" and path.read_bytes() == foreign
    (row,) = rows(db)
    assert row.state == "failed" and row.error
    assert not (tmp_path / "tag-writes-pending" / f"{row.id}.bin").exists()
    assert [line["event"] for line in log_lines(tmp_path)] == ["write", "failed"]


# ---- the check after the write, tested by sabotage: the file is put back and the batch stops ----

def flip(data: bytes, index: int) -> bytes:
    return data[:index] + bytes((data[index] ^ 0x01,)) + data[index + 1:]


@pytest.mark.parametrize("leg", ["write fails halfway", "another frame's byte", "id3v1 byte outside the fields",
                                 "audio read back differently", "value read back differently"])
def test_a_failed_check_after_the_write_restores_the_file_and_stops_the_batch(db, tmp_path, monkeypatch, leg):
    first, second = tmp_path / "first.mp3", tmp_path / "second.mp3"
    original, untouched = make(first), make(second)
    second_stamp = stamp(second)
    plans = [(None, tag_writer.plan_write(first, NEW)), (None, tag_writer.plan_write(second, NEW))]
    real_pwrite, real_load, calls = tag_writer._pwrite, tag_writer._load, {"armed": True, "load": 0}
    geob = original.index(b"Serato Overview")

    def pwrite(fd, data, offset):
        hit = calls["armed"] and (offset == 0) == (leg != "id3v1 byte outside the fields")
        if hit:  # once; the restore that follows writes for real
            calls["armed"] = False
        if hit and leg == "write fails halfway":
            real_pwrite(fd, data[:len(data) // 2], offset)
            raise OSError(5, "Input/output error")
        if hit and leg == "another frame's byte":
            data = flip(data, geob)
        if hit and leg == "id3v1 byte outside the fields":
            data = flip(data, 100)
        return real_pwrite(fd, data, offset)

    def load(path):
        calls["load"] += 1
        file = real_load(path)
        if calls["load"] == 2 and leg == "audio read back differently":  # 1: the read, 2: the check after the write
            return dataclasses.replace(file, audio_sha256="0" * 64)
        if calls["load"] == 2 and leg == "value read back differently":
            return dataclasses.replace(file, block=file.block.replace(b"\x00Shivastra", b"\x00Shivastrb", 1))
        return file

    monkeypatch.setattr(tag_writer, "_pwrite", pwrite)
    monkeypatch.setattr(tag_writer, "_load", load)
    result = tag_writer.write_batch(db, plans)

    assert first.read_bytes() == original
    assert stamp(second) == second_stamp and second.read_bytes() == untouched
    assert result["written"] == [] and result["skipped"] == []
    assert result["failed"]["path"] == str(first) and result["failed"]["restored"] is True
    (row,) = rows(db)
    assert row.state == "failed" and "γύρισε όπως ήταν" in row.error
    assert not (tmp_path / "tag-writes-pending" / f"{row.id}.bin").exists()
    assert [line["event"] for line in log_lines(tmp_path)] == ["write", "failed"]


def test_damage_the_writer_cannot_put_back_keeps_the_row_pending(db, tmp_path, monkeypatch):
    """An audio byte that changes during the write was never ours to restore: the tag blocks go back, the row
    stays pending with its saved copy, and the owner is told."""
    path = tmp_path / "track.mp3"
    original = make(path)
    plan = tag_writer.plan_write(path, NEW)
    real, start = tag_writer._pwrite, block_length(original) + 500

    def pwrite(fd, data, offset):
        real(fd, data, offset)
        if offset == 0:
            os.pwrite(fd, bytes((original[start] ^ 0x01,)), start)

    monkeypatch.setattr(tag_writer, "_pwrite", pwrite)
    with pytest.raises(WriteFailed) as failure:
        tag_writer.write(db, plan, batch_id="b1")

    assert failure.value.restored is False and "ο ήχος δεν είναι ίδιος" in str(failure.value)
    assert path.read_bytes() == flip(original, start)
    (row,) = rows(db)
    assert row.state == "pending" and (tmp_path / "tag-writes-pending" / f"{row.id}.bin").exists()


def test_no_restore_when_the_size_changed_during_the_write(db, tmp_path, monkeypatch):
    path = tmp_path / "track.mp3"
    make(path)
    plan = tag_writer.plan_write(path, NEW)
    real = tag_writer._pwrite

    def pwrite(fd, data, offset):
        real(fd, data, offset)
        if offset:
            with path.open("ab") as other_app:
                other_app.write(b"grown by another app")
            raise OSError(5, "Input/output error")

    monkeypatch.setattr(tag_writer, "_pwrite", pwrite)
    with pytest.raises(WriteFailed) as failure:
        tag_writer.write(db, plan, batch_id="b1")
    after = stamp(path)

    assert failure.value.restored is False and "άλλο μέγεθος" in str(failure.value)
    assert after[0].endswith(b"grown by another app") and b"\x00Shivastra" in after[0]  # left as it was found
    (row,) = rows(db)
    assert row.state == "failed" and (tmp_path / "tag-writes-pending" / f"{row.id}.bin").exists()

    # What follows the tag is no longer the audio that was written to, so an undo keeps away as well.
    monkeypatch.setattr(tag_writer, "_pwrite", real)
    with pytest.raises(Refused) as caught:
        tag_writer.undo(db, row.id)
    assert caught.value.reason == "other_file" and stamp(path) == after


# ---- undo after other apps wrote, after a move, and from the log alone ----

def test_undo_restores_only_the_frames_that_are_still_ours(db, tmp_path):
    path = tmp_path / "track.mp3"
    original = make(path)
    row = tag_writer.write(db, tag_writer.plan_write(path, NEW), batch_id="b1")
    foreign_artist = text("TPE1", "Hurakanikx", nul=False)
    path.write_bytes(replace_frame(path.read_bytes(), "TPE1", foreign_artist))

    result = tag_writer.undo(db, row.id)

    assert (result["restored"], result["left_alone"], result["exact"]) == (["title", "artist", "genre"], ["artist"], False)
    after = dict(frames_of(path.read_bytes()))
    before = dict(frames_of(original))
    assert after["TIT2"] == before["TIT2"] and after["TCON"] == before["TCON"]
    assert after["TPE1"] == foreign_artist
    assert path.read_bytes()[-128:] == original[-128:]  # the ID3v1 artist was still ours, so it went back
    assert audio_of(path.read_bytes()) == AUDIO


def test_undo_leaves_artwork_another_app_changed_and_says_not_exact(db, tmp_path):
    path = tmp_path / "track.mp3"
    original = make(path, library_frames(artwork=300 * 1024))
    assert block_length(original) > 256 * 1024  # larger than what quick_hash covers of the head
    row = tag_writer.write(db, tag_writer.plan_write(path, NEW), batch_id="b1")
    art = path.read_bytes().index(b"\xff\xd8\xff\xe0") + 1000
    foreign = flip(path.read_bytes(), art)
    path.write_bytes(foreign)

    result = tag_writer.undo(db, row.id)

    assert (result["restored"], result["left_alone"], result["exact"]) == (["title", "artist", "genre"], [], False)
    assert path.read_bytes() == flip(original, art)  # our three frames back, the new artwork kept


def test_a_scan_after_a_write_finds_the_file_unchanged(db, lib):
    path = lib / "Hurakaniki - Shivastra.mp3"
    make(path)
    track = scanned(db, lib, path)
    tag_writer.write_batch(db, [(track.id, tag_writer.plan_write(path, NEW))])

    for mode in ("delta", "full"):
        stats = scanner.scan(db, [lib], mode=mode)
        assert (stats["unchanged"], stats["updated"], stats["added"], stats["missing"]) == (1, 0, 0, 0)
    assert [t.id for t in db.exec(select(Track)).all()] == [track.id]


def test_a_written_file_that_moves_still_merges_and_undo_follows_the_track(db, lib):
    path = lib / "Hurakaniki - Shivastra.mp3"
    original = make(path)
    track = scanned(db, lib, path)
    row = tag_writer.write(db, tag_writer.plan_write(path, NEW), batch_id="b1", track_id=track.id)
    moved = lib / "Hi-Tech" / path.name
    moved.parent.mkdir()
    path.rename(moved)

    stats = scanner.scan(db, [lib])

    assert stats["merged_moved"] == 1
    (survivor,) = db.exec(select(Track)).all()
    db.refresh(row)
    assert row.track_id == survivor.id and row.path == str(path)  # the row follows the track; its path is history
    assert tag_writer.undo(db, row.id)["exact"] is True
    assert moved.read_bytes() == original and not path.exists()


def test_the_row_outlives_its_track_and_undo_then_uses_the_stored_path(db, lib):
    path = lib / "Hurakaniki - Shivastra.mp3"
    original = make(path)
    track = scanned(db, lib, path)
    row = tag_writer.write(db, tag_writer.plan_write(path, NEW), batch_id="b1", track_id=track.id)
    db.execute(sql("DELETE FROM track_search WHERE rowid = :id"), {"id": track.id})
    db.execute(sql("DELETE FROM tracks WHERE id = :id"), {"id": track.id})
    db.commit()
    db.expire_all()

    assert db.get(TagWrite, row.id).track_id is None
    assert tag_writer.undo(db, row.id)["exact"] is True
    assert path.read_bytes() == original


def test_undo_from_the_log_line_alone(db, tmp_path):
    path = tmp_path / "track.mp3"
    original = make(path)
    tag_writer.write(db, tag_writer.plan_write(path, NEW), batch_id="b1")
    db.execute(sql("DELETE FROM tag_writes"))
    db.commit()
    (entry,) = [line for line in log_lines(tmp_path) if line["event"] == "write"]
    entry["track_id"] = 999  # a track id from a catalog that no longer exists

    # A file that got the same values in another write is not this line's file: its audio differs.
    other = tmp_path / "other.mp3"
    other.write_bytes(path.read_bytes().replace(AUDIO, AUDIO + AUDIO[:417]))
    left = stamp(other)
    with pytest.raises(Refused) as caught:
        tag_writer.undo_logged(db, entry, other)
    assert caught.value.reason == "other_file" and stamp(other) == left

    result = tag_writer.undo_logged(db, entry)

    assert result["exact"] is True and path.read_bytes() == original
    assert result["row"].track_id is None
    assert tag_writer.undo_logged(db, entry)["restored"] == []  # a second undo finds nothing of ours to put back
    assert path.read_bytes() == original


def test_a_batch_skips_refused_files_and_undoes_as_one(db, lib):
    good, touched, other = lib / "A - One.mp3", lib / "B - Two.mp3", lib / "C - Three.mp3"
    originals = [make(good), make(touched), make(other)]
    scanner.scan(db, [lib])
    ids = {t.file_name: t.id for t in db.exec(select(Track)).all()}
    plans = [(ids[p.name], tag_writer.plan_write(p, {"title": title, "artist": p.name[0]}))
             for p, title in ((good, "One"), (touched, "Two"), (other, "Three"))]
    os.utime(touched, ns=(0, touched.stat().st_mtime_ns + 1_000_000_000))  # another app, after the dry run

    result = tag_writer.write_batch(db, plans)

    assert [row.path for row in result["written"]] == [str(good), str(other)]
    assert [(s["path"], s["reason"]) for s in result["skipped"]] == [(str(touched), "changed")]
    assert result["failed"] is None
    assert db.exec(select(AuditLog).where(AuditLog.action == "tag_write")).one().entity_type == "tag_write_batch"
    db.expire_all()
    assert {t.file_name: t.title for t in db.exec(select(Track)).all()} == {
        good.name: "One", touched.name: "Shivastra (183)", other.name: "Three"}

    undone = tag_writer.undo_batch(db, result["batch_id"])

    assert [u["exact"] for u in undone["undone"]] == [True, True] and undone["failed"] is None
    assert [good.read_bytes(), touched.read_bytes(), other.read_bytes()] == originals
    assert tag_writer.undo_batch(db, result["batch_id"])["undone"] == []


def test_a_plan_paired_with_another_tracks_id_is_refused(db, lib, tmp_path):
    first, second = lib / "A - One.mp3", lib / "B - Two.mp3"
    make(first), make(second)
    scanner.scan(db, [lib])
    ids = {t.file_name: t.id for t in db.exec(select(Track)).all()}
    before = [stamp(first), stamp(second)]

    with pytest.raises(Refused) as caught:
        tag_writer.write(db, tag_writer.plan_write(first, NEW), batch_id="b1", track_id=ids[second.name])

    assert caught.value.reason == "wrong_track"
    assert [stamp(first), stamp(second)] == before and rows(db) == [] and log_lines(tmp_path) == []
    db.expire_all()
    assert db.get(Track, ids[second.name]).file_name == second.name

    # An undo given a file of its own is held to the same rule.
    row = tag_writer.write(db, tag_writer.plan_write(first, NEW), batch_id="b1", track_id=ids[first.name])
    written = stamp(first)
    with pytest.raises(Refused) as caught:
        tag_writer.undo_logged(db, tag_writer._entry(row), second)
    assert caught.value.reason == "wrong_track" and stamp(first) == written and stamp(second) == before[1]


def test_an_unexpected_error_still_audits_the_files_written_before_it(db, lib, monkeypatch):
    first, second = lib / "A - One.mp3", lib / "B - Two.mp3"
    make(first), make(second)
    scanner.scan(db, [lib])
    ids = {t.file_name: t.id for t in db.exec(select(Track)).all()}
    plans = [(ids[p.name], tag_writer.plan_write(p, NEW)) for p in (first, second)]
    real = tag_writer._refresh_catalog

    def refresh(session, track_id, path):
        if path == second:
            raise RuntimeError("catalog")
        real(session, track_id, path)

    monkeypatch.setattr(tag_writer, "_refresh_catalog", refresh)
    with pytest.raises(RuntimeError):
        tag_writer.write_batch(db, plans)

    (audit_row,) = db.exec(select(AuditLog).where(AuditLog.action == "tag_write")).all()
    (done,) = [row for row in rows(db) if row.state == "done"]
    assert json.loads(audit_row.after_json)["rows"] == [done.id] and done.track_id == ids[first.name]


@pytest.mark.skipif(not hasattr(getattr(tag_writer, "fcntl", None), "F_FULLFSYNC"), reason="macOS only")
def test_the_write_reaches_the_disk_before_it_is_read_back(db, tmp_path, monkeypatch):
    path = tmp_path / "track.mp3"
    make(path)
    plan = tag_writer.plan_write(path, NEW)
    events, real_fcntl, real_differs = [], tag_writer.fcntl.fcntl, tag_writer._differs

    def fcntl(fd, cmd, *args):
        events.append(cmd)
        return real_fcntl(fd, cmd, *args)

    def differs(*args):
        events.append("check")
        return real_differs(*args)

    monkeypatch.setattr(tag_writer.fcntl, "fcntl", fcntl)
    monkeypatch.setattr(tag_writer, "_differs", differs)
    tag_writer.write(db, plan, batch_id="b1")
    assert events[:2] == [tag_writer.fcntl.F_FULLFSYNC, "check"]


# ---- a write that never finished: only flagged, restored when asked ----

class Crash(BaseException):
    """The process dies: no handler of the writer runs."""


def crashed_write(db, path: Path, monkeypatch, moment: str) -> TagWrite:
    plan = tag_writer.plan_write(path, NEW)
    real = tag_writer._pwrite

    def pwrite(fd, data, offset):
        if moment == "before any byte":
            raise Crash
        if moment == "halfway":
            real(fd, data[:len(data) // 2], offset)
            raise Crash
        real(fd, data, offset)
        if offset:  # both buffers are in the file
            raise Crash

    monkeypatch.setattr(tag_writer, "_pwrite", pwrite)
    with pytest.raises(Crash):
        tag_writer.write(db, plan, batch_id="b1")
    monkeypatch.setattr(tag_writer, "_pwrite", real)
    (row,) = rows(db)
    return row


@pytest.mark.parametrize("moment", ["before any byte", "halfway", "after the last byte"])
def test_a_pending_write_is_only_flagged_and_restores_when_asked(db, tmp_path, monkeypatch, moment):
    path = tmp_path / "track.mp3"
    original = make(path)
    row = crashed_write(db, path, monkeypatch, moment)
    left = stamp(path)
    assert (left[0] == original) == (moment == "before any byte")
    if moment == "halfway":  # a torn mix: neither the old block nor the new one
        assert b"\x00Shivastra (183)\x00" not in left[0] and b"\x00Hi-Tech" not in left[0]

    # The next start: the row is listed, and nothing touches the file by itself.
    import app.db as dbmod
    dbmod.init_db()
    assert [r.id for r in tag_writer.pending(db)] == [row.id] and row.state == "pending"
    assert stamp(path) == left
    with pytest.raises(Refused) as caught:
        tag_writer.undo(db, row.id)
    assert caught.value.reason == "unfinished" and stamp(path) == left

    outcome = tag_writer.restore_pending(db, row.id)

    assert path.read_bytes() == original
    if moment == "before any byte":
        assert stamp(path) == left and "δεν χρειάστηκε αλλαγή" in outcome
    assert tag_writer.pending(db) == [] and row.state == "failed"
    assert not (tmp_path / "tag-writes-pending" / f"{row.id}.bin").exists()


@pytest.mark.parametrize("foreign", ["a byte in the block", "a byte in id3v1", "another size"])
def test_a_pending_write_another_app_wrote_over_is_refused(db, tmp_path, monkeypatch, foreign):
    path = tmp_path / "track.mp3"
    original = make(path)
    row = crashed_write(db, path, monkeypatch, "halfway")
    torn = path.read_bytes()
    if foreign == "a byte in the block":
        path.write_bytes(flip(torn, original.index(b"Serato Overview")))
    elif foreign == "a byte in id3v1":
        path.write_bytes(flip(torn, len(torn) - 60))
    else:
        path.write_bytes(torn + b"\0")
    left = stamp(path)

    with pytest.raises(Refused) as caught:
        tag_writer.restore_pending(db, row.id)

    assert caught.value.reason == "foreign" and stamp(path) == left
    assert [r.id for r in tag_writer.pending(db)] == [row.id]
    assert (tmp_path / "tag-writes-pending" / f"{row.id}.bin").exists()


def test_a_pending_row_without_its_saved_copy_never_touches_the_file(db, tmp_path, monkeypatch):
    path = tmp_path / "track.mp3"
    make(path)
    row = crashed_write(db, path, monkeypatch, "before any byte")
    (tmp_path / "tag-writes-pending" / f"{row.id}.bin").unlink()
    left = stamp(path)

    assert "Δεν υπάρχει αντίγραφο" in tag_writer.restore_pending(db, row.id)
    assert stamp(path) == left and tag_writer.pending(db) == []


def test_restore_is_refused_while_a_dj_app_runs(db, tmp_path, monkeypatch):
    path = tmp_path / "track.mp3"
    make(path)
    row = crashed_write(db, path, monkeypatch, "halfway")
    left = stamp(path)
    monkeypatch.setattr(tag_writer, "running_dj_apps", lambda: ["Traktor Pro 4"])
    with pytest.raises(Refused) as caught:
        tag_writer.restore_pending(db, row.id)
    assert caught.value.reason == "dj_app" and stamp(path) == left


# ---- nothing can reach the writer yet ----

def test_nothing_in_the_app_imports_the_writer():
    app = Path(tag_writer.__file__).resolve().parents[1]
    users = [p.relative_to(app).as_posix() for p in app.rglob("*.py")
             if p.name != "tag_writer.py" and "tag_writer" in p.read_text(encoding="utf-8")]
    assert users == ["models.py"]  # the table's docstring names the module; no code calls it
