"""API request/response schemas (Pydantic v2)."""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel


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
    track_ids: list[int]
    profile: ProfileUpdate


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
    set_id: Optional[int] = None
    track_ids: Optional[list[int]] = None
    filename: Optional[str] = None
    overwrite: bool = False


class ScanRequest(BaseModel):
    roots: Optional[list[str]] = None  # override configured roots


class AnalyzeRequest(BaseModel):
    force: bool = False
    limit: Optional[int] = None


class PlayLog(BaseModel):
    set_id: Optional[int] = None
    context: Optional[str] = None
    crowd_reaction: Optional[int] = None
    notes: Optional[str] = None


class ArtistListFilters(BaseModel):
    q: Optional[str] = None
    confidence_label: Optional[str] = None
    needs_review: Optional[bool] = None
    min_track_count: int = 0
    limit: int = 200
    offset: int = 0


class ArtistStatsResponse(BaseModel):
    total_artists: int
    active_artists: int
    unenriched_artists: int
    needs_review_artists: int


class ArtistEnrichRequest(BaseModel):
    limit: Optional[int] = None
