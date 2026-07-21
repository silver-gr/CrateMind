"""SQLModel ORM models for CrateMind.

Identity strategy is layered: absolute_path is the primary key for upsert, but
quick_hash / full_hash / fingerprint provide content identity so libraries that
move on disk are not lost. See services/scanner.py.
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Optional

from sqlmodel import Field, SQLModel


def _now() -> datetime:
    return datetime.now(UTC)


class Track(SQLModel, table=True):
    __tablename__ = "tracks"

    id: Optional[int] = Field(default=None, primary_key=True)
    absolute_path: str = Field(index=True, unique=True)
    normalized_path: str = ""
    volume_root: Optional[str] = None
    file_name: str = ""
    extension: str = ""
    file_size: Optional[int] = None
    modified_time: Optional[float] = None  # filesystem st_mtime (unix seconds)
    created_time: Optional[float] = None   # filesystem st_birthtime, else st_ctime

    # stream info (ffprobe)
    duration: Optional[float] = None
    bitrate: Optional[int] = None
    sample_rate: Optional[int] = None
    channels: Optional[int] = None
    codec: Optional[str] = None
    container: Optional[str] = None

    # embedded tags (mutagen)
    artist: Optional[str] = None
    artist_normalized: Optional[str] = Field(default=None, index=True)
    title: Optional[str] = None
    album: Optional[str] = None
    label: Optional[str] = None
    year: Optional[int] = None
    genre: Optional[str] = None
    comment: Optional[str] = None
    bpm: Optional[float] = None
    key_text: Optional[str] = None
    rating: Optional[int] = None

    # audio analysis — computed from the audio itself; NEVER overwrites the
    # tag-derived bpm/key_text above. See services/audio_analysis.py.
    bpm_analyzed: Optional[float] = None
    bpm_analyzed_raw: Optional[float] = None
    bpm_analyzed_confidence: Optional[float] = None
    bpm_analyzed_method: Optional[str] = None
    key_analyzed: Optional[str] = None
    key_analyzed_confidence: Optional[float] = None
    analyzed_at: Optional[datetime] = None
    analysis_error: Optional[str] = None

    # content identity
    quick_hash: Optional[str] = Field(default=None, index=True)
    full_hash: Optional[str] = Field(default=None, index=True)

    # play stats (denormalised for fast filtering)
    play_count: int = 0
    last_played_at: Optional[datetime] = None

    imported_at: datetime = Field(default_factory=_now)
    last_scanned_at: datetime = Field(default_factory=_now)
    missing: bool = Field(default=False, index=True)


class ArtistProfile(SQLModel, table=True):
    __tablename__ = "artist_profiles"

    id: Optional[int] = Field(default=None, primary_key=True)
    normalized_name: str = Field(index=True, unique=True)
    canonical_name: str = Field(index=True)
    aliases_json: Optional[str] = None
    track_count: int = 0

    scene_cluster: Optional[str] = None
    primary_subgenre: Optional[str] = None
    secondary_subgenres_json: Optional[str] = None
    typical_bpm_min: Optional[float] = None
    typical_bpm_max: Optional[float] = None
    energy_min: Optional[int] = None
    energy_max: Optional[int] = None
    set_role_hints_json: Optional[str] = None
    confidence_label: Optional[str] = None
    needs_review: bool = Field(default=False, index=True)
    notes: Optional[str] = None
    raw_llm_json: Optional[str] = None
    last_enriched_at: Optional[datetime] = None

    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


class TrackDJProfile(SQLModel, table=True):
    __tablename__ = "track_dj_profile"

    track_id: int = Field(foreign_key="tracks.id", primary_key=True)

    # 1-10 / 1-5 numeric taste axes
    energy: Optional[int] = None
    intensity: Optional[int] = None
    darkness: Optional[int] = None
    melody: Optional[int] = None
    weirdness: Optional[int] = None
    mixability: Optional[int] = None
    confidence: Optional[int] = None
    chaos_level: Optional[int] = None

    # enums / free categorical
    set_role: Optional[str] = None          # builder/bridge/peak/reset/closer/afterhours (csv)
    transition_role: Optional[str] = None   # safe_blend/dramatic_cut/... (csv)
    groove_type: Optional[str] = None
    vocal_density: Optional[str] = None
    breakdown_profile: Optional[str] = None
    drop_profile: Optional[str] = None
    bassline_type: Optional[str] = None
    lead_character: Optional[str] = None
    psy_substyle: Optional[str] = None
    festival_time: Optional[str] = None
    ritual_factor: Optional[str] = None
    crowd_risk: Optional[str] = None
    personal_status: str = Field(default="unknown", index=True)

    # tempo transition helpers
    tempo_bridge_score: Optional[int] = None
    bpm_jump_tolerance: Optional[str] = None   # native/can_push_up/can_push_down/do_not_warp
    can_cut_into: Optional[bool] = None
    can_cut_out_of: Optional[bool] = None
    dramatic_transition_candidate: Optional[bool] = None

    notes: Optional[str] = None
    human_confirmed: bool = Field(default=False, index=True)
    updated_at: Optional[datetime] = Field(default_factory=_now)


class Tag(SQLModel, table=True):
    __tablename__ = "tags"
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(unique=True, index=True)
    category: Optional[str] = None


class TrackTag(SQLModel, table=True):
    __tablename__ = "track_tags"
    track_id: int = Field(foreign_key="tracks.id", primary_key=True)
    tag_id: int = Field(foreign_key="tags.id", primary_key=True)
    source: str = "human"
    confidence: Optional[float] = None


class Fingerprint(SQLModel, table=True):
    __tablename__ = "fingerprints"
    track_id: int = Field(foreign_key="tracks.id", primary_key=True)
    chromaprint: Optional[str] = None
    duration_seconds: Optional[float] = None
    fingerprinted_at: Optional[datetime] = Field(default_factory=_now)


class DuplicateGroup(SQLModel, table=True):
    __tablename__ = "duplicate_groups"
    id: Optional[int] = Field(default=None, primary_key=True)
    reason: Optional[str] = None
    status: str = Field(default="needs_review", index=True)  # needs_review/resolved/ignored
    created_at: datetime = Field(default_factory=_now)


class DuplicateGroupTrack(SQLModel, table=True):
    __tablename__ = "duplicate_group_tracks"
    group_id: int = Field(foreign_key="duplicate_groups.id", primary_key=True)
    track_id: int = Field(foreign_key="tracks.id", primary_key=True)
    role: Optional[str] = None  # master / duplicate / different_edit / not_duplicate


class DJSet(SQLModel, table=True):
    __tablename__ = "sets"
    id: Optional[int] = Field(default=None, primary_key=True)
    title: str
    date: Optional[str] = None
    target_duration: Optional[int] = None  # minutes
    target_bpm_arc: Optional[str] = None
    target_energy_arc: Optional[str] = None
    notes: Optional[str] = None
    created_at: datetime = Field(default_factory=_now)


class SetTrack(SQLModel, table=True):
    __tablename__ = "set_tracks"
    set_id: int = Field(foreign_key="sets.id", primary_key=True)
    position: int = Field(primary_key=True)
    track_id: int = Field(foreign_key="tracks.id")
    note: Optional[str] = None


class TrackPairNote(SQLModel, table=True):
    __tablename__ = "track_pair_notes"
    id: Optional[int] = Field(default=None, primary_key=True)
    from_track_id: int = Field(foreign_key="tracks.id", index=True)
    to_track_id: int = Field(foreign_key="tracks.id", index=True)
    rating: Optional[int] = None
    transition_type: Optional[str] = None
    notes: Optional[str] = None
    created_at: datetime = Field(default_factory=_now)


class PlayEvent(SQLModel, table=True):
    __tablename__ = "play_events"
    id: Optional[int] = Field(default=None, primary_key=True)
    track_id: int = Field(foreign_key="tracks.id", index=True)
    set_id: Optional[int] = Field(default=None, foreign_key="sets.id")
    played_at: Optional[datetime] = Field(default_factory=_now)
    context: Optional[str] = None
    crowd_reaction: Optional[int] = None
    notes: Optional[str] = None


class AuditLog(SQLModel, table=True):
    __tablename__ = "audit_log"
    id: Optional[int] = Field(default=None, primary_key=True)
    action: str
    entity_type: Optional[str] = None
    entity_id: Optional[int] = None
    before_json: Optional[str] = None
    after_json: Optional[str] = None
    created_at: datetime = Field(default_factory=_now)


class Job(SQLModel, table=True):
    __tablename__ = "jobs"
    id: Optional[int] = Field(default=None, primary_key=True)
    kind: str                       # scan / fingerprint / duplicate_scan
    status: str = Field(default="pending", index=True)  # pending/running/done/error
    total: int = 0
    processed: int = 0
    message: Optional[str] = None
    error: Optional[str] = None
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


class SavedSearch(SQLModel, table=True):
    """A 'Memory Crate' — a named search query that re-runs live against the
    library. Like a Serato smart crate, but over your own taste metadata."""
    __tablename__ = "saved_searches"
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True)
    query: str
    description: Optional[str] = None
    pinned: bool = Field(default=False)
    sort_order: int = 0
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)
