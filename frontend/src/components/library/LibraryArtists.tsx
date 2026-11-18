import { memo, useEffect, useId, useMemo, useRef, useState, type MouseEvent } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { useCapabilities } from "../../lib/capabilities";
import { usePref } from "../../lib/prefs";
import { cn } from "../../lib/cn";
import { foldText, tokenizeQuery } from "../../lib/queryGrammar";
import { getLunaGenreResult } from "../../lib/artistGenreResults";
import { awaitingReview, filterArtists } from "../../lib/libraryArtists";
import { useArtists } from "../../lib/useArtists";
import type { ArtistProfile } from "../../lib/types";
import { canAcceptArtistCandidate } from "../ArtistResearchEvidence";
import { ArtistGenreResultCard } from "../ArtistGenreResultCard";
import { EmptyState } from "../ui/EmptyState";
import { SmartChip } from "../ui/SmartChip";
import { Skeleton } from "../ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowRight, ChevronDown, MicVocal, RotateCcw, Search, TriangleAlert } from "../../lib/icons";

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cm-cyan/60";

/** «1 καλλιτέχνης», «12 καλλιτέχνες». */
const artistsLabel = (n: number) => `${n.toLocaleString("el-GR")} ${n === 1 ? "καλλιτέχνης" : "καλλιτέχνες"}`;

/** Pointer clicks drop focus so Space/J/K keep reaching the player (keyboard activation keeps it). */
function blurAfterPointer(event: MouseEvent<HTMLElement>) {
  if (event.detail > 0) event.currentTarget.blur();
}

/**
 * The Library «Καλλιτέχνες» tab: the artist list (two tracks or more) filtered on the client.
 * A row runs `artist:"…"` in the Library through `onOpenArtist`; the current artist is marked.
 * With artist research on (and not in therapy), a row whose Luna result waits for confirmation
 * opens the full page's review card under it. Rebuild and research stay on `/artists`.
 */
function LibraryArtists({
  active,
  appliedQuery,
  onOpenArtist,
}: {
  active: boolean;
  appliedQuery: string;
  onOpenArtist: (name: string) => void;
}) {
  const capabilities = useCapabilities();
  const [profile] = usePref("libraryProfile");
  const therapy = profile === "therapy";
  const review = capabilities.artist_enrichment && !therapy;
  const { rows, loading, loaded, error, load } = useArtists({ enabled: active });
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"all" | "review">("all");
  const [openId, setOpenId] = useState<number | null>(null);
  const [savingReview, setSavingReview] = useState(false);
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // After a confirmed genre the card (and in «Προς επιβεβαίωση» the row) unmounts: focus goes to the row, else the next one.
  const refocus = useRef<number[] | null>(null);

  const waiting = useMemo(() => rows.filter(awaitingReview), [rows]);
  const waitingIds = useMemo(() => new Set(waiting.map(row => row.id)), [waiting]);
  const genres = useMemo(
    () => new Map(rows.map(row => [row.id, getLunaGenreResult(row)?.primaryGenre ?? null])),
    [rows],
  );
  const reviewView = review && view === "review";
  const shown = useMemo(
    () => filterArtists(reviewView ? waiting : rows, search),
    [reviewView, waiting, rows, search],
  );

  // The positive `artist:` values of the applied query, folded as facetTokenActive does (once per query, not per row).
  const currentArtists = useMemo(
    () => new Set(tokenizeQuery(appliedQuery)
      .filter(t => !t.neg && t.field?.toLowerCase() === "artist" && t.value !== "*")
      .map(t => foldText(t.value))),
    [appliedQuery],
  );
  const isCurrent = (name: string) => currentArtists.has(foldText(name));

  useEffect(() => {
    const ids = refocus.current;
    if (!ids) return;
    refocus.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && rootRef.current?.contains(active)) return;
    const target = ids
      .map(id => rootRef.current?.querySelector<HTMLElement>(`[data-artist-row="${id}"]`))
      .find(el => el != null);
    (target ?? searchRef.current)?.focus();
  }, [shown]);

  async function choose(row: ArtistProfile, choice: "candidate" | "current" | "manual", genre?: string) {
    if (row.review?.state === "confirmed" || (choice === "candidate" && !canAcceptArtistCandidate(row.review?.candidate, row.review?.state))) return;
    setSavingReview(true);
    try {
      await api.chooseArtistFinding(row.id, choice, genre);
      const at = shown.findIndex(r => r.id === row.id);
      refocus.current = [row.id, ...shown.slice(at + 1, at + 2).map(r => r.id)];
      setOpenId(null);
      await load();
      toast.success("Η επιλογή επιβεβαιώθηκε");
    } finally {
      // A failure is shown inside the card (it catches the rejection).
      setSavingReview(false);
    }
  }

  const trimmed = search.trim();

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-cm-border/60 px-3">
        <p className="min-w-0 flex-1 truncate font-mono text-[11px] tabular-nums text-cm-muted">
          {loaded && !error ? artistsLabel(rows.length) : null}
        </p>
        <Link
          to="/artists"
          title="Άνοιγμα της σελίδας «Καλλιτέχνες»"
          className={cn(
            "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-cm-muted transition-[background-color,color] duration-150 hover:bg-cm-contrast/6 hover:text-cm-text active:bg-cm-contrast/10",
            FOCUS,
          )}
        >
          Πλήρης σελίδα
          <ArrowRight aria-hidden="true" className="size-3" />
        </Link>
      </div>
      <div className="shrink-0 space-y-2 px-3 pt-2.5 pb-2">
        <div className="relative">
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-cm-faint" />
          <Input
            ref={searchRef}
            type="search"
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") {
                const first = shown[0];
                if (first && !isCurrent(first.canonical_name)) onOpenArtist(first.canonical_name);
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                if (search) e.stopPropagation();
                setSearch("");
                e.currentTarget.blur();
              }
            }}
            aria-label="Αναζήτηση καλλιτέχνη"
            aria-controls={loaded && shown.length > 0 ? listId : undefined}
            placeholder="Αναζήτηση καλλιτέχνη…"
            className="h-8 pl-8 text-xs md:text-xs"
          />
        </div>
        {review && loaded && !error && (
          <div role="group" aria-label="Προβολή" className="flex flex-wrap gap-1.5">
            <SmartChip tone={view === "all" ? "cyan" : "muted"} active={view === "all"} pressed={view === "all"} onClick={() => setView("all")} className="h-6 px-2 py-0 text-[11px]">
              Όλοι
            </SmartChip>
            <SmartChip tone={view === "review" ? "cyan" : "muted"} active={view === "review"} pressed={view === "review"} onClick={() => setView("review")} className="h-6 px-2 py-0 text-[11px]">
              Προς επιβεβαίωση <span className="font-mono tabular-nums">{waiting.length.toLocaleString("el-GR")}</span>
            </SmartChip>
          </div>
        )}
        <p role="status" className="sr-only">
          {trimmed && loaded ? artistsLabel(shown.length) : ""}
        </p>
      </div>

      {error && (
        <div role="alert" className="mx-3 mb-2 flex shrink-0 items-start gap-2 rounded-lg border border-cm-amber/25 bg-cm-amber/8 px-2.5 py-2 text-xs text-cm-text">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-cm-amber" />
          <span className="min-w-0 flex-1 text-pretty">Δεν φορτώθηκε η λίστα καλλιτεχνών.</span>
          <Button type="button" variant="outline" size="xs" onClick={() => void load()}>
            <RotateCcw aria-hidden="true" />
            Δοκίμασε ξανά
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-[calc(0.75rem+var(--cm-dock-clearance,0px))]">
        {(!loaded || (loading && rows.length === 0)) && !error ? (
          <div role="status" className="space-y-1 px-1 pt-1">
            <span className="sr-only">Φόρτωση καλλιτεχνών…</span>
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} aria-hidden="true" className="flex items-center gap-2 py-1.5">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-3" style={{ width: `${70 - (i % 3) * 15}%` }} />
                  <Skeleton className="h-2.5 w-1/3" />
                </div>
                <Skeleton className="h-2.5 w-6" />
              </div>
            ))}
          </div>
        ) : error && rows.length === 0 ? null : rows.length === 0 ? (
          <EmptyState icon={MicVocal} title="Δεν υπάρχει ακόμη λίστα καλλιτεχνών" className="mx-1 mt-1 px-4 py-8">
            Φτιάξε τη λίστα στην{" "}
            <Link to="/artists" className={cn("rounded-sm text-cm-cyan underline-offset-2 hover:underline", FOCUS)}>
              πλήρη σελίδα
            </Link>{" "}
            με «Ανανέωση λίστας».
          </EmptyState>
        ) : shown.length === 0 ? (
          <EmptyState
            icon={reviewView && !trimmed ? MicVocal : Search}
            title={trimmed ? `Κανένας καλλιτέχνης για «${trimmed}»` : "Κανένας καλλιτέχνης προς επιβεβαίωση"}
            className="mx-1 mt-1 px-4 py-8 break-words"
            action={trimmed ? (
              <Button type="button" variant="outline" size="xs" onClick={() => setSearch("")}>
                Καθαρισμός
              </Button>
            ) : undefined}
          />
        ) : (
          <ul id={listId} aria-label="Καλλιτέχνες" className="space-y-px">
            {shown.map(row => {
              const name = row.canonical_name;
              const current = isCurrent(name);
              const genre = therapy ? null : genres.get(row.id) ?? null;
              const pending = review && waitingIds.has(row.id);
              const result = pending && row.review ? getLunaGenreResult(row) : null;
              const open = result !== null && openId === row.id;
              const cardId = `${listId}-review-${row.id}`;
              return (
                <li key={row.id} className="[contain-intrinsic-size:auto_40px] [content-visibility:auto]">
                  <div
                    className={cn(
                      "flex items-stretch rounded-md transition-[background-color] duration-150",
                      current
                        ? "bg-cm-cyan/12 shadow-[inset_2px_0_0_var(--color-cm-cyan)]"
                        : "hover:bg-cm-contrast/5",
                    )}
                  >
                    <button
                      type="button"
                      data-artist-row={row.id}
                      aria-current={current || undefined}
                      title={name}
                      onClick={e => {
                        blurAfterPointer(e);
                        onOpenArtist(name);
                      }}
                      className={cn(
                        "flex min-h-9 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md py-1.5 pr-2 pl-2.5 text-left transition-[background-color] duration-150 active:bg-cm-contrast/8",
                        FOCUS,
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] leading-5 font-medium text-cm-text">
                          {name}
                        </span>
                        {genre && (
                          <span className={cn("block truncate text-[11px] leading-4", pending ? "text-cm-faint" : "text-cm-muted")}>
                            {genre}
                          </span>
                        )}
                      </span>
                      {pending && (
                        <span title="Προς επιβεβαίωση" className="size-1.5 shrink-0 rounded-full bg-cm-amber">
                          <span className="sr-only">Προς επιβεβαίωση</span>
                        </span>
                      )}
                      <span className="shrink-0 font-mono text-[11px] tabular-nums text-cm-faint">
                        {row.track_count.toLocaleString("el-GR")}
                        <span className="sr-only"> κομμάτια</span>
                      </span>
                    </button>
                    {result && (
                      <button
                        type="button"
                        aria-expanded={open}
                        aria-controls={open ? cardId : undefined}
                        aria-label={`Επιβεβαίωση είδους: ${name}`}
                        title="Επιβεβαίωση είδους"
                        onClick={e => {
                          blurAfterPointer(e);
                          setOpenId(open ? null : row.id);
                        }}
                        className={cn(
                          "flex w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-cm-faint transition-[background-color,color] duration-150 hover:bg-cm-contrast/8 hover:text-cm-text active:bg-cm-contrast/12",
                          open && "text-cm-text",
                          FOCUS,
                        )}
                      >
                        <ChevronDown aria-hidden="true" className={cn("size-3.5 motion-safe:transition-[rotate] motion-safe:duration-150", open && "rotate-180")} />
                      </button>
                    )}
                  </div>
                  {open && result && (
                    <div id={cardId} className="px-0.5 pt-1 pb-2">
                      <ArtistGenreResultCard
                        artist={row}
                        result={result}
                        disabled={savingReview}
                        onLibrary={() => {
                          if (!current) onOpenArtist(name);
                        }}
                        onConfirm={(choice, chosen) => choose(row, choice, chosen)}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export default memo(LibraryArtists);
