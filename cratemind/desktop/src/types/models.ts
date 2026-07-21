// TypeScript row types mirroring backend/app/models.py exactly (column-for-column)
// plus request-body types ported from backend/app/schemas.py. Datetimes are
// ISO-8601 TEXT strings; booleans are stored as INTEGER 0/1 in SQLite but
// represented here as `boolean` at the application boundary — callers must
// convert via bindable() before binding to node:sqlite.

// ---- table row types --------------------------------------------------

export interface Track {
  id: number;
  absolute_path: string;
  normalized_path: string;
  volume_root: string | null;
  file_name: string;
  extension: string;
  file_size: number | null;
  modified_time: number | null;
  created_time: number | null;

  duration: number | null;
  bitrate: number | null;
  sample_rate: number | null;
  channels: number | null;
  codec: string | null;
  container: string | null;

  artist: string | null;
  artist_normalized: string | null;
  title: string | null;
  album: string | null;
  label: string | null;
  year: number | null;
  genre: string | null;
  comment: string | null;
  bpm: number | null;
  key_text: string | null;
  rating: number | null;

  bpm_analyzed: number | null;
  bpm_analyzed_raw: number | null;
  bpm_analyzed_confidence: number | null;
  bpm_analyzed_method: string | null;
  key_analyzed: string | null;
  key_analyzed_confidence: number | null;
  analyzed_at: string | null;
  analysis_error: string | null;

  quick_hash: string | null;
  full_hash: string | null;

  play_count: number;
  last_played_at: string | null;

  imported_at: string;
  last_scanned_at: string;
  missing: boolean;
}

export interface TrackDJProfile {
  track_id: number;

  energy: number | null;
  intensity: number | null;
  darkness: number | null;
  melody: number | null;
  weirdness: number | null;
  mixability: number | null;
  confidence: number | null;
  chaos_level: number | null;

  set_role: string | null;
  transition_role: string | null;
  groove_type: string | null;
  vocal_density: string | null;
  breakdown_profile: string | null;
  drop_profile: string | null;
  bassline_type: string | null;
  lead_character: string | null;
  psy_substyle: string | null;
  festival_time: string | null;
  ritual_factor: string | null;
  crowd_risk: string | null;
  personal_status: string;

  tempo_bridge_score: number | null;
  bpm_jump_tolerance: string | null;
  can_cut_into: boolean | null;
  can_cut_out_of: boolean | null;
  dramatic_transition_candidate: boolean | null;

  notes: string | null;
  human_confirmed: boolean;
  updated_at: string | null;
}

export interface ArtistProfileRow {
  id: number;
  normalized_name: string;
  canonical_name: string;
  aliases_json: string | null;
  track_count: number;

  scene_cluster: string | null;
  primary_subgenre: string | null;
  secondary_subgenres_json: string | null;
  typical_bpm_min: number | null;
  typical_bpm_max: number | null;
  energy_min: number | null;
  energy_max: number | null;
  set_role_hints_json: string | null;
  confidence_label: string | null;
  needs_review: boolean;
  notes: string | null;
  raw_llm_json: string | null;
  last_enriched_at: string | null;

  created_at: string;
  updated_at: string;
}

export interface Tag {
  id: number;
  name: string;
  category: string | null;
}

export interface TrackTag {
  track_id: number;
  tag_id: number;
  source: string;
  confidence: number | null;
}

export interface FingerprintRow {
  track_id: number;
  chromaprint: string | null;
  duration_seconds: number | null;
  fingerprinted_at: string | null;
}

export interface DuplicateGroupRow {
  id: number;
  reason: string | null;
  status: string;
  created_at: string;
}

export interface DuplicateGroupTrackRow {
  group_id: number;
  track_id: number;
  role: string | null;
}

export interface DJSetRow {
  id: number;
  title: string;
  date: string | null;
  target_duration: number | null;
  target_bpm_arc: string | null;
  target_energy_arc: string | null;
  notes: string | null;
  created_at: string;
}

export interface SetTrackRow {
  set_id: number;
  position: number;
  track_id: number;
  note: string | null;
}

export interface TrackPairNoteRow {
  id: number;
  from_track_id: number;
  to_track_id: number;
  rating: number | null;
  transition_type: string | null;
  notes: string | null;
  created_at: string;
}

export interface PlayEventRow {
  id: number;
  track_id: number;
  set_id: number | null;
  played_at: string | null;
  context: string | null;
  crowd_reaction: number | null;
  notes: string | null;
}

export interface AuditLogRow {
  id: number;
  action: string;
  entity_type: string | null;
  entity_id: number | null;
  before_json: string | null;
  after_json: string | null;
  created_at: string;
}

export interface JobRow {
  id: number;
  kind: string;
  status: string;
  total: number;
  processed: number;
  message: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface SavedSearchRow {
  id: number;
  name: string;
  query: string;
  description: string | null;
  pinned: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

// ---- request-body types (ported from backend/app/schemas.py) ---------

export interface ProfileUpdate {
  energy?: number | null;
  intensity?: number | null;
  darkness?: number | null;
  melody?: number | null;
  weirdness?: number | null;
  mixability?: number | null;
  confidence?: number | null;
  chaos_level?: number | null;
  set_role?: string | null;
  transition_role?: string | null;
  groove_type?: string | null;
  vocal_density?: string | null;
  breakdown_profile?: string | null;
  drop_profile?: string | null;
  bassline_type?: string | null;
  lead_character?: string | null;
  psy_substyle?: string | null;
  festival_time?: string | null;
  ritual_factor?: string | null;
  crowd_risk?: string | null;
  personal_status?: string | null;
  tempo_bridge_score?: number | null;
  bpm_jump_tolerance?: string | null;
  can_cut_into?: boolean | null;
  can_cut_out_of?: boolean | null;
  dramatic_transition_candidate?: boolean | null;
  notes?: string | null;
  human_confirmed?: boolean | null;
}

export interface BatchProfileUpdate {
  track_ids: number[];
  profile: ProfileUpdate;
}

export interface TagCreate {
  name: string;
  category?: string | null;
}

export interface TagAssign {
  tag_id?: number | null;
  name?: string | null; // create-or-get by name if id absent
}

export interface DuplicateResolve {
  status: string; // resolved / ignored (default "resolved")
  master_track_id?: number | null;
  roles: Record<number, string>; // track_id -> master/duplicate/different_edit/not_duplicate
}

export interface SetCreate {
  title: string;
  date?: string | null;
  target_duration?: number | null;
  target_bpm_arc?: string | null;
  target_energy_arc?: string | null;
  notes?: string | null;
}

export interface SetTrackAdd {
  track_id: number;
  position?: number | null;
  note?: string | null;
}

export interface SetReorder {
  ordered_track_ids: number[];
}

export interface PairNoteCreate {
  from_track_id: number;
  to_track_id: number;
  rating?: number | null;
  transition_type?: string | null;
  notes?: string | null;
}

export interface RecommendQuery {
  after_track_id?: number | null;
  before_track_id?: number | null; // bridge target — track this leads INTO
  target_bpm?: number | null;
  target_energy?: number | null;
  target_role?: string | null;
  max_weirdness?: number | null;
  approved_only: boolean; // default false
  need_bridge: boolean; // default false
  limit: number; // default 20
}

export interface SavedSearchCreate {
  name: string;
  query: string;
  description?: string | null;
  pinned: boolean; // default false
}

export interface SavedSearchUpdate {
  name?: string | null;
  query?: string | null;
  description?: string | null;
  pinned?: boolean | null;
  sort_order?: number | null;
}

export interface ExportRequest {
  set_id?: number | null;
  track_ids?: number[] | null;
  filename?: string | null;
  overwrite: boolean; // default false
}

export interface ScanRequest {
  roots?: string[] | null; // override configured roots
}

export interface PlayLog {
  set_id?: number | null;
  context?: string | null;
  crowd_reaction?: number | null;
  notes?: string | null;
}
