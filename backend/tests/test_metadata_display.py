"""Display inference is reversible and does not promote provider identities."""
import json
import sqlite3

import pytest

from app.models import Track
from app.services import canonical_library, metadata_display as display
from app.services.metadata_reader import display_title_hints, infer_tags_from_filename
from app.services.tempo import effective_bpm, effective_bpm_values
from pathlib import Path


@pytest.fixture
def identity():
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.executescript("""
        CREATE TABLE entities(id TEXT PRIMARY KEY,service TEXT,recording_id TEXT,
          local_track_id INTEGER,artist TEXT,title TEXT,metadata_json TEXT,normalized_json TEXT);
        CREATE TABLE candidates(left_id TEXT,right_id TEXT,score REAL,evidence_json TEXT);
    """
    )
    db.executescript(canonical_library.SCHEMA)
    yield db
    db.close()


def source(db, sid, artist, title, *, performer=None, uploader=None, analyzed=None, rid=None):
    service = "local" if sid.startswith("local:") else "soundcloud"
    rid = rid or sid
    raw = {"bpm_analyzed": analyzed, "uploader": uploader}
    normalized = {"artist": performer if service == "soundcloud" else artist, "uploader": uploader}
    db.execute("INSERT INTO entities VALUES (?,?,?,?,?,?,?,?)", (
        sid, service, rid, int(sid.split(":")[1]) if service == "local" else None,
        artist, title, json.dumps(raw), json.dumps(normalized)))
    db.execute("INSERT OR IGNORE INTO canonical_recordings VALUES (?,?,?,?,?,?,?,?,?)", (
        rid, title, artist, "", "", "review", "{}", "{}", "now"))
    return sid


def candidate(db, local, remote, *, score=72, title=1, duration=.1, conflicts=None):
    evidence = {"title_similarity": title, "duration_delta_seconds": duration,
                "conflicts": conflicts or []}
    db.execute("INSERT INTO candidates VALUES (?,?,?,?)", (local, remote, score, json.dumps(evidence)))


@pytest.mark.parametrize(("title", "expected", "bpm"), [
    ("Epsilon [202]", "Epsilon", 202),
    ("Mescaline (177bpm)", "Mescaline", 177),
    ("The Mother Load [170] (OVNI RECORDS 08)", "The Mother Load", 170),
    ("Freack Out (198Bpm) V.A AQUARIUS Vol.1", "Freack Out", 198),
    ("We Are Gods (Shrinkhead Remix) (195 Bpm) V.A AQUARIUS Vol.1", "We Are Gods (Shrinkhead Remix)", 195),
    ("Synchronicity City 3.0", "Synchronicity City 3.0", None),
    ("Nightcall (Area 88)", "Nightcall (Area 88)", None),
    ("Route 66", "Route 66", None),
    ("Aquarius", "Aquarius", None),
    ("Song (Original Mix) [280]", "Song (Original Mix)", 280),
])
def test_title_cleaning_keeps_meaningful_versions(title, expected, bpm):
    assert display_title_hints(title) == (expected, bpm)


def test_fields_are_independent_and_sources_unchanged(identity):
    local = source(identity, "local:1", "1", "Song [170]")
    remote = source(identity, "soundcloud:1", "Publisher", "1 - Song [170]", performer="Real Artist")
    candidate(identity, local, remote, conflicts=["artist_conflict"])
    before = identity.total_changes
    identity.execute("PRAGMA query_only=ON")
    row = display.recordings(identity, [local])[local]
    assert (row["title"], row["artist"], row["display_bpm_hint"]) == ("Song", "Real Artist", 170)
    assert row["metadata_provenance"]["artist"]["accepted_identity"] is False
    assert identity.total_changes == before
    assert identity.execute("SELECT artist,title FROM entities WHERE id=?", (local,)).fetchone()[:] == ("1", "Song [170]")


def test_uploader_inference_and_numeric_tempo_guard(identity):
    a = source(identity, "local:1", "1", "City 3.0")
    b = source(identity, "soundcloud:1", "globular", "1 - City 3.0", uploader="globular")
    candidate(identity, a, b)
    c = source(identity, "local:2", "280", "Unknown meaning", analyzed=140.4)
    d = source(identity, "soundcloud:2", "Unrelated uploader", "280 - Unknown meaning", uploader="Unrelated uploader")
    candidate(identity, c, d, score=69.9)
    rows = display.recordings(identity, [a, c])
    assert rows[a]["artist"] == "globular"
    assert rows[a]["metadata_provenance"]["artist"]["basis"] == "inferred_uploader"
    assert rows[c]["artist"] == ""
    assert rows[c]["display_bpm_hint"] == 280


@pytest.mark.parametrize("state", ["human", "kept_local", "rejected"])
def test_manual_decisions_are_exact(identity, state):
    sid = source(identity, "local:1", "1", "Hand chosen [170]")
    identity.execute("UPDATE canonical_recordings SET state=?", (state,))
    row = display.recordings(identity, [sid])[sid]
    assert (row["artist"], row["title"]) == ("1", "Hand chosen [170]")


@pytest.mark.parametrize("bad", [
    {"score": 64.9}, {"title": .94}, {"duration": 7},
    {"conflicts": ["duration_conflict"]}, {"conflicts": ["previously_rejected"]},
    {"conflicts": ["version_mismatch"]},
])
def test_inference_guards_but_still_cleans_title(identity, bad):
    a = source(identity, "local:1", "1", "Song [170]")
    b = source(identity, "soundcloud:1", "Artist", "Song", performer="Artist")
    candidate(identity, a, b, **bad)
    row = display.recordings(identity, [a])[a]
    assert row["artist"] == ""
    assert row["title"] == "Song"


def test_different_recording_near_tie_blocks_even_below_minimum(identity):
    a = source(identity, "local:1", "1", "Song")
    b = source(identity, "soundcloud:1", "Artist A", "Song", performer="Artist A")
    c = source(identity, "soundcloud:2", "Artist B", "Song", performer="Artist B")
    candidate(identity, a, b, score=66)
    candidate(identity, a, c, score=64)
    assert display.recordings(identity, [a])[a]["artist"] == ""


def test_revoked_and_blocked_links_never_infer(identity):
    a = source(identity, "local:1", "1", "Song")
    b = source(identity, "soundcloud:1", "Artist", "Song", performer="Artist")
    candidate(identity, a, b)
    identity.execute("INSERT INTO canonical_blocks VALUES (?,?,?)", (b, a, "historical_rejection"))
    assert display.recordings(identity, [a])[a]["artist"] == ""
    identity.execute("DELETE FROM canonical_blocks")
    identity.execute("INSERT INTO identity_acceptances VALUES (?,?,?,?,?,?,?,?,?)", (b,a,"local:soundcloud",80,"test","{}","then","human","now"))
    assert display.recordings(identity, [a])[a]["artist"] == ""


def test_bulk_queries_do_not_grow_per_track(identity):
    for n in range(1, 101):
        source(identity, f"local:{n}", "Artist", "Song [170]")
    statements = []
    identity.set_trace_callback(statements.append)
    result = display.recordings(identity, [f"local:{n}" for n in range(1,101)])
    assert len(result) == 100
    assert len(statements) <= 4


def test_tempo_and_sql_filter_preserve_metadata_octave_and_manual(db):
    track = Track(absolute_path="/tmp/song.mp3", file_name="song.mp3", extension="mp3",
                  artist="280", title="Meaning", bpm_analyzed=140.4)
    assert effective_bpm(track) == 280
    db.add(track)
    db.commit()
    from app.services.search import search
    assert [t.id for t in search(db, "bpm:280")] == [track.id]
    track.bpm_consensus, track.bpm_consensus_sources = 142, "manual:local"
    assert effective_bpm(track) == 142
    assert effective_bpm_values(None,140.4,142,"manual:local","280","Meaning") == 142
    assert infer_tags_from_filename(Path("Artist - Song [280].mp3"))["bpm"] == 280


def test_list_detail_and_sets_share_projection(client, monkeypatch):
    """Integration uses the real serializers with a generated identity read model."""
    from app.api import tracks, sets
    from app import db as dbmod
    from sqlmodel import Session
    from app.models import DJSet, SetTrack
    from contextlib import contextmanager

    identity = sqlite3.connect(":memory:", check_same_thread=False)
    identity.row_factory = sqlite3.Row
    identity.executescript("CREATE TABLE entities(id TEXT PRIMARY KEY,service TEXT,recording_id TEXT,local_track_id INTEGER,artist TEXT,title TEXT,metadata_json TEXT,normalized_json TEXT); CREATE TABLE candidates(left_id TEXT,right_id TEXT,score REAL,evidence_json TEXT);")
    identity.executescript(canonical_library.SCHEMA)
    @contextmanager
    def connect():
        yield identity
    monkeypatch.setattr("app.services.identity_library.connect", connect)
    # Provider card assembly is separately covered; this check targets the main
    # track payload consumed by the player, lists and set builder.
    monkeypatch.setattr(tracks.soundcloud, "track_detail", lambda *_: {})
    with Session(dbmod.get_engine()) as session:
        track = Track(absolute_path="/tmp/song.mp3",file_name="song.mp3",extension="mp3",artist="280",title="Meaning",bpm_analyzed=140.4)
        session.add(track)
        djset = DJSet(title="Fixture")
        session.add(djset)
        session.commit()
        session.refresh(track)
        session.refresh(djset)
        session.add(SetTrack(set_id=djset.id,track_id=track.id,position=0))
        session.commit()
        source(identity,f"local:{track.id}","280","Meaning",analyzed=140.4)
        payloads = [tracks._list_payload(session,[track])[0], tracks._track_payload(session,track)["track"],
                    sets.get_set(djset.id,session)["tracks"][0]["track"]]
        assert {(row["artist"],row["title"],row["display_bpm"]) for row in payloads} == {("","Meaning",280)}
        assert track.artist == "280" and track.bpm is None
    identity.close()


def test_recording_detail_collections_recovery_and_metadata_queue_agree(tmp_path):
    from .test_stabilization import catalog
    from app.services import canonical_queue, identity_library, library_collections, library_completeness
    identity = catalog(tmp_path)
    identity.execute("UPDATE canonical_recordings SET title='Song [170]',state='review' WHERE recording_id='local:1'")
    detail = canonical_library.detail(identity,"local:1")
    browse = identity_library.list_items(identity)["items"][0]
    entries = library_collections.collection(identity,"import")["entries"]
    recovery = library_completeness.index(identity)["local:1"]
    queue = canonical_queue.list_items(identity,view="all")["items"][0]
    for row in [detail,browse,*entries,recovery,queue]:
        assert row["title"] == "Song"
        assert row["original_title"] == "Song [170]"
    assert identity.execute("SELECT title FROM canonical_recordings WHERE recording_id='local:1'").fetchone()[0] == "Song [170]"


def test_near_tie_evidence_and_retired_provider_block_inference(identity):
    a = source(identity,"local:1","1","Song [170]")
    b = source(identity,"soundcloud:1","Artist","Song",performer="Artist")
    candidate(identity,a,b)
    identity.execute("UPDATE candidates SET evidence_json=json_set(evidence_json,'$.near_tie_review',json('true'))")
    assert display.recordings(identity,[a])[a]["artist"] == ""
    identity.execute("UPDATE candidates SET evidence_json=json_remove(evidence_json,'$.near_tie_review')")
    identity.execute("UPDATE entities SET metadata_json=json_set(metadata_json,'$.asset_lifecycle.state','retired') WHERE id=?",(b,))
    assert display.recordings(identity,[a])[a]["artist"] == ""


@pytest.mark.parametrize("state,expected", [("review","MinDelve"),("human","& MinDelve"),("kept_local","& MinDelve"),("rejected","& MinDelve")])
def test_leading_credit_separator_cleanup_preserves_manual(identity,state,expected):
    local = source(identity,"local:1","& MinDelve","Epsilon [202]")
    identity.execute("UPDATE canonical_recordings SET state=?",(state,))
    projected = display.recordings(identity,[local])[local]
    assert projected["artist"] == expected
    assert identity.execute("SELECT artist FROM canonical_recordings").fetchone()[0] == "& MinDelve"


def test_inferred_artist_search_matches_display_and_honors_manual(db,identity,monkeypatch):
    from contextlib import nullcontext
    from app.services import identity_library, search
    track = Track(absolute_path="/tmp/search.mp3",file_name="search.mp3",extension="mp3",artist="1",title="City 3.0 [170]")
    db.add(track)
    db.commit()
    local = source(identity,f"local:{track.id}","1","City 3.0 [170]")
    remote = source(identity,"soundcloud:1","globular","1 - City 3.0 [170]",uploader="globular")
    candidate(identity,local,remote,score=72.9)
    # An unrelated malformed observation proves search does not deserialize the
    # whole library while looking up a newly inferred name.
    other = source(identity,"local:99","Other artist","Other song")
    identity.execute("UPDATE entities SET normalized_json='malformed' WHERE id=?",(other,))
    monkeypatch.setattr(identity_library,"connect",lambda: nullcontext(identity))
    for query in ("artist:globular","globular","globular City","City","artist:1"):
        assert [row.id for row in search.search(db,query)] == [track.id]
    for state in ("human","kept_local","rejected"):
        identity.execute("UPDATE canonical_recordings SET state=? WHERE recording_id=?",(state,local))
        assert search.search(db,"artist:globular") == []
        assert search.search(db,"globular") == []
    identity.execute("UPDATE canonical_recordings SET state='review' WHERE recording_id=?",(local,))
    identity.execute("UPDATE candidates SET evidence_json=json_set(evidence_json,'$.conflicts',json('[\"previously_rejected\"]'))")
    assert search.search(db,"artist:globular") == []


@pytest.mark.parametrize("artist,title,expected_artist,expected_title", [
    ("Artist A","Artist A - Song [170]","Artist A","Song"),
    ("Some Records","Artist A - Song (Special Remix) [170]","Artist A","Song (Special Remix)"),
    ("Some Records","Some Records - Artist A - Song (Original Mix)","Artist A","Song (Original Mix)"),
    ("Artist A","Artist A - Dreams - Part II (Special Remix)","Artist A","Dreams - Part II (Special Remix)"),
    ("Artist A","Dreams - Part II","Artist A","Dreams - Part II"),
    ("Artist A","Other Artist - Song (Special Remix)","Artist A","Other Artist - Song (Special Remix)"),
])
def test_safe_local_artist_title_projection(identity,artist,title,expected_artist,expected_title):
    local = source(identity,"local:1",artist,title)
    before = identity.total_changes
    projected = display.recordings(identity,[local])[local]
    assert (projected["artist"],projected["title"]) == (expected_artist,expected_title)
    assert identity.total_changes == before
    assert identity.execute("SELECT artist,title FROM entities WHERE id=?",(local,)).fetchone()[:] == (artist,title)


@pytest.mark.parametrize("state",["human","kept_local","rejected"])
def test_manual_local_artist_title_wrappers_are_preserved(identity,state):
    local = source(identity,"local:1","Some Records","Artist A - Song (Special Remix) [170]")
    identity.execute("UPDATE canonical_recordings SET state=?",(state,))
    projected = display.recordings(identity,[local])[local]
    assert (projected["artist"],projected["title"]) == ("Some Records","Artist A - Song (Special Remix) [170]")


def test_canonical_inferred_performer_credits_keep_originals(tmp_path):
    from .test_stabilization import catalog
    identity = catalog(tmp_path)
    identity.execute("UPDATE canonical_recordings SET artist='Some Records',title='Artist A - Song (Special Remix)',state='review' WHERE recording_id='local:1'")
    identity.execute("UPDATE entities SET artist='Some Records',title='Artist A - Song (Special Remix)',normalized_json=json_set(normalized_json,'$.artist','Some Records') WHERE id='local:1'")
    canonical_library.set_credits(identity,'local:1',[{'name':'Some Records','role':'primary'}])
    before = identity.total_changes
    projected = canonical_library.detail(identity,'local:1')
    assert (projected['artist'],projected['title']) == ('Artist A','Song (Special Remix)')
    assert projected['credits'][0]['name'] == 'Artist A'
    assert projected['original_credits'][0]['name'] == 'Some Records'
    assert projected['metadata_provenance']['artist']['accepted_identity'] is False
    assert identity.total_changes == before


def test_artist_search_finds_local_title_credit_without_provider(db,identity,monkeypatch):
    from contextlib import nullcontext
    from app.services import identity_library, search
    track = Track(absolute_path="/tmp/local-credit.mp3",file_name="local-credit.mp3",extension="mp3",artist="Some Records",title="Artist A - Song (Special Remix)")
    db.add(track)
    db.commit()
    local = source(identity,f"local:{track.id}",track.artist,track.title)
    monkeypatch.setattr(identity_library,"connect",lambda: nullcontext(identity))
    assert [row.id for row in search.search(db,"artist:Artist")] == [track.id]
    assert [row.id for row in search.search(db,'artist:"Artist A"')] == [track.id]
    assert search.search(db,'artist:"Special Remix"') == []
    identity.execute("UPDATE canonical_recordings SET state='kept_local' WHERE recording_id=?",(local,))
    assert search.search(db,'artist:"Artist A"') == []


def proposal_catalog():
    from .test_canonical import fixture_db, entity, put
    identity = fixture_db()
    identity.executescript(canonical_library.SCHEMA)
    local = entity('local:1','local',artist='1',title='City 3.0 [170]')
    remote = entity('soundcloud:tracks:99','soundcloud',artist=None,title='1 - City 3.0 [170]')
    remote['artist'] = 'globular'
    remote['metadata_json'] = json.dumps({'uploader':'globular'})
    for item in (local,remote):
        put(identity,item)
    original = {'artist':'1','title':'City 3.0 [170]','credits':[{'name':'1','role':'primary'}], 'version':'','release':None}
    evidence = {'observations':[{'id':'local:1','service':'local','artist':'1','title':'City 3.0 [170]'}], 'patterns':[]}
    identity.execute('INSERT INTO canonical_recordings VALUES (?,?,?,?,?,?,?,?,?)',('local:1',original['title'],original['artist'],'',None,'review',json.dumps(original),json.dumps(evidence),'now'))
    canonical_library.set_credits(identity,'local:1',original['credits'])
    identity.execute('INSERT INTO candidates VALUES (?,?,?,?,?,?)',('local:1',remote['id'],'local:soundcloud',72.9,'PROBABLE',json.dumps({'title_similarity':1,'duration_delta_seconds':.1,'conflicts':[]})))
    return identity,original


def test_displayed_inferred_proposal_is_accepted_only_by_explicit_decision():
    identity,original = proposal_catalog()
    before = identity.total_changes
    projected = canonical_library.detail(identity,'local:1')
    assert projected['original_proposal'] == original
    assert (projected['proposal']['artist'],projected['proposal']['title']) == ('globular','City 3.0')
    assert projected['proposal']['credits'][0]['name'] == 'globular'
    assert projected['proposal']['metadata_provenance']['artist']['accepted_identity'] is False
    assert projected['evidence']['observations'][0]['artist'] == '1'
    assert identity.total_changes == before
    assert json.loads(identity.execute('SELECT proposal_json FROM canonical_recordings').fetchone()[0]) == original
    accepted = canonical_library.review(identity,'local:1','accept')
    assert (accepted['artist'],accepted['title'],accepted['state']) == ('globular','City 3.0','human')
    assert accepted['credits'][0]['name'] == 'globular'
    assert accepted['proposal']['artist'] == 'globular'
    assert accepted['proposal']['title'] == 'City 3.0'
    repeated = canonical_library.review(identity,'local:1','accept')
    assert repeated['artist'] == repeated['proposal']['artist'] == 'globular'
    # Accepting metadata never accepts the inferred provider identity.
    assert identity.execute('SELECT count(*) FROM identity_acceptances').fetchone()[0] == 0
    event = identity.execute('SELECT before_json,after_json FROM canonical_events ORDER BY id LIMIT 1').fetchone()
    assert json.loads(event['before_json'])['original_proposal'] == original
    assert json.loads(event['after_json'])['artist'] == 'globular'


@pytest.mark.parametrize('state',['human','kept_local','rejected'])
def test_manual_proposal_and_credits_remain_exact(state):
    identity,original = proposal_catalog()
    identity.execute('UPDATE canonical_recordings SET state=?',(state,))
    before = identity.total_changes
    projected = canonical_library.detail(identity,'local:1')
    assert projected['proposal'] == original
    assert 'original_proposal' not in projected
    assert projected['credits'][0]['name'] == '1'
    assert (projected['artist'],projected['title']) == ('1','City 3.0 [170]')
    assert identity.total_changes == before


def test_title_only_cleaning_keeps_review_proposal_consistent(tmp_path):
    from .test_stabilization import catalog
    identity = catalog(tmp_path)
    identity.execute("UPDATE canonical_recordings SET title='Song [170]',state='review' WHERE recording_id='local:1'")
    before = identity.total_changes
    projected = canonical_library.detail(identity,'local:1')
    assert projected['proposal']['artist'] == projected['artist'] == 'Artist A'
    assert projected['proposal']['title'] == projected['title'] == 'Song'
    assert projected['proposal']['credits'][0]['name'] == 'Artist A'
    assert 'original_proposal' in projected
    assert identity.total_changes == before


def test_explicit_edit_updates_future_editor_proposal():
    identity,_ = proposal_catalog()
    edited = canonical_library.review(identity,'local:1','edit',{'artist':'ignored','title':'Hand title','credits':[{'name':'Hand artist','role':'primary'}]})
    assert edited['artist'] == edited['proposal']['artist'] == 'Hand artist'
    assert edited['title'] == edited['proposal']['title'] == 'Hand title'
    assert canonical_library.review(identity,'local:1','accept')['artist'] == 'Hand artist'
