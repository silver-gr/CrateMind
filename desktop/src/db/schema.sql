-- CrateMind Deno desktop schema. Mirrors backend/app/models.py column-for-column.
-- Datetimes are TEXT (ISO-8601 UTC via nowIso()); booleans are INTEGER 0/1.

CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY,
    absolute_path TEXT NOT NULL UNIQUE,
    normalized_path TEXT NOT NULL DEFAULT '',
    volume_root TEXT,
    file_name TEXT NOT NULL DEFAULT '',
    extension TEXT NOT NULL DEFAULT '',
    file_size INTEGER,
    modified_time REAL,
    created_time REAL,

    duration REAL,
    bitrate INTEGER,
    sample_rate INTEGER,
    channels INTEGER,
    codec TEXT,
    container TEXT,

    artist TEXT,
    artist_normalized TEXT,
    title TEXT,
    album TEXT,
    label TEXT,
    year INTEGER,
    genre TEXT,
    comment TEXT,
    bpm REAL,
    key_text TEXT,
    rating INTEGER,

    bpm_analyzed REAL,
    bpm_analyzed_raw REAL,
    bpm_analyzed_confidence REAL,
    bpm_analyzed_method TEXT,
    bpm_consensus REAL,
    bpm_consensus_sources TEXT,
    key_analyzed TEXT,
    key_analyzed_confidence REAL,
    analyzed_at TEXT,
    analysis_error TEXT,

    quick_hash TEXT,
    full_hash TEXT,

    play_count INTEGER NOT NULL DEFAULT 0,
    last_played_at TEXT,

    imported_at TEXT NOT NULL,
    last_scanned_at TEXT NOT NULL,
    missing INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_tracks_absolute_path ON tracks (absolute_path);
CREATE INDEX IF NOT EXISTS ix_tracks_quick_hash ON tracks (quick_hash);
CREATE INDEX IF NOT EXISTS ix_tracks_full_hash ON tracks (full_hash);
CREATE INDEX IF NOT EXISTS ix_tracks_artist_normalized ON tracks (artist_normalized);
CREATE INDEX IF NOT EXISTS ix_tracks_missing ON tracks (missing);

CREATE TABLE IF NOT EXISTS artist_profiles (
    id INTEGER PRIMARY KEY,
    normalized_name TEXT NOT NULL UNIQUE,
    canonical_name TEXT NOT NULL,
    aliases_json TEXT,
    track_count INTEGER NOT NULL DEFAULT 0,

    scene_cluster TEXT,
    primary_subgenre TEXT,
    secondary_subgenres_json TEXT,
    typical_bpm_min REAL,
    typical_bpm_max REAL,
    energy_min INTEGER,
    energy_max INTEGER,
    set_role_hints_json TEXT,
    confidence_label TEXT,
    needs_review INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    raw_llm_json TEXT,
    last_enriched_at TEXT,

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_artist_profiles_normalized_name ON artist_profiles (normalized_name);
CREATE INDEX IF NOT EXISTS ix_artist_profiles_canonical_name ON artist_profiles (canonical_name);
CREATE INDEX IF NOT EXISTS ix_artist_profiles_needs_review ON artist_profiles (needs_review);

CREATE TABLE IF NOT EXISTS track_dj_profile (
    track_id INTEGER PRIMARY KEY REFERENCES tracks (id),

    energy INTEGER,
    intensity INTEGER,
    darkness INTEGER,
    melody INTEGER,
    weirdness INTEGER,
    mixability INTEGER,
    confidence INTEGER,
    chaos_level INTEGER,

    set_role TEXT,
    transition_role TEXT,
    groove_type TEXT,
    vocal_density TEXT,
    breakdown_profile TEXT,
    drop_profile TEXT,
    bassline_type TEXT,
    lead_character TEXT,
    psy_substyle TEXT,
    festival_time TEXT,
    ritual_factor TEXT,
    crowd_risk TEXT,
    personal_status TEXT NOT NULL DEFAULT 'unknown',

    tempo_bridge_score INTEGER,
    bpm_jump_tolerance TEXT,
    can_cut_into INTEGER,
    can_cut_out_of INTEGER,
    dramatic_transition_candidate INTEGER,

    notes TEXT,
    human_confirmed INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT
);

CREATE INDEX IF NOT EXISTS ix_track_dj_profile_personal_status ON track_dj_profile (personal_status);
CREATE INDEX IF NOT EXISTS ix_track_dj_profile_human_confirmed ON track_dj_profile (human_confirmed);

CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    category TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_tags_name ON tags (name);

CREATE TABLE IF NOT EXISTS track_tags (
    track_id INTEGER NOT NULL REFERENCES tracks (id),
    tag_id INTEGER NOT NULL REFERENCES tags (id),
    source TEXT NOT NULL DEFAULT 'human',
    confidence REAL,
    PRIMARY KEY (track_id, tag_id)
);

CREATE TABLE IF NOT EXISTS fingerprints (
    track_id INTEGER PRIMARY KEY REFERENCES tracks (id),
    chromaprint TEXT,
    duration_seconds REAL,
    fingerprinted_at TEXT
);

CREATE TABLE IF NOT EXISTS duplicate_groups (
    id INTEGER PRIMARY KEY,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'needs_review',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_duplicate_groups_status ON duplicate_groups (status);

CREATE TABLE IF NOT EXISTS duplicate_group_tracks (
    group_id INTEGER NOT NULL REFERENCES duplicate_groups (id),
    track_id INTEGER NOT NULL REFERENCES tracks (id),
    role TEXT,
    PRIMARY KEY (group_id, track_id)
);

CREATE TABLE IF NOT EXISTS sets (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    date TEXT,
    target_duration INTEGER,
    target_bpm_arc TEXT,
    target_energy_arc TEXT,
    notes TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS set_tracks (
    set_id INTEGER NOT NULL REFERENCES sets (id),
    position INTEGER NOT NULL,
    track_id INTEGER NOT NULL REFERENCES tracks (id),
    note TEXT,
    PRIMARY KEY (set_id, position)
);

CREATE TABLE IF NOT EXISTS track_pair_notes (
    id INTEGER PRIMARY KEY,
    from_track_id INTEGER NOT NULL REFERENCES tracks (id),
    to_track_id INTEGER NOT NULL REFERENCES tracks (id),
    rating INTEGER,
    transition_type TEXT,
    notes TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_track_pair_notes_from_track_id ON track_pair_notes (from_track_id);
CREATE INDEX IF NOT EXISTS ix_track_pair_notes_to_track_id ON track_pair_notes (to_track_id);

CREATE TABLE IF NOT EXISTS play_events (
    id INTEGER PRIMARY KEY,
    track_id INTEGER NOT NULL REFERENCES tracks (id),
    set_id INTEGER REFERENCES sets (id),
    played_at TEXT,
    context TEXT,
    crowd_reaction INTEGER,
    notes TEXT
);

CREATE INDEX IF NOT EXISTS ix_play_events_track_id ON play_events (track_id);

CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id INTEGER,
    before_json TEXT,
    after_json TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    total INTEGER NOT NULL DEFAULT 0,
    processed INTEGER NOT NULL DEFAULT 0,
    message TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_jobs_status ON jobs (status);

CREATE TABLE IF NOT EXISTS saved_searches (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    query TEXT NOT NULL,
    description TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_saved_searches_name ON saved_searches (name);

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS track_search USING fts5(
    artist, title, album, label, genre, comment, notes, tags
);
