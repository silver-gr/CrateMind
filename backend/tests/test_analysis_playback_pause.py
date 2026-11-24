"""Background analysis waits between tracks while a deck plays (the deck rescue file is fresh), says so on the job
row, and carries on when playback stops. ffmpeg is stubbed, so no audio is read."""
import os
import threading
import time
from datetime import UTC, datetime

from sqlmodel import Session

from app.api import deck_rescue
from app.models import Job, Track
from app.services import audio_analysis as aa


def test_deck_playing_reads_the_freshness_of_the_rescue_file(db):
    path = deck_rescue._path()
    assert not path.exists() and deck_rescue.deck_playing() is False      # no file: not playing
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('{"decks": {"A": {"track_id": 1}, "B": null}}', encoding="utf-8")
    assert deck_rescue.deck_playing() is False                             # one deck: listening, not a set
    path.write_text("{}", encoding="utf-8")
    assert deck_rescue.deck_playing() is False                             # unreadable shape: not playing
    path.write_text('{"decks": {"A": {"track_id": 1}, "B": {"track_id": 2}}}', encoding="utf-8")
    assert deck_rescue.deck_playing() is True                              # both decks, just rewritten: a set plays
    old = time.time() - 60
    os.utime(path, (old, old))
    assert deck_rescue.deck_playing() is False                             # stale: playback stopped


def test_analysis_waits_while_a_deck_plays_and_says_so(db, monkeypatch):
    lock, state = threading.Lock(), {"left": 4}

    def playing():
        with lock:
            state["left"] = max(0, state["left"] - 1)
            return state["left"] > 0

    measured = []

    def measure(path):
        with lock:
            assert state["left"] == 0, "a track ran while a deck was playing"
        measured.append(path)
        return (-9.0, -1.0)

    written = []
    real_set = aa._set_job_message

    def set_message(engine, job_id, message):
        before = real_set(engine, job_id, message)
        with Session(engine) as session:
            written.append(session.get(Job, job_id).message)
        return before

    monkeypatch.setattr(deck_rescue, "deck_playing", playing)
    monkeypatch.setattr(aa, "PLAYBACK_POLL_S", 0.01)
    monkeypatch.setattr(aa, "_set_job_message", set_message)
    monkeypatch.setattr(aa.playback_loudness, "measure_file", measure)
    monkeypatch.setattr(aa, "_grid_targets", lambda *a, **k: [])
    for path in ("/a.wav", "/b.wav"):
        db.add(Track(absolute_path=path, analyzed_at=datetime.now(UTC)))
    job = Job(kind="analyze", status="running", message="analyzing 2 new tracks")
    db.add(job)
    db.commit()

    result = aa.analyze_all(db, only_unprocessed=True, local_only=True, job=job)

    assert sorted(measured) == ["/a.wav", "/b.wav"] and result["loudness"] == 2
    assert written[0] == aa.PLAYBACK_PAUSE_MESSAGE                        # the row said why it waited
    assert written[-1] == "analyzing 2 new tracks"                         # and got its message back after
    db.refresh(job)
    assert job.message == "analyzing 2 new tracks" and aa._paused_jobs == {}
