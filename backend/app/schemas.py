"""API request/response schemas (Pydantic v2)."""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .services.tempo_ranges import DjRangeKey, TempoRangeKey


CueKind = Literal["entry", "exit", "cue"]
# SQLite INTEGER storage is signed 64-bit; reject larger JSON integers as 422.
CuePosition = Annotated[int, Field(strict=True, ge=0, le=9223372036854775807)]
CueLabel = Annotated[str, Field(max_length=120)]


class CueCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    position_ms: CuePosition
    kind: CueKind
    label: CueLabel | None = None


class DownbeatSet(BaseModel):
    model_config = ConfigDict(extra="forbid")

    downbeat_s: float


class CueUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    position_ms: CuePosition | None = None
    kind: CueKind | None = None
    label: CueLabel | None = None

    @field_validator("position_ms", "kind")
    @classmethod
    def required_when_supplied(cls, value):
        if value is None:
            raise ValueError("field cannot be null")
        return value


class CueResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    track_id: int
    position_ms: int
    kind: CueKind
    label: str | None
    created_at: datetime
    updated_at: datetime

    @field_validator("created_at", "updated_at")
    @classmethod
    def utc_timestamp(cls, value: datetime) -> datetime:
        # SQLite drops timezone offsets; these server-written values are UTC.
        return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


class ProfileUpdate(BaseModel):
    """Partial DJ-profile update. Only provided fields are written."""
    energy: Optional[int] = None
    intensity: Optional[int] = None
    darkness: Optional[int] = None
    melody: Optional[int] = None
    weirdness: Optional[int] = None
    mixability: Optional[int] = None
    confidence: Optional[int] = None
    chaos_level: Optional[int] = None
    valence: Optional[int] = Field(default=None, ge=1, le=10)
    set_role: Optional[str] = None
    transition_role: Optional[str] = None
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
    personal_status: Optional[str] = None
    tempo_bridge_score: Optional[int] = None
    bpm_jump_tolerance: Optional[str] = None
    can_cut_into: Optional[bool] = None
    can_cut_out_of: Optional[bool] = None
    dramatic_transition_candidate: Optional[bool] = None
    notes: Optional[str] = None
    human_confirmed: Optional[bool] = None


class BatchProfileUpdate(BaseModel):
    """Scope: non-empty track_ids xor query (query "" = whole library)."""
    track_ids: list[int] = []
    query: Optional[str] = None
    profile: Optional[ProfileUpdate] = None
    add_tag_ids: list[int] = []
    remove_tag_ids: list[int] = []
    dry_run: bool = False


class TagCreate(BaseModel):
    name: str
    category: Optional[str] = None


class TagAssign(BaseModel):
    tag_id: Optional[int] = None
    name: Optional[str] = None  # create-or-get by name if id absent


class DuplicateResolve(BaseModel):
    status: str = "resolved"           # resolved / ignored
    master_track_id: Optional[int] = None
    roles: dict[int, str] = {}         # track_id -> master/duplicate/different_edit/not_duplicate


class SetCreate(BaseModel):
    title: str
    date: Optional[str] = None
    target_duration: Optional[int] = None
    target_bpm_arc: Optional[str] = None
    target_energy_arc: Optional[str] = None
    notes: Optional[str] = None


class SetTrackAdd(BaseModel):
    track_id: int
    position: Optional[int] = None
    note: Optional[str] = None


class SetReorder(BaseModel):
    ordered_track_ids: list[int]
    ordered_positions: list[int] | None = None


class PairNoteCreate(BaseModel):
    from_track_id: int
    to_track_id: int
    rating: Optional[int] = None
    transition_type: Optional[str] = None
    notes: Optional[str] = None


class RecommendQuery(BaseModel):
    after_track_id: Optional[int] = None
    before_track_id: Optional[int] = None  # bridge target — track this leads INTO
    target_bpm: Optional[float] = None
    target_energy: Optional[int] = None
    target_role: Optional[str] = None
    max_weirdness: Optional[int] = None
    approved_only: bool = False
    need_bridge: bool = False
    limit: int = 20


class SavedSearchCreate(BaseModel):
    name: str
    query: str
    description: Optional[str] = None
    pinned: bool = False


class SavedSearchUpdate(BaseModel):
    name: Optional[str] = None
    query: Optional[str] = None
    description: Optional[str] = None
    pinned: Optional[bool] = None
    sort_order: Optional[int] = None


class ExportRequest(BaseModel):
    all_tracks: bool = False
    set_id: Optional[int] = None
    track_ids: Optional[list[int]] = None
    filename: Optional[str] = None
    overwrite: bool = False


class ScanRequest(BaseModel):
    mode: Literal["full", "delta"] = "full"
    roots: Optional[list[str]] = None  # override configured roots
    tempo_range: TempoRangeKey = "psy"
    root_ranges: dict[str, DjRangeKey] = {}  # connected music folder -> its window


class AnalyzeRequest(BaseModel):
    """Unscoped by default. A scope is track_ids xor query (query "" = whole
    library); a scoped job re-analyses those tracks, primary-only."""
    force: bool = False
    limit: Optional[int] = None
    tempo_range: TempoRangeKey = "psy"
    root_ranges: dict[str, DjRangeKey] = {}
    track_ids: Optional[list[int]] = None
    query: Optional[str] = None
    dry_run: bool = False

    @property
    def scoped(self) -> bool:
        return self.track_ids is not None or self.query is not None

    @model_validator(mode="after")
    def _one_scope(self) -> "AnalyzeRequest":
        if self.track_ids is not None and self.query is not None:
            raise ValueError("Δώσε είτε κομμάτια είτε αναζήτηση.")
        if self.dry_run and not self.scoped:
            raise ValueError("Ο έλεγχος χωρίς εκκίνηση χρειάζεται κομμάτια ή αναζήτηση.")
        return self


class PlayLog(BaseModel):
    set_id: Optional[int] = None
    context: Optional[str] = None
    crowd_reaction: Optional[int] = None
    notes: Optional[str] = None


class ArtistStatsResponse(BaseModel):
    total_artists: int
    active_artists: int
    unenriched_artists: int
    needs_review_artists: int


class ArtistEnrichRequest(BaseModel):
    limit: Optional[int] = Field(default=None, ge=1)
    force: bool = False  # re-enrich already-enriched artists (default: skip them)


class SoundCloudImportBatch(BaseModel):
    run_id: str = Field(min_length=1, max_length=128)
    items: list[Any] = Field(default_factory=list, max_length=250)
    complete: bool = False

    @field_validator("run_id")
    @classmethod
    def normalize_run_id(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("run_id must not be blank")
        return normalized


class ArtistReviewChoice(BaseModel):
    choice: Literal["current", "candidate", "manual"]
    subgenre: Optional[str] = Field(default=None, max_length=200)
