import { useEffect, useMemo, useState, type ReactNode } from "react";
import { isDesktopRuntime } from "../lib/desktopRuntime";
import type {
  SoundCloudCandidate,
  SoundCloudConfirmedMetadata,
  SoundCloudMatch,
  SoundCloudTrackSnapshot,
} from "../lib/types";
import { Link2, Radio } from "../lib/icons";
import { Artwork } from "./ui/Artwork";
import { GlassPanel } from "./ui/GlassPanel";
import { NumberCount } from "./ui/NumberCount";
import { SectionHeader } from "./ui/SectionHeader";
import { SmartChip } from "./ui/SmartChip";

function formatDuration(milliseconds?: number | null) {
  if (milliseconds == null) return "μη διαθέσιμη";
  const seconds = Math.round(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatDate(value?: string | null) {
  if (!value) return "μη διαθέσιμη";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("el-GR");
}

function formatConfidence(value: number) {
  const percent = value <= 1 ? value * 100 : value;
  return `${percent.toFixed(percent % 1 === 0 ? 0 : 1)}%`;
}

function ProviderArtwork({ snapshot, fallbackSeed }: {
  snapshot: SoundCloudTrackSnapshot;
  fallbackSeed: number;
}) {
  const [failed, setFailed] = useState(false);
  const artworkUrl = isDesktopRuntime() ? null : snapshot.artwork_url;

  useEffect(() => setFailed(false), [artworkUrl]);

  if (!artworkUrl || failed) {
    return <Artwork seed={fallbackSeed} className="h-20 w-20 rounded-xl" />;
  }

  return (
    <img
      src={artworkUrl}
      alt=""
      onError={() => setFailed(true)}
      className="h-20 w-20 shrink-0 rounded-xl border border-cm-contrast/10 object-cover"
    />
  );
}

const matchMethodLabels = new Map([
  ["canonical_recording", "Κανονική ταυτότητα CrateMind"],
  ["comment_identity", "Στοιχεία SoundCloud στο σχόλιο αρχείου"],
  ["exact_metadata", "Σύγκριση μεταδεδομένων"],
  ["manual_review", "Χειροκίνητη επιβεβαίωση"],
]);

function TrackIdentity({ track }: { track: SoundCloudTrackSnapshot }) {
  const title = track.display_title === undefined ? track.title : track.display_title;
  return (
    <>
      <p className="truncate text-sm font-medium text-cm-text">
        {title || "Άτιτλο κομμάτι SoundCloud"}
      </p>
      <p className="truncate text-xs text-cm-muted">
        {track.display_artist || (track.uploader_username
          ? `Λογαριασμός ανάρτησης · ${track.uploader_username}`
          : "Άγνωστος καλλιτέχνης")}
      </p>
    </>
  );
}

function SourceDetails({ rawTitle, method, reasons, children }: {
  rawTitle: SoundCloudTrackSnapshot["title"];
  method?: SoundCloudMatch["method"];
  reasons: string[];
  children?: ReactNode;
}) {
  if (!rawTitle && !method && !reasons.length && !children) return null;
  return (
    <details className="mt-2 text-xs text-cm-muted">
      <summary className="cursor-pointer">Στοιχεία πηγής</summary>
      {children}
      <div className="mt-2 space-y-1 wrap-anywhere text-[11px] leading-snug">
        {rawTitle && <p>Αρχικός τίτλος · {rawTitle}</p>}
        {method && <p>Τρόπος επιβεβαίωσης · {matchMethodLabels.get(method) ?? "Σύνδεση SoundCloud"}</p>}
        {reasons.length > 0 && (
          <ul className="list-disc space-y-1 pl-4 text-cm-faint">
            {reasons.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
        )}
      </div>
    </details>
  );
}

function TrackFacts({ track }: { track: SoundCloudTrackSnapshot }) {
  return (
    <div className="mt-2 flex flex-wrap justify-center gap-1.5 text-[11px] text-cm-faint">
      <span className="max-w-full wrap-anywhere">{track.genre || "χωρίς είδος"}</span>
      <span>·</span>
      <span>διάρκεια {formatDuration(track.full_duration_ms ?? track.duration_ms)}</span>
    </div>
  );
}

function TrackStats({ track }: { track: SoundCloudTrackSnapshot }) {
  return (
    <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-y border-cm-line/20 py-3 text-[11px]">
      <div><span className="text-cm-faint">Ανέβηκε</span><p className="text-cm-text">{formatDate(track.display_date ?? track.created_at)}</p></div>
      <div><span className="text-cm-faint">Στα αγαπημένα</span><p className="text-cm-text">{track.liked_by_me === true ? "Ναι" : track.liked_by_me === false ? "Όχι στο στιγμιότυπο" : formatDate(track.liked_at)}</p>{track.liked_by_me && track.liked_at && <p>{formatDate(track.liked_at)}</p>}</div>
      {[
        { label: "Μου αρέσει", value: track.likes_count },
        { label: "Κοινοποιήσεις", value: track.reposts_count },
        { label: "Ακροάσεις", value: track.playback_count },
        { label: "Σχόλια", value: track.comment_count },
      ].map(({ label, value }) => (
        <div key={label}>
          <span className="text-cm-faint">{label}</span>
          <p className="font-mono text-cm-text">
            {value == null ? "μη διαθέσιμο" : <NumberCount value={value} />}
          </p>
        </div>
      ))}
    </div>
  );
}

function PendingCandidate({ candidate, fallbackSeed, onReview }: {
  candidate: SoundCloudCandidate;
  fallbackSeed: number;
  onReview?: () => void;
}) {
  const track = candidate.soundcloud_track;
  return (
    <div className="flex gap-3">
      <ProviderArtwork snapshot={track} fallbackSeed={fallbackSeed} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <SmartChip tone="amber">Για έλεγχο</SmartChip>
          <span className="font-mono text-[11px] tabular-nums text-cm-amber">
            {formatConfidence(candidate.score)}
          </span>
        </div>
        <div className="mt-2">
          <TrackIdentity track={track} />
        </div>
        {onReview && (
          <button
            type="button"
            onClick={onReview}
            className="mt-2 cursor-pointer text-xs font-medium text-cm-cyan transition hover:text-cm-blue"
          >
            Άνοιγμα ελέγχου SoundCloud
          </button>
        )}
        <SourceDetails rawTitle={track.title} reasons={candidate.reasons} />
      </div>
    </div>
  );
}

export function SoundCloudCard({
  soundcloud,
  candidates,
  fallbackSeed,
  onReview,
  embedded = false,
}: {
  embedded?: boolean;
  soundcloud: SoundCloudConfirmedMetadata | null;
  candidates: SoundCloudCandidate[];
  fallbackSeed: number;
  onReview?: () => void;
}) {
  const bestCandidate = useMemo(
    () => candidates.filter((candidate) => candidate.status === "pending")
      .sort((a, b) => b.score - a.score)[0],
    [candidates],
  );

  if (embedded && !soundcloud) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-cm-muted">
        <Radio aria-hidden="true" className="h-4 w-4 shrink-0 text-cm-faint" />
        Χωρίς συνδεδεμένη πηγή SoundCloud
      </div>
    );
  }

  if (!soundcloud && bestCandidate) {
    return (
      <GlassPanel className="p-4">
        <SectionHeader>SoundCloud</SectionHeader>
        <PendingCandidate candidate={bestCandidate} fallbackSeed={fallbackSeed} onReview={onReview} />
      </GlassPanel>
    );
  }

  if (!soundcloud) {
    return (
      <GlassPanel className="p-4">
        <SectionHeader>SoundCloud</SectionHeader>
        <div className="flex items-center justify-center gap-2 text-center text-xs text-cm-muted">
          <Radio className="h-4 w-4 text-cm-faint" />
          Δεν υπάρχει συσχετισμένο SoundCloud track.
        </div>
      </GlassPanel>
    );
  }

  const { track, match } = soundcloud;
  const availability = (
    <SmartChip tone={track.available ? "cyan" : "muted"}>
      {track.available ? "Διαθέσιμο" : "Μη διαθέσιμο"}
    </SmartChip>
  );
  const confidence = match.method === "canonical_recording" ? `${match.confidence.toFixed(1)}/100` : formatConfidence(match.confidence);
  const link = track.permalink_url && (
    <a
      href={track.permalink_url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-xs font-medium text-cm-cyan transition hover:text-cm-blue"
    >
      <Link2 aria-hidden="true" className="h-3 w-3" />
      Άνοιγμα στο SoundCloud
    </a>
  );

  if (embedded) {
    return (
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          {link || <span className="text-xs font-medium text-cm-text">SoundCloud</span>}
          {availability}
        </div>
        <SourceDetails rawTitle={track.title} method={match.method} reasons={match.reasons}>
          <TrackFacts track={track} />
          <TrackStats track={track} />
          <p className="mt-2 text-[11px]">Βαθμός αντιστοίχισης · {confidence}</p>
          {track.uploader_username && (
            <p className="mt-1 break-words text-[11px]">Λογαριασμός ανάρτησης · {track.uploader_username}</p>
          )}
        </SourceDetails>
      </div>
    );
  }

  return (
    <GlassPanel className="p-4">
      <div className="flex items-center justify-between gap-3">
        <SectionHeader>SoundCloud</SectionHeader>
        <div className="mb-3 flex shrink-0 flex-wrap justify-end gap-1.5">
          {availability}
          <SmartChip tone="chartreuse">{confidence}</SmartChip>
        </div>
      </div>

      <div className="flex gap-3">
        <ProviderArtwork snapshot={track} fallbackSeed={fallbackSeed} />
        <div className="min-w-0 flex-1">
          <TrackIdentity track={track} />
          <TrackFacts track={track} />
          {link && <div className="mt-2 flex justify-center">{link}</div>}
        </div>
      </div>

      <TrackStats track={track} />
      <SourceDetails rawTitle={track.title} method={match.method} reasons={match.reasons} />
    </GlassPanel>
  );
}

export default SoundCloudCard;
