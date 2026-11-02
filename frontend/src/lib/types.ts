export type TrackCueKind = "entry" | "exit" | "cue";

export interface KeyStats {
  total: number;
  keyed: number;
  missing: number;
  unrecognized: number;
  metadata: number;
  analyzed: number;
  counts: Record<string, number>;
}

export interface TrackCueCreate {
  position_ms: number;
  kind: TrackCueKind;
  label?: string | null;
}

export type TrackCueUpdate = Partial<TrackCueCreate>;

export interface TrackCue {
  id: number;
  track_id: number;
  position_ms: number;
  kind: TrackCueKind;
  label: string | null;
  created_at: string;
  updated_at: string;
}

/** GET /api/tracks/{id}/beatgrid (Lane J). `anchor_s` is a downbeat time; `beats` is set when the grid is not straight. */
export interface BeatGridDto {
  bpm: number;
  straight: boolean;
  anchor_s: number | null;
  first_downbeat_index: number | null;
  beats: number[] | null;
}

export interface Track {
  canonical_recording_id?: string;
  canonical_state?: string;
  canonical_soundcloud?: boolean;
  original_artist?: string | null;
  original_title?: string | null;
  display_bpm?: number | null;
  display_bpm_hint?: number | null;
  metadata_provenance?: Record<string, { basis: string; source_id?: string; inferred?: boolean; match_score?: number; accepted_identity?: boolean }>;
  id: number;
  absolute_path: string;
  file_name: string;
  extension: string;
  duration?: number | null;
  bitrate?: number | null;
  artist?: string | null;
  artist_normalized?: string | null;
  title?: string | null;
  album?: string | null;
  label?: string | null;
  year?: number | null;
  genre?: string | null;
  bpm?: number | null;
  key_text?: string | null;
  bpm_analyzed?: number | null;
  bpm_analyzed_raw?: number | null;
  bpm_analyzed_confidence?: number | null;
  bpm_analyzed_method?: string | null;
  bpm_consensus?: number | null;
  bpm_consensus_sources?: string | null;
  key_analyzed?: string | null;
  key_analyzed_confidence?: number | null;
  analyzed_at?: string | null;
  analysis_error?: string | null;
  play_count: number;
  last_played_at?: string | null;
  imported_at?: string | null; // when CrateMind imported the row (DB time)
  modified_time?: number | null; // filesystem st_mtime (unix seconds)
  created_time?: number | null; // filesystem creation time (unix seconds)
  missing: boolean;
  // list-summary extras (merged in by the /tracks endpoint; null when a track has no profile yet)
  personal_status?: string | null;
  energy?: number | null;
  darkness?: number | null;
  valence?: number | null;
  melody?: number | null;
  weirdness?: number | null;
  set_role?: string | null;
  psy_substyle?: string | null;
  artist_prefill?: ArtistPrefill | null;
}

/** Additive fields returned by the Library list endpoint for confirmed matches. */
export interface SoundCloudListTrack extends Track {
  soundcloud_playback_count: number | null;
  soundcloud_likes_count: number | null;
}

export interface ArtistPrefill {
  artist_profile_id: number;
  canonical_name: string;
  scene_cluster?: string | null;
  primary_subgenre?: string | null;
  secondary_subgenres?: string[] | null;
  energy_range?: [number | null, number | null] | null;
  set_role_hints?: string[] | null;
  confidence_label?: string | null;
  needs_review: boolean;
  bpm_conflict?: boolean | null;
  notes?: string | null;
  reason?: string | null;
}

export interface Profile {
  track_id: number;
  energy?: number | null;
  intensity?: number | null;
  darkness?: number | null;
  valence?: number | null;
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

export interface Tag {
  id: number;
  name: string;
  category?: string | null;
}

/** A user vocabulary. Its values are tags named `key:value`; `id` of a value is the Tag id. */
export interface FacetValue {
  id: number;
  value: string;
  count: number;
}

export interface Facet {
  id: number;
  key: string;
  label: string;
  multi: boolean;
  sort_order: number;
  values: FacetValue[];
}

/** POST /api/tracks/batch-profile. Send either `track_ids` or `query` ("" = whole library), never both. */
export interface BatchEditRequest {
  track_ids?: number[];
  query?: string;
  profile?: Partial<Profile>;
  add_tag_ids?: number[];
  remove_tag_ids?: number[];
  dry_run?: boolean;
}

export interface BatchEditResult {
  updated: number;
  matched: number;
  replaced: number;
  dry_run: boolean;
}

export interface TrackDetail {
  track: Track;
  profile: Profile | null;
  tags: Tag[];
}

export interface SoundCloudTrackSnapshot {
  soundcloud_track_id: number;
  urn?: string | null;
  permalink_url?: string | null;
  title?: string | null;
  uploader_id?: number | null;
  uploader_username?: string | null;
  uploader_permalink_url?: string | null;
  duration_ms?: number | null;
  full_duration_ms?: number | null;
  genre?: string | null;
  tag_list?: string | null;
  description?: string | null;
  label_name?: string | null;
  release_date?: string | null;
  created_at?: string | null;
  display_date?: string | null;
  liked_at?: string | null;
  liked_by_me?: boolean;
  likes_count?: number | null;
  reposts_count?: number | null;
  playback_count?: number | null;
  comment_count?: number | null;
  download_count?: number | null;
  downloadable?: boolean | null;
  artwork_url?: string | null;
  waveform_url?: string | null;
  available: boolean;
  last_seen_run_id?: string | null;
  fetched_at?: string | null;
}

export interface SoundCloudMatch {
  track_id: number;
  soundcloud_track_id: number;
  confidence: number;
  method: string;
  reasons: string[];
  matched_at?: string | null;
  confirmed_at?: string | null;
}

export interface SoundCloudCandidate {
  track_id: number;
  soundcloud_track_id: number;
  score: number;
  reasons: string[];
  status: "pending" | "accepted" | "rejected";
  evaluated_at?: string | null;
  decided_at?: string | null;
  soundcloud_track: SoundCloudTrackSnapshot;
}

export interface SoundCloudConfirmedMetadata {
  track: SoundCloudTrackSnapshot;
  match: SoundCloudMatch;
}

/**
 * Detail-only response. Track list responses deliberately remain `Track[]` and
 * do not carry provider snapshots.
 */
export interface SoundCloudTrackDetail extends TrackDetail {
  canonical?: import("../components/CanonicalTrackCard").Canonical;
  legacy_soundcloud?: SoundCloudConfirmedMetadata | null;
  soundcloud: SoundCloudConfirmedMetadata | null;
  soundcloud_candidates: SoundCloudCandidate[];
}

export interface SoundCloudSummary {
  snapshots: number;
  available: number;
  unavailable: number;
  confirmed_local_tracks: number;
  pending_candidates: number;
  pending_local_tracks: number;
  rejected_candidates: number;
  unmatched_soundcloud_tracks: number;
  last_import_run_id?: string | null;
}

export interface SoundCloudReviewLocalTrack {
  id: number;
  artist?: string | null;
  title?: string | null;
  file_name: string;
  duration?: number | null;
}

export interface SoundCloudReviewItem {
  local_track: SoundCloudReviewLocalTrack;
  candidate: SoundCloudCandidate;
}

export interface SoundCloudReviewPage {
  total: number;
  offset: number;
  limit: number;
  items: SoundCloudReviewItem[];
}

export interface SoundCloudImportResult {
  received: number;
  inserted: number;
  updated: number;
  auto_confirmed: number;
  pending_candidates: number;
  malformed: number;
  completed: boolean;
}

export interface Job {
  id: number;
  kind: string;
  status: string;
  processed: number;
  total?: number;
  message?: string | null;
  error?: string | null;
}

export interface DjayImportSample { uuid: string; file_name: string; reason: string }

export interface DjayImportReport {
  library: string;
  metadata: string;
  items: number;
  matched: number;
  ambiguous: number;
  unmatched: number;
  edited: number;
  non_straight: number;
  unknown_version: number;
  denied: number;
  transient: number;
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  samples: Record<string, DjayImportSample[]>;
}

export interface DjayImportStatus {
  sources: { library: string; metadata: string };
  job: Job | null;
  report: DjayImportReport | null;
  report_at: string | null;
  grids: number;
}

export interface BpmAnalysisSummary {
  total: number;
  trusted_metadata: number;
  local_analyzed: number;
  reccobeats_analyzed: number;
  reccobeats_failed: number;
  getsongbpm_matches: number;
  getsongbpm_misses: number;
  provider_disagreements: number;
  consensus: number;
  needs_review: number;
  manual_resolutions: number;
  actionable_conflicts: number;
  bulk_getsongbpm_enabled: boolean;
}

export interface BpmCandidate {
  source: "metadata" | "local" | "essentia" | "reccobeats" | "getsongbpm" | "cyanite";
  value: number;
  confidence?: number | null;
  trusted: boolean;
}

export interface BpmReviewTrack {
  id: number;
  artist?: string | null;
  title?: string | null;
  file_name: string;
  consensus?: number | null;
  consensus_source?: string | null;
  disagreement_percent?: number | null;
  needs_review?: boolean | null;
  candidates: BpmCandidate[];
}

export interface BpmReviewPage {
  total: number;
  offset: number;
  limit: number;
  items: BpmReviewTrack[];
}

export interface ArtistResearch {
  workflow: string;
  status: "classified" | "outside_list" | "unresolved";
  sources: { url: string; evidence: string }[];
  outside_genre?: string | null;
  manual_genre?: string;
  reason: string;
  model: string;
  reasoning_effort: string;
}

export interface ArtistProfile {
  review?: { state: string; error?: string | null; current: ArtistProfile; candidate?: Partial<ArtistProfile> | null; confirmed_choice?: string | null };
  research?: ArtistResearch | null;
  research_pending?: boolean;
  id: number;
  normalized_name: string;
  canonical_name: string;
  aliases_json?: string | null;
  track_count: number;
  scene_cluster?: string | null;
  primary_subgenre?: string | null;
  secondary_subgenres_json?: string | null;
  typical_bpm_min?: number | null;
  typical_bpm_max?: number | null;
  energy_min?: number | null;
  energy_max?: number | null;
  set_role_hints_json?: string | null;
  confidence_label?: string | null;
  needs_review: boolean;
  notes?: string | null;
  raw_llm_json?: string | null;
  last_enriched_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface ArtistStats {
  total_artists: number;
  active_artists: number;
  unenriched_artists: number;
  needs_review_artists: number;
}

export interface DJSet {
  id: number;
  title: string;
  date?: string | null;
  notes?: string | null;
}

export interface SetTrackRow {
  position: number;
  note?: string | null;
  track: Track;
  profile: Profile | null;
}

export interface SetAnalysis {
  track_count: number;
  total_duration: number;
  bpm_curve: (number | null)[];
  energy_curve: (number | null)[];
  darkness_curve: (number | null)[];
  repeated_artists: Record<string, number>;
  risky_tracks: { position: number; track_id: number; label: string }[];
  not_approved: { position: number; track_id: number; label: string }[];
  transition_warnings: { from_position: number; message: string }[];
}

export interface Recommendation {
  track_id: number;
  artist?: string | null;
  title?: string | null;
  bpm?: number | null;
  key?: string | null;
  bpm_is_analyzed?: boolean;
  key_is_analyzed?: boolean;
  energy?: number | null;
  set_role?: string | null;
  personal_status: string;
  score: number;
  reasons: string[];
}

export interface DuplicateGroup {
  id: number;
  reason?: string | null;
  status: string;
  tracks: {
    track_id: number;
    role?: string | null;
    artist?: string | null;
    title?: string | null;
    duration?: number | null;
    bpm?: number | null;
    extension: string;
    absolute_path: string;
  }[];
}

export interface SavedSearch {
  id: number;
  name: string;
  query: string;
  description?: string | null;
  pinned: boolean;
  sort_order: number;
  count: number;
}

export interface PairNote {
  id: number;
  from_track_id: number;
  to_track_id: number;
  rating?: number | null;
  transition_type?: string | null;
  notes?: string | null;
}

export const STATUS_VALUES = [
  "unknown", "testing", "approved", "weapon", "retired", "avoid",
];

export const SET_ROLES = [
  "builder", "bridge", "peak", "reset", "closer", "afterhours",
];
