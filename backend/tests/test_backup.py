from __future__ import annotations

import json
import sqlite3

import pytest

from app.models import ArtistProfile, Track
from app.services import backup


def test_json_backup_includes_artist_profiles_and_version(db, tmp_path):
    db.add(Track(absolute_path="/lib/a.wav", artist="ATYYA", artist_normalized="atyya", missing=False))
    db.add(ArtistProfile(normalized_name="atyya", canonical_name="ATYYA", track_count=1))
    db.commit()

    dest = tmp_path / "backup.json"
    backup.export_json(db, dest)

    payload = json.loads(dest.read_text(encoding="utf-8"))
    assert payload["version"] == 2
    assert payload["artist_profiles"][0]["normalized_name"] == "atyya"


def test_json_export_companion_restores_identity_and_failure_preserves_json(db, tmp_path, monkeypatch):
    identity = tmp_path / 'identity.sqlite'
    with sqlite3.connect(identity) as connection:
        connection.execute('CREATE TABLE decisions(value TEXT)')
        connection.execute("INSERT INTO decisions VALUES ('keep separate')")
    dest = tmp_path / 'backup.json'
    backup.export_json(db, dest)
    payload = json.loads(dest.read_text())
    companion = dest.parent / payload['application_backup']['directory']
    restored = backup.restore_backup(companion, tmp_path / 'restored')
    with sqlite3.connect(restored / 'identity.sqlite') as connection:
        assert connection.execute('SELECT value FROM decisions').fetchone() == ('keep separate',)
    original = dest.read_bytes()
    monkeypatch.setattr(backup.os, 'replace', lambda *args: (_ for _ in ()).throw(OSError('failed JSON publish')))
    with pytest.raises(OSError, match='failed JSON publish'):
        backup.export_json(db, dest)
    assert dest.read_bytes() == original
    backup.verify_backup(companion)
    assert not list(tmp_path.glob('.export-*'))


# --- facets and valence (therapy Phase A) -----------------------------------

def _facet_track(db, path="/lib/f.wav"):
    from app.models import TrackDJProfile
    from app.services import facets

    track = Track(absolute_path=path, title="F", missing=False)
    db.add(track)
    db.commit()
    db.add(TrackDJProfile(track_id=track.id, valence=7))
    db.commit()
    voice = facets.create_facet(db, "Φωνή", False, key="voice")
    value = facets.add_value(db, voice.id, "οργανικό")
    facets.apply_tag_changes(db, track.id, [value.id], [])
    return track, value


def test_json_backup_includes_facets_and_valence(db, tmp_path):
    _track, value = _facet_track(db)
    dest = tmp_path / "backup.json"
    backup.export_json(db, dest)
    payload = json.loads(dest.read_text(encoding="utf-8"))
    assert payload["facets"][0]["key"] == "voice"
    assert payload["profiles"][0]["valence"] == 7
    assert {"id": value.id, "name": "voice:οργανικό", "category": "voice"} in payload["tags"]


def test_bundle_round_trip_keeps_facets(db, tmp_path):
    from app.config import get_settings

    _facet_track(db)
    bundle = backup.create_backup(get_settings().db_file, tmp_path / "bk", reuse=False)
    restored = backup.restore_backup(bundle, tmp_path / "restored")
    with sqlite3.connect(restored / "catalog.sqlite") as connection:
        assert [row[0] for row in connection.execute("select key from facets")] == ["voice"]


def test_csv_has_valence_and_one_column_per_facet(db, tmp_path):
    import csv

    from sqlmodel import select

    from app.models import Tag
    from app.services import facets
    from app.services.exporter_csv import export_csv

    track, _value = _facet_track(db)
    facets.seed_preset(db, "therapy")
    other_voice = facets.create_facet(db, "Φωνή", True, key="voice_two")
    extra = facets.add_value(db, other_voice.id, "χορωδία")
    purposes = [db.exec(select(Tag.id).where(Tag.name == f"purpose:{v}")).one() for v in ("χαλάρωση", "ύπνος")]
    facets.apply_tag_changes(db, track.id, purposes + [extra.id], [])

    with export_csv(db, [track], tmp_path / "tracks.csv").open(encoding="utf-8-sig") as stream:
        rows = list(csv.reader(stream, delimiter=";"))
    header, row = rows[0], rows[1]
    # A BOM, so Excel on Windows decodes the Greek columns as UTF-8, and ';' fields,
    # the list separator of Greek regional settings, so a double-click splits the columns.
    raw = (tmp_path / "tracks.csv").read_bytes()
    assert raw.startswith(b"\xef\xbb\xbf")
    assert raw.decode("utf-8-sig").startswith("id;artist;title;")
    assert header[0] == "id"
    assert header.index("valence") == header.index("darkness") + 1
    assert "Θεραπευτικός στόχος" in header
    cell = dict(zip(header, row))
    assert cell["valence"] == "7"
    assert cell["Θεραπευτικός στόχος"] == "χαλάρωση; ύπνος"
    assert header.count("Φωνή") == 1 and "Φωνή (2)" in header
    assert cell["Φωνή"] == "οργανικό" and cell["Φωνή (2)"] == "χορωδία"


def test_csv_vocabulary_label_never_repeats_a_base_column(db, tmp_path):
    import csv

    from app.services import facets
    from app.services.exporter_csv import export_csv

    track, _value = _facet_track(db)
    genre = facets.create_facet(db, "genre", True, key="genre_vocab")
    facets.apply_tag_changes(db, track.id, [facets.add_value(db, genre.id, "drone").id], [])
    with export_csv(db, [track], tmp_path / "tracks.csv").open(encoding="utf-8-sig") as stream:
        header = next(csv.reader(stream, delimiter=";"))
    assert header.count("genre") == 1 and "genre (2)" in header
    with (tmp_path / "tracks.csv").open(encoding="utf-8-sig") as stream:
        assert next(csv.DictReader(stream, delimiter=";"))["genre (2)"] == "drone"


def test_csv_never_writes_a_number_with_exactly_three_decimals(db, tmp_path):
    """Greek Excel splits ';' columns and reads '.' as the thousands separator: a cell
    such as 240.024 (an ffprobe duration on a 1 ms boundary) would show as 240024."""
    import csv

    from app.services.exporter_csv import export_csv

    track = Track(absolute_path="/music/ms.mp3", file_name="ms.mp3", extension="mp3", duration=240.024, bpm=142.857)
    db.add(track)
    db.commit()
    with export_csv(db, [track], tmp_path / "tracks.csv").open(encoding="utf-8-sig") as stream:
        row = next(csv.DictReader(stream, delimiter=";"))
    assert row["duration"] == "240.02"
    assert row["bpm"] == "142.86"
    assert row["effective_bpm"] == "142.86"


def test_change_summary_labels_facets(db, tmp_path):
    from app.config import get_settings
    from app.library_exchange.operations import _change_summary
    from app.services import facets

    before = backup.create_backup(get_settings().db_file, tmp_path / "bk", reuse=False, keep=None)
    facets.create_facet(db, "Διάθεση", True, key="mood")
    after = backup.create_backup(get_settings().db_file, tmp_path / "bk", reuse=False, keep=None)
    rows = _change_summary(before, after)
    assert {"table": "facets", "label": "Λεξιλόγια"} in [{"table": r["table"], "label": r["label"]} for r in rows]
