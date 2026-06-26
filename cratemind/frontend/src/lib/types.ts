export interface Track {
  id: number;
  absolute_path: string;
  file_name: string;
  extension: string;
  duration?: number | null;
  bitrate?: number | null;
  artist?: string | null;
  title?: string | null;
  album?: string | null;
  label?: string | null;
  year?: number | null;
  genre?: string | null;
  bpm?: number | null;
  key_text?: string | null;
  play_count: number;
  last_played_at?: string | null;
  missing: boolean;
}

export interface Profile {
  track_id: number;
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

export interface Tag {
  id: number;
  name: string;
  category?: string | null;
}

export interface TrackDetail {
  track: Track;
  profile: Profile | null;
  tags: Tag[];
}

export interface Job {
  id: number;
  kind: string;
  status: string;
  processed: number;
  message?: string | null;
  error?: string | null;
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
