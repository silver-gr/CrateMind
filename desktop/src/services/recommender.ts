// Transparent next-track recommender. Not "AI" — a clear weighted scorer
// that always shows WHY a track was suggested. Port of
// backend/app/services/recommender.py.
//
// T3 owns pure scoring only; the recommend-next endpoint's context assembly
// (backend/app/api/sets.py:180-219 — pulling previous/next track, recently
// played ids, etc. from a DJSet) belongs to T8.

import type { DatabaseSync } from "node:sqlite";
import type { Track, TrackDJProfile, TrackPairNoteRow } from "../types/models.ts";
import { keyFit } from "./camelot.ts";

// ---- Context -----------------------------------------------------------

/** Verbatim mirror of recommender.py's Context dataclass. All fields are
 * optional (mirroring Python's per-field defaults) — recommend() applies
 * the same defaults Python does. */
export interface Context {
  previous_key?: string | null;
  previous_bpm?: number | null;
  // bridge target — the track the candidate must LEAD INTO (Track B)
  next_key?: string | null;
  next_bpm?: number | null;
  after_track_id?: number | null;
  before_track_id?: number | null;
  target_bpm?: number | null;
  target_energy?: number | null;
  target_role?: string | null;
  max_weirdness?: number | null;
  approved_only?: boolean;
  need_bridge?: boolean;
  exclude_ids?: Set<number>;
  recently_played_ids?: Set<number>;
}

/** Flat recommend-next output row — the Contract Matrix shape (no nested
 * track, no warnings). */
export interface RecommendationOut {
  track_id: number;
  artist: string | null;
  title: string | null;
  bpm: number | null;
  key: string | null;
  bpm_is_analyzed: boolean;
  key_is_analyzed: boolean;
  energy: number | null;
  set_role: string | null;
  personal_status: string;
  score: number;
  reasons: string[];
}

function isBridge(ctx: Context): boolean {
  return ctx.next_bpm != null || ctx.next_key != null;
}

// ---- effective bpm/key --------------------------------------------------

/** Tag BPM when present, else the analyzed estimate. Port of
 * recommender.py:effective_bpm. */
export function effectiveBpm(t: Track): number | null {
  return t.bpm ?? t.bpm_analyzed;
}

/** Tag key when present, else the analyzed estimate. Port of
 * recommender.py:effective_key. */
export function effectiveKey(t: Track): string | null {
  return t.key_text || t.key_analyzed || null;
}

// ---- number formatting (Python's `:g` format, precision 6) --------------

/** Formats a number the way Python's `f"{n:g}"` does (used only for the BPM
 * reason strings, so the transparency text reads identically to the
 * FastAPI backend). */
function formatG(n: number): string {
  if (n === 0) return "0";
  const precision = 6;
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const exp = Math.floor(Math.log10(abs));
  if (exp < -4 || exp >= precision) {
    let mantissa = (abs / Math.pow(10, exp)).toPrecision(precision);
    if (mantissa.includes(".")) {
      mantissa = mantissa.replace(/0+$/, "").replace(/\.$/, "");
    }
    const expSign = exp < 0 ? "-" : "+";
    const expStr = String(Math.abs(exp)).padStart(2, "0");
    return `${sign}${mantissa}e${expSign}${expStr}`;
  }
  const decimals = Math.max(0, precision - 1 - exp);
  let fixed = abs.toFixed(decimals);
  if (fixed.includes(".")) {
    fixed = fixed.replace(/0+$/, "").replace(/\.$/, "");
  }
  return `${sign}${fixed}`;
}

// ---- fit scorers ----------------------------------------------------------

function bpmFit(candBpm: number | null, target: number | null): [number, string | null] {
  if (candBpm === null || target === null) return [0.0, null];
  const diff = Math.abs(candBpm - target);
  if (diff <= 1) return [10.0, `BPM close: ${formatG(target)}->${formatG(candBpm)}`];
  if (diff <= 3) return [6.0, `BPM near: ${formatG(target)}->${formatG(candBpm)}`];
  if (diff <= 6) return [2.0, `BPM reachable: ${formatG(target)}->${formatG(candBpm)}`];
  return [-4.0, `BPM far: ${formatG(target)}->${formatG(candBpm)}`];
}

function energyFit(candE: number | null, target: number | null): [number, string | null] {
  if (candE === null || target === null) return [0.0, null];
  const diff = Math.abs(candE - target);
  if (diff === 0) return [8.0, `energy on target: ${target}`];
  if (diff === 1) return [5.0, `energy near: ${candE} vs ${target}`];
  if (diff === 2) return [1.0, `energy ok: ${candE} vs ${target}`];
  return [-3.0, `energy off: ${candE} vs ${target}`];
}

function reasonPrefix(score: number): string {
  return score >= 0 ? "+ " : "- ";
}

function scoreTrack(
  track: Track,
  prof: TrackDJProfile | undefined,
  ctx: Context,
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  let [s, r] = bpmFit(effectiveBpm(track), ctx.target_bpm || ctx.previous_bpm || null);
  score += s;
  if (r) reasons.push(reasonPrefix(s) + r);

  let kf = keyFit(ctx.previous_key ?? null, effectiveKey(track));
  score += kf.score;
  if (kf.reason) reasons.push(reasonPrefix(kf.score) + kf.reason);

  // bridge: candidate must also LEAD INTO the next track (Track B)
  if (isBridge(ctx)) {
    [s, r] = bpmFit(effectiveBpm(track), ctx.next_bpm ?? null);
    score += s;
    if (r) reasons.push(reasonPrefix(s) + "→ into B " + r);

    kf = keyFit(effectiveKey(track), ctx.next_key ?? null);
    score += kf.score;
    if (kf.reason) reasons.push(reasonPrefix(kf.score) + "→ into B " + kf.reason);
  }

  const energy = prof?.energy ?? null;
  [s, r] = energyFit(energy, ctx.target_energy ?? null);
  score += s;
  if (r) reasons.push(reasonPrefix(s) + r);

  if (ctx.target_role && prof?.set_role) {
    if (prof.set_role.toLowerCase().includes(ctx.target_role.toLowerCase())) {
      score += 8;
      reasons.push(`+ role match: ${ctx.target_role}`);
    }
  }

  const status = prof?.personal_status ?? "unknown";
  if (status === "weapon") {
    score += 12;
    reasons.push("+ weapon");
  } else if (status === "approved") {
    score += 8;
    reasons.push("+ approved");
  } else if (status === "testing") {
    score += 2;
    reasons.push("+ testing");
  }

  if (
    (ctx.need_bridge ?? false) &&
    prof?.transition_role &&
    prof.transition_role.toLowerCase().includes("bridge")
  ) {
    score += 10;
    reasons.push("+ bridge candidate");
  }

  if (prof?.tempo_bridge_score) {
    score += prof.tempo_bridge_score * 0.5;
    reasons.push(`+ tempo bridge score ${prof.tempo_bridge_score}`);
  }

  // freshness vs recently played
  const recentlyPlayed = ctx.recently_played_ids ?? new Set<number>();
  if (recentlyPlayed.has(track.id)) {
    score -= 8;
    reasons.push("- played recently");
  } else if (track.play_count === 0) {
    score += 2;
    reasons.push("+ fresh (never played)");
  }

  const weird = prof?.weirdness ?? null;
  if (weird !== null && ctx.max_weirdness !== null && ctx.max_weirdness !== undefined && weird > ctx.max_weirdness) {
    score -= 10;
    reasons.push(`- weirdness ${weird} > max ${ctx.max_weirdness}`);
  }

  return { score, reasons };
}

// ---- pair-note transition memory ------------------------------------------

function notePhrase(n: TrackPairNoteRow, lead: string): string {
  const bits = [lead];
  if (n.transition_type) bits.push(n.transition_type);
  if (n.rating !== null && n.rating !== undefined) bits.push(`${n.rating}/5`);
  return bits.join(" ");
}

// ---- recommend --------------------------------------------------------

/** Ranks all non-missing, non-retired/avoid tracks against `ctx`, returning
 * the top `limit` with transparent scoring reasons. Port of
 * recommender.py:recommend. */
export function recommend(db: DatabaseSync, ctx: Context, limit = 20): RecommendationOut[] {
  const tracks = db.prepare("SELECT * FROM tracks WHERE missing = 0").all() as unknown as Track[];
  const profileRows = db.prepare("SELECT * FROM track_dj_profile").all() as unknown as TrackDJProfile[];
  const profiles = new Map<number, TrackDJProfile>();
  for (const p of profileRows) profiles.set(p.track_id, p);

  const excludeIds = ctx.exclude_ids ?? new Set<number>();
  const approvedOnly = ctx.approved_only ?? false;

  // Pre-fetch transition memory for the A->candidate and candidate->B legs.
  const fromA = new Map<number, TrackPairNoteRow>();
  const toB = new Map<number, TrackPairNoteRow>();
  if (ctx.after_track_id != null) {
    const rows = db
      .prepare("SELECT * FROM track_pair_notes WHERE from_track_id = ?")
      .all(ctx.after_track_id) as unknown as TrackPairNoteRow[];
    for (const n of rows) fromA.set(n.to_track_id, n);
  }
  if (ctx.before_track_id != null) {
    const rows = db
      .prepare("SELECT * FROM track_pair_notes WHERE to_track_id = ?")
      .all(ctx.before_track_id) as unknown as TrackPairNoteRow[];
    for (const n of rows) toB.set(n.from_track_id, n);
  }

  const results: RecommendationOut[] = [];
  for (const track of tracks) {
    if (excludeIds.has(track.id)) continue;
    const prof = profiles.get(track.id);
    const status = prof?.personal_status ?? "unknown";
    if (status === "retired" || status === "avoid") continue;
    if (approvedOnly && status !== "approved" && status !== "weapon") continue;

    const { score: baseScore, reasons } = scoreTrack(track, prof, ctx);
    let score = baseScore;

    // transition memory: did you note these pairings worked before?
    const noteA = fromA.get(track.id);
    if (noteA !== undefined) {
      score += 6 + (noteA.rating ?? 0);
      reasons.push("+ " + notePhrase(noteA, "noted A→this worked:"));
    }
    const noteB = toB.get(track.id);
    if (noteB !== undefined) {
      score += 6 + (noteB.rating ?? 0);
      reasons.push("+ " + notePhrase(noteB, "noted this→B worked:"));
    }

    results.push({
      track_id: track.id,
      artist: track.artist,
      title: track.title,
      bpm: effectiveBpm(track),
      key: effectiveKey(track),
      bpm_is_analyzed: track.bpm === null && track.bpm_analyzed !== null,
      key_is_analyzed: !track.key_text && track.key_analyzed !== null,
      energy: prof?.energy ?? null,
      set_role: prof?.set_role ?? null,
      personal_status: status,
      score: Math.round(score * 100) / 100,
      reasons,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
