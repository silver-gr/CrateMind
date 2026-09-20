/**
 * Parse a CrateMind search query into human-readable display chips.
 * Pure + display-only — mirrors the backend mini-syntax (services/search.py)
 * but never executes anything. Used to show "what this query means".
 */

export type ChipTone =
  | "cyan"
  | "blue"
  | "violet"
  | "chartreuse"
  | "magenta"
  | "amber"
  | "rose"
  | "muted";

export interface QueryChip {
  label: string;
  tone: ChipTone;
  negated?: boolean;
}

const NUMERIC = new Set(["collections", "energy", "darkness", "bpm", "intensity", "weirdness", "melody"]);
const RECENCY = new Set(["not_recent", "played_recently"]);

function tokenize(query: string): string[] {
  return query.match(/(?:[^\s"]+:"[^"]*"|"(?:\\"|[^"])*"|\S+)/g) ?? [];
}

function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

const BARE: Record<string, { label: string; tone: ChipTone }> = {
  remote_only: {label: "μόνο στις πηγές", tone: "cyan"},
  local_playable: {label: "διαθέσιμο τοπικά", tone: "cyan"},
  missing_file: {label: "λείπει αρχείο", tone: "rose"},
  soundcloud_like: {label: "SoundCloud Like", tone: "amber"},
  spotify_like: {label: "Spotify Like", tone: "chartreuse"},
  untagged: { label: "χωρίς tags", tone: "muted" },
  weapons: { label: "όπλα", tone: "chartreuse" },
  approved: { label: "εγκεκριμένα", tone: "cyan" },
  missing: { label: "λείπει", tone: "rose" },
  never_played: { label: "δεν παίχτηκε ποτέ", tone: "amber" },
  dramatic: { label: "δραματικό", tone: "magenta" },
  can_cut_into: { label: "δέχεται cut-in", tone: "cyan" },
  can_cut_out_of: { label: "βγαίνει με cut-out", tone: "cyan" },
  testing: { label: "δοκιμή", tone: "blue" },
};

function rangeLabel(field: string, spec: string): string {
  const label = field ? fieldLabel(field) : "";
  if (spec.endsWith("+")) return `${label} ≥ ${spec.slice(0, -1)}`;
  if (spec.endsWith("-")) return `${label} ≤ ${spec.slice(0, -1)}`;
  const m = spec.match(/^(\d+)\s*-\s*(\d+)$/);
  if (m) return `${label} ${m[1]}–${m[2]}`;
  return `${label} ${spec}`;
}

function numericTone(field: string): ChipTone {
  if (field === "darkness") return "violet";
  if (field === "energy") return "chartreuse";
  if (field === "bpm") return "blue";
  return "cyan";
}

function fieldChip(field: string, value: string): QueryChip {
  const f = field.toLowerCase();
  if (f === "added" || f === "created") {
    const name = f === "added" ? "Προστέθηκε" : "Δημιουργήθηκε";
    const days = value.match(/^(\d+)d?$/);
    const age = value.match(/^(\d+)-(\d+)d?$/);
    return { label: days ? `${name} ≤ ${days[1]}η` : age ? `${name} πριν ${age[1]}–${age[2]}η` : `${name} ${value.replace("..", " έως ")}`, tone: "blue" };
  }
  if (f === "bpm") return { label: `${rangeLabel("", value).trim()} BPM`.replace(/^ /, ""), tone: "blue" };
  if (NUMERIC.has(f)) return { label: rangeLabel(f, value), tone: numericTone(f) };
  if (RECENCY.has(f)) {
    const days = value.replace(/\D/g, "") || value;
    return {
      label: f === "not_recent" ? `όχι παιγμένο ${days}η` : `παίχτηκε ≤ ${days}η`,
      tone: "amber",
    };
  }
  if (f === "status") return { label: statusLabel(value), tone: value === "weapon" ? "chartreuse" : "cyan" };
  if (f === "role") return { label: `ρόλος ${valueLabel(value)}`, tone: "blue" };
  if (f === "break") return { label: `${valueLabel(value)} break`, tone: "cyan" };
  if (f === "tolerance") return { label: `ανοχή ${valueLabel(value)}`, tone: "amber" };
  if (f === "artist_review") return { label: `${fieldLabel(f)} ${valueLabel(value)}`, tone: "amber" };
  return { label: `${fieldLabel(f)} ${valueLabel(value)}`, tone: "muted" };
}

/** Parse a query string into display chips. */
export function parseQueryChips(query: string): QueryChip[] {
  const tokens = tokenize(query.trim());
  const chips: QueryChip[] = [];
  for (const raw of tokens) {
    const negated = raw.startsWith("-");
    const tok = negated ? raw.slice(1) : raw;
    if (!tok) continue;

    let chip: QueryChip;
    if (tok.includes(":")) {
      const [field, ...rest] = tok.split(":");
      chip = fieldChip(field, unquote(rest.join(":")));
    } else if (BARE[tok.toLowerCase()]) {
      const b = BARE[tok.toLowerCase()];
      chip = { label: b.label, tone: b.tone };
    } else {
      chip = { label: `"${tok}"`, tone: "muted" };
    }
    if (negated) {
      chip = { ...chip, label: `όχι ${chip.label}`, tone: "rose", negated: true };
    }
    chips.push(chip);
  }
  return chips;
}
import { fieldLabel, statusLabel, valueLabel } from "./labels";
