import { useEffect, useMemo, useState } from "react";
import type {
  SoundCloudCandidate,
  SoundCloudConfirmedMetadata,
  SoundCloudTrackSnapshot,
} from "../lib/types";
import { Link2, Radio } from "../lib/icons";
import { Artwork } from "./ui/Artwork";
import { GlassPanel } from "./ui/GlassPanel";
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

function formatCount(value?: number | null) {
  return value == null ? "μη διαθέσιμο" : new Intl.NumberFormat("el-GR").format(value);
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
  const artworkUrl = snapshot.artwork_url;

  useEffect(() => setFailed(false), [artworkUrl]);

  if (!artworkUrl || failed) {
    return <Artwork seed={fallbackSeed} className="h-20 w-20 rounded-xl" />;
  }

  return (
    <img
      src={artworkUrl}
      alt=""
      onError={() => setFailed(true)}
      className="h-20 w-20 shrink-0 rounded-xl border border-white/10 object-cover"
    />
  );
}

function Reasons({ reasons, compact = false }: { reasons: string[]; compact?: boolean }) {
  if (!reasons.length) return null;
  const visible = compact ? reasons.slice(0, 2) : reasons;
  return (
    <ul className="space-y-1 text-[11px] leading-snug text-cm-faint">
      {visible.map((reason) => (
        <li key={reason}>• {reason}</li>
      ))}
    </ul>
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
        <p className="mt-2 truncate text-sm font-medium text-cm-text">
          {track.title || "Άτιτλο SoundCloud track"}
        </p>
        <p className="truncate text-xs text-cm-muted">
          {track.uploader_username || "Άγνωστος uploader"}
        </p>
        <div className="mt-2">
          <Reasons reasons={candidate.reasons} compact />
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
      <div className="flex items-center justify-center gap-2 text-center text-xs text-cm-muted">
        <Radio aria-hidden="true" className="h-4 w-4 shrink-0 text-cm-faint" />
        Δεν υπάρχει συσχετισμένο SoundCloud track.
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
  const Container = embedded ? "div" : GlassPanel;
  return (
    <Container className={embedded ? undefined : "p-4"}>
      <div className="flex items-center justify-between gap-3">
        <SectionHeader>SoundCloud</SectionHeader>
        <div className="mb-3 flex shrink-0 flex-wrap justify-end gap-1.5">
          <SmartChip tone={track.available ? "cyan" : "muted"}>
            {track.available ? "Διαθέσιμο" : "Μη διαθέσιμο"}
          </SmartChip>
          <SmartChip tone="chartreuse">{match.method === 'canonical_recording' ? `${match.confidence.toFixed(1)}/100` : formatConfidence(match.confidence)}</SmartChip>
        </div>
      </div>

      <div className="flex gap-3">
        {!embedded && <ProviderArtwork snapshot={track} fallbackSeed={fallbackSeed} />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-cm-text">
            {track.title || "Άτιτλο SoundCloud track"}
          </p>
          <p className="truncate text-xs text-cm-muted">
            {track.uploader_username || "Άγνωστος uploader"}
          </p>
          <div className="mt-2 flex flex-wrap justify-center gap-1.5 text-[11px] text-cm-faint">
            <span>{track.genre || "χωρίς genre"}</span>
            <span>·</span>
            <span>διάρκεια {formatDuration(track.full_duration_ms ?? track.duration_ms)}</span>
          </div>
          {track.permalink_url && (
            <a
              href={track.permalink_url}
              target="_blank"
              rel="noreferrer"
              className="mt-2 flex items-center justify-center gap-1 text-xs font-medium text-cm-cyan transition hover:text-cm-blue"
            >
              <Link2 className="h-3 w-3" />
              Άνοιγμα στο SoundCloud
            </a>
          )}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-y border-cm-line/20 py-3 text-[11px]">
        <div><span className="text-cm-faint">Ανέβηκε</span><p className="text-cm-text">{formatDate(track.display_date ?? track.created_at)}</p></div>
        <div><span className="text-cm-faint">Στα Likes</span><p className="text-cm-text">{track.liked_by_me === true ? "Ναι" : track.liked_by_me === false ? "Όχι στο στιγμιότυπο" : formatDate(track.liked_at)}</p>{track.liked_by_me && track.liked_at && <p>{formatDate(track.liked_at)}</p>}</div>
        <div><span className="text-cm-faint">Likes</span><p className="font-mono tabular-nums text-cm-text">{formatCount(track.likes_count)}</p></div>
        <div><span className="text-cm-faint">Reposts</span><p className="font-mono tabular-nums text-cm-text">{formatCount(track.reposts_count)}</p></div>
        <div><span className="text-cm-faint">Plays</span><p className="font-mono tabular-nums text-cm-text">{formatCount(track.playback_count)}</p></div>
        <div><span className="text-cm-faint">Comments</span><p className="font-mono tabular-nums text-cm-text">{formatCount(track.comment_count)}</p></div>
      </div>

      <div className="mt-3">
        <div className="mb-1 text-[10px] uppercase tracking-wider text-cm-faint">
          Επιβεβαίωση · {match.method}
        </div>
        <Reasons reasons={match.reasons} />
      </div>
    </Container>
  );
}

export default SoundCloudCard;
