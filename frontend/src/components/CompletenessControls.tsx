import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "./ui/select";
import { LINK, serviceLabel } from "./collections/kit";
export function Choice({
  value,
  onChange,
  label,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  options: Record<string, string>;
}) {
  return (
    <Select value={value || "__any__"} onValueChange={(v) => onChange(v === "__any__" ? "" : v)}>
      <SelectTrigger aria-label={label} className="w-auto min-w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Object.entries(options).map(([v, text]) => (
          <SelectItem value={v || "__any__"} key={v}>
            {text}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
export async function identityRequest<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(
    "/api/identity/" + path,
    body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined,
  );
  if (!r.ok) {
    const e = await r.json();
    throw Error(e.detail || "Αποτυχία αιτήματος");
  }
  return r.json();
}
export const availabilityLabels: Record<string, string> = {
  LOCAL_PLAYABLE: "Τοπικό",
  LOCAL_AND_REMOTE: "Τοπικό + πηγές",
  LOCAL_MISSING_FILE: "Τοπική διαδρομή μη διαθέσιμη",
  REMOTE_ONLY_SOUNDCLOUD: "SoundCloud — χωρίς αποδεκτή τοπική σύνδεση",
  REMOTE_ONLY_SPOTIFY: "Spotify — χωρίς αποδεκτή τοπική σύνδεση",
  REMOTE_ONLY_BOTH: "SoundCloud + Spotify — χωρίς αποδεκτή τοπική σύνδεση",
  REMOTE_UNRESOLVED: "Ανεπίλυτη διαθεσιμότητα",
};
export type Recording = {
  local_assets?: {
    local_track_id: number;
    catalog_missing_flag: boolean;
    file_evidence: { state: string; verified_path_absent: boolean };
  }[];
  local_candidate_evidence?: {
    plausible_local_files: number;
    ambiguous_local_files: number;
    candidate_pairs: number;
    guarded_pairs: number;
    items: {
      local_entity_id: string;
      title: string;
      artist: string;
      class: string;
      score: number;
      guarded: boolean;
      block_reason: string | null;
      revoked: boolean;
      review_url: string;
    }[];
  };
  collection_family_count: number;
  raw_collection_occurrences: number;
  dj_personal_statuses?: string[];
  recording_id: string;
  title: string;
  artist: string;
  collection_count: number;
  recovery_state: string | null;
  availability: { state: string };
  likes: { id: string; name: string; service: string; provenance: { account?: string } }[];
  providers: { id: string; service: string; url: string; popularity: Record<string, number> | unknown[] }[];
};
const providerCount = (value: number | undefined) => (value == null ? "—" : value.toLocaleString("el-GR"));
export function ProviderCounts({ providers, inline = false }: { providers: Recording["providers"]; inline?: boolean }) {
  const Container = inline ? "span" : "div";
  return (
    <Container className={`${inline ? "inline-flex" : "flex"} flex-wrap gap-x-3 gap-y-1 text-xs`}>
      {providers.map((p) => (
        <span key={p.id}>
          <a href={p.url || undefined} target="_blank" rel="noreferrer" className={LINK}>
            {serviceLabel(p.service)}
          </a>
          {p.service === "soundcloud" && !Array.isArray(p.popularity) && (
            <span className="tabular-nums text-cm-text">
              {" "}
              · {providerCount(p.popularity.playback_count)} plays / {providerCount(p.popularity.likes_count)} likes /{" "}
              {providerCount(p.popularity.reposts_count)} reposts
            </span>
          )}
        </span>
      ))}
    </Container>
  );
}

export const fileCauseLabels: Record<string, string> = {
  present: "Παρόν στη διαδρομή",
  recorded_path_absent: "Απουσία στην καταχωρισμένη διαδρομή · ο φάκελος είναι προσβάσιμος",
  parent_path_absent: "Η καταχωρισμένη γονική διαδρομή απουσιάζει · πιθανή παλιά διαδρομή",
  root_unavailable: "Ρίζα μη διαθέσιμη — απουσία αρχείου ανεπιβεβαίωτη",
  root_unmounted: "Τόμος μη προσαρτημένος — απουσία αρχείου ανεπιβεβαίωτη",
  root_permission_denied: "Δεν επιτρέπεται πρόσβαση στη ρίζα",
  permission_denied: "Δεν επιτρέπεται πρόσβαση στο αρχείο",
  parent_permission_denied: "Δεν επιτρέπεται πρόσβαση στον φάκελο",
  unknown: "Άγνωστη αιτία",
  unknown_no_path: "Χωρίς καταχωρισμένη διαδρομή",
  not_regular_file: "Η διαδρομή δεν είναι κανονικό αρχείο",
};
