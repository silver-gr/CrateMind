export type TrackCueKind = "entry" | "exit" | "cue";

export interface KeyStats {
  total: number;
  keyed: number;
  missing: number;
  unrecognized: number;
  metadata: number;
  djay: number;
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
  /** "cratemind" (detected from the audio) or "djay" (imported). */
  source?: string;
  /** Seconds: the track's phrase lines, sent only with CrateMind's own grid when it has a structure. */
  phrases?: number[] | null;
  /** CrateMind's own grid: the bar line's share of its bar vote (0.25 = a coin toss). Null for djay and for rows measured before it was stored. */
  downbeat_confidence?: number | null;
}

export interface Track {
  canonical_recording_id?: string;
  canonical_state?: string;
  canonical_soundcloud?: boolean;
  original_artist?: string | null;
  /** «Καθαρά ονόματα»: present only while the switch is on and the track has an engine name. */
  names_status?: NameStatus;
  /** The artist and title shown with the switch off (what `artist` and `title` replaced). */
  names_off?: { artist: string | null; title: string | null };
  original_title?: string | null;
  comment?: string | null;
  metadata_comments?: { kind: string; text: string; source_id?: string }[];
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
  /** Tempo of CrateMind's own beatgrid when it is confident and steady; second in the BPM order, after a manual BPM. */
  bpm_grid?: number | null;
  key_analyzed?: string | null;
  key_analyzed_confidence?: number | null;
  key_analyzed_method?: string | null;
  key_djay?: string | null;
  /** Whole-track integrated loudness (LUFS) and true peak (dBTP); null until measured (or silent). */
  loudness_lufs?: number | null;
  loudness_peak_db?: number | null;
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
  /** The genre of the track's artist, once confirmed in «Καλλιτέχνες», as a substyle: shown when the track has none. */
  artist_substyle?: string | null;
}

/** Additive fields returned by the Library list endpoint for confirmed matches. */
export interface SoundCloudListTrack extends Track {
  soundcloud_playback_count: number | null;
  soundcloud_likes_count: number | null;
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
  /** A real write only: the tracks in its scope, so the written profile is announced without listing them again. */
  track_ids?: number[];
}

/** GET /api/tracks/folders: a parent folder ("/" separators) and its track count. */
export interface FolderCount {
  path: string;
  count: number;
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
  display_title?: string | null;
  display_artist?: string | null;
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
  counter_source_id?: string;
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

/** POST/DELETE /tracks/{id}/bpm: the manual «×½ / ×2» fix, stored only in CrateMind. */
export interface BpmUpdate {
  track_id: number;
  bpm_consensus: number | null;
  bpm_consensus_sources: string | null;
  effective_bpm: number | null;
}

export interface Job {
  id: number;
  kind: string;
  status: string;
  processed: number;
  total?: number;
  message?: string | null;
  error?: string | null;
  created_at?: string;
  updated_at?: string;
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
  /** «Νέα έρευνα για όλους»: artists whose finding the configured model did not make, and that model. */
  research_again_artists: number;
  research_model: string | null;
}

export interface DJSet {
  id: number;
  title: string;
  date?: string | null;
  notes?: string | null;
}

/** GET /sets/summary: a set with its track count and total length («Διαχείριση sets»). */
export interface SetSummary extends DJSet {
  created_at: string;
  track_count: number;
  duration_seconds: number;
}

/** A logged play (GET /history); manual and set-logged rows have no deck, end or seconds. */
export interface PlayRecord {
  id: number;
  track_id: number;
  set_id: number | null;
  deck: "A" | "B" | null;
  played_at: string;
  ended_at: string | null;
  played_seconds: number | null;
  context: string | null;
}
export interface PlayHistoryEntry extends PlayRecord {
  track: Track;
}

/** A recording converted to AAC (.m4a); the WAV it came from is gone. */
export interface RecordingConverted {
  file: string;
  path: string;
  seconds: number;
  bytes: number;
}

/** A set recording's file in the export folder; `seconds` counts the audio written so far. */
export interface RecordingStatus {
  id: string;
  file: string;
  path: string;
  seconds: number;
  clipped: number;
}

/** One deck in a deck-rescue snapshot, in the mixer store's own units (lib/mixer.ts). */
export interface DeckRescueDeck {
  track_id: number;
  position_s: number;
  pitch: number;
  range: number;
  keylock: boolean;
  eq: { hi: number; mid: number; lo: number };
  filter: number;
  trim: number;
  loop: { start_s: number; end_s: number } | null;
}
/** The decks' last state as the page sends it (POST /deck-rescue); at least one deck is not null. */
export interface DeckRescueBody {
  v: 1;
  decks: { A: DeckRescueDeck | null; B: DeckRescueDeck | null };
  mixer: { volume: { A: number; B: number }; crossfader: number; master: number };
}
/** A stored snapshot: the server stamps `saved_at` (unix seconds). */
export interface DeckRescueSnapshot extends DeckRescueBody {
  saved_at: number;
}

export type { SetTransition } from "./transitions/types";

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
  /** Absolute musical fit 0–100 (tempo, key, style); null when nothing is comparable. */
  match: number | null;
  /** Canonical genre such as "Hi-Tech" or "Goa Trance". */
  style: string | null;
  /** Candidate BPM vs Track A in %, signed, one decimal. */
  bpm_delta_pct: number | null;
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
  /** A suggestion only; `reason` is a key for `keeperReasonLabel`. */
  suggested_keep?: { track_id: number; reason: string } | null;
}

export interface MovedTrack {
  track_id: number;
  artist?: string | null;
  title?: string | null;
  duration?: number | null;
  extension: string;
  absolute_path: string;
}

/** A missing track with the user's work on it, and the present file that is the same recording. */
export interface MovedPair { old: MovedTrack; new: MovedTrack }

export interface MovedTracks {
  pairs: MovedPair[];
  missing_with_data: number;
  not_checked: number;
  ambiguous: number;
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

/** One crate's matches for Library grouping (`GET /searches/membership`). */
export interface SearchMembership {
  id: number;
  name: string;
  query: string;
  track_ids: number[];
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

/** One automatic link (local file ↔ remote record) or fold (two remote records) from GET /identity/automatic-links. */
export interface AutomaticLinkRow {
  left_id: string;
  left_service: string;
  left_title: string | null;
  left_artist: string | null;
  left_duration_ms: number | null;
  left_permalink: string | null;
  left_file_name: string | null;
  right_id: string;
  right_service: string;
  right_title: string | null;
  right_artist: string | null;
  right_duration_ms: number | null;
  right_permalink: string | null;
  right_file_name: string | null;
  rule: string;
  accepted_at: string;
  batch: string | null;
  delta_seconds: number | null;
}
export interface AutomaticLinkBatch { id: string | null; link: number; fold: number; accepted_at: string }
export interface AutomaticLinks {
  total: number;
  items: AutomaticLinkRow[];
  rules: { link: Record<string, number>; fold: Record<string, number> };
  batches: AutomaticLinkBatch[];
}

// ---------------------------------------------------------------- «Καθαρά ονόματα»
// Mirrors of backend/app/api/names_status.py and names_decisions.py: change both sides together.
export type NameStatus = "sure" | "look" | "open" | "none" | "hand";
export interface NamesRunState { state: "idle" | "queued" | "running"; cause: string | null; job_id: number | null }
export interface NamesLastRun { finished_at: string; ruleset: string; cause: string; written: number; seconds: number }
export interface NamesStatus {
  on: boolean;
  can_turn_on: boolean;
  /** Greek; set while `can_turn_on` is false. */
  blocked_reason: string | null;
  ruleset: string;
  present: number;
  named: number;
  /** Present tracks whose raw tags were never read: «κάνε σάρωση». */
  unread: number;
  unreadable: number;
  counts: Record<NameStatus, number>;
  accepted: number;
  /** Rows whose name differs from the switch-off name (`names:changed`). */
  changed: number;
  /** Rows with an unacknowledged change (`names:new`). */
  new: number;
  run: NamesRunState;
  last_run: NamesLastRun | null;
  refusal: "key_version" | null;
  refusal_text: string | null;
}
export interface NameWhyStep { rule: string; field: string; text: string }
export interface NameWhyFact { label: string; value: string }
export interface NameWhyDecision {
  id: number;
  kind: string;
  source: string;
  source_text: string;
  undoable: boolean;
  created_at: string;
}
export interface NameWhyChange {
  prev_artist: string | null;
  prev_title: string | null;
  prev_folder: string | null;
  changed_at: string | null;
  cause_text: string;
}
export interface NameWhy {
  track_id: number;
  on: boolean;
  /** False: unread, missing or no run yet; every field below is then empty. */
  has_row: boolean;
  status: NameStatus | null;
  status_text: string;
  artist: string;
  title: string;
  folder: string;
  off_artist: string;
  off_title: string;
  open_question: string | null;
  open_code?: string;
  steps: NameWhyStep[];
  facts: NameWhyFact[];
  raw: {
    artist: string | null;
    title: string | null;
    album: string | null;
    track_no: string | null;
    state: "ok" | "unreadable" | null;
  };
  accepted: boolean;
  decision: NameWhyDecision | null;
  change: NameWhyChange | null;
  note: string | null;
  ruleset: string;
}
export interface NameExampleTrack { track_id: number; artist: string; title: string; off_artist: string; off_title: string }
export interface NameAnswer {
  id: number;
  kind: string;
  scope: string;
  track_id: number | null;
  value: string;
  /** Greek: what was answered, readable without the question. */
  text: string;
  source: string;
  provisional: boolean;
  created_at: string;
  /** «άλλαξε N κομμάτια»; null until the run after the answer has finished. */
  reach: number | null;
  undoable: boolean;
  track: NameExampleTrack | null;
}
export interface NameQuestion {
  /** kind + "|" + scope */
  id: string;
  kind: string;
  scope: string;
  section: "open" | "pattern";
  /** Internal; never shown. */
  code: string;
  question: string;
  options: { letter: string; text: string }[];
  /** «Άλλο…» */
  allows_text: boolean;
  text_hint: string | null;
  recommended: string | null;
  why: string | null;
  track_count: number;
  examples: NameExampleTrack[];
  answer: NameAnswer | null;
}
export interface NameQuestions { open: NameQuestion[]; patterns: NameQuestion[]; has_run: boolean; run: NamesRunState }
export interface NameAnswerInput { kind: string; scope: string; letter?: string; text?: string }
export type NameReviewSection = "look" | "none" | "changed" | "open";
export interface NameReviewRow {
  track_id: number;
  artist: string;
  title: string;
  folder: string;
  off_artist: string;
  off_title: string;
  status: string;
  /** The deciding rule (look) or the cause key (changed). */
  group: string;
  reason: string;
  accepted: boolean;
  prev_artist: string | null;
  prev_title: string | null;
  prev_folder: string | null;
  changed_at: string | null;
  cause_text: string;
}
export interface NameReview {
  section: string;
  total: number;
  groups: { key: string; label: string; count: number }[];
  items: NameReviewRow[];
  offset: number;
  limit: number;
}
export interface NameCount { count: number; dry_run: boolean }
