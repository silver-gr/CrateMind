import { effectiveBpm } from "../lib/tempo";
import { bpmColor } from "../lib/bpmColor";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { api } from "../lib/api";
import { useSetTrackAddition } from "../lib/useSetTrackAddition";
import { GlassPanel } from "./ui/GlassPanel";
import { SectionHeader } from "./ui/SectionHeader";
import { EmptyState } from "./ui/EmptyState";
import { SmartChip } from "./ui/SmartChip";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import RecommendationCard from "./RecommendationCard";
import { Pager } from "./ui/Pager";
import { RECS_LIMIT, clampPage, pageCountFor, pageRangeLabel, pageSlice } from "../lib/paging";
import { getMixSession } from "../lib/mix/mixSession";
import { usePlayer } from "../lib/player";
import { keyColor, formatKey, fallbackKey } from "../lib/camelot";
import { getPref, usePref } from "../lib/prefs";
import type { DJSet, Recommendation, Track } from "../lib/types";
import { Workflow, Search, X, ArrowRight, Sparkles, Waypoints, Disc3 } from "../lib/icons";

gsap.registerPlugin(useGSAP);

/**
 * Flow Finder (the Library drawer): transparent next-track / bridge suggestions.
 * Track A is local state seeded from the selected Library track; picking or clearing it never
 * loads or ejects a deck. Auditions still play on Deck B.
 */
export default function FlowFinderPanel({ seed }: { seed: Track | null }) {
  const { addToSet, duplicateDialog } = useSetTrackAddition();
  const { slots, load } = usePlayer();

  const [sets, setSets] = useState<DJSet[]>([]);
  const [targetSetId, setTargetSetId] = useState<string>("none");

  const [trackA, setTrackA] = useState<Track | null>(seed);
  // A newly selected Library track becomes A; a selection that is still loading (null) keeps the current A.
  const [seedId, setSeedId] = useState(seed?.id);
  if (seed && seed.id !== seedId) {
    setSeedId(seed.id);
    setTrackA(seed);
  }
  const deckA = slots.A.track;
  const [trackB, setTrackB] = useState<Track | null>(null);

  const [recs, setRecs] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(false);
  const [ran, setRan] = useState(false);
  const [page, setPage] = useState(1);
  // Cards leave the list after an add; keep the page inside it.
  const shownPage = clampPage(page, recs.length);
  if (shownPage !== page) setPage(shownPage);

  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const request = useRef(0);
  const lastAuditionedId = useRef<number | null>(null);
  const slotsRef = useRef(slots);
  slotsRef.current = slots;

  // The user's sets fill «Πρόσθεσε σε».
  useEffect(() => {
    let cancelled = false;
    api.listSets().then(existing => { if (!cancelled) setSets(existing); }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const runRecommend = useCallback(async (a: Track, b: Track | null) => {
    const version = ++request.current;
    setLoading(true);
    setRan(true);
    setPage(1);
    try {
      const result = await api.recommend({ after_track_id: a.id, before_track_id: b?.id, limit: RECS_LIMIT });
      if (version === request.current) setRecs(result);
    } catch {
      if (version !== request.current) return;
      toast.error("Δεν ήταν δυνατή η πρόταση tracks");
      setRecs([]);
    } finally {
      if (version === request.current) setLoading(false);
    }
  }, []);

  // Auto-run when A (and optionally B) is chosen.
  useEffect(() => {
    if (trackA) {
      runRecommend(trackA, trackB);
    } else {
      ++request.current;
      setLoading(false);
      setRecs([]);
      setRan(false);
    }
    // keyed on the ids so reloading the same track doesn't re-query
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackA?.id, trackB?.id, runRecommend]);

  useGSAP(
    () => {
      if (getPref("reduceMotion")) return;
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.fromTo("[data-reveal]", { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.4, stagger: 0.05, ease: "power2.out", clearProps: "opacity,transform" });
      });
      return () => mm.revert();
    },
    { scope: containerRef, dependencies: [loading], revertOnUpdate: true },
  );

  const mixRunning = () => {
    const s = getMixSession();
    return s.mode === "set" && s.status !== "idle" && s.status !== "stopping";
  };

  /** Auditions play on Deck B, but never over a running set mix or a deck B the user is playing. */
  const audition = (trackId: number) => {
    if (mixRunning()) {
      toast.error("Τρέχει μίξη set — δεν φορτώθηκε");
      return;
    }
    api.getTrack(trackId).then((d) => {
      if (mixRunning()) {
        toast.error("Τρέχει μίξη set — δεν φορτώθηκε");
        return;
      }
      // A deck B still holding the previous audition may be replaced even while it plays.
      const replacesAudition = slotsRef.current.B.track != null && slotsRef.current.B.track.id === lastAuditionedId.current;
      if (load("B", d.track, { play: true, ifIdle: true }) || (replacesAudition && load("B", d.track, { play: true }))) {
        lastAuditionedId.current = trackId;
      } else {
        toast.error("Το Deck B παίζει — δεν φορτώθηκε");
      }
    }).catch(() => toast.error("Αδυναμία αναπαραγωγής"));
  };

  const handlePlay = (rec: Recommendation) => audition(rec.track_id);

  const handleAdd = (id: number) => {
    if (targetSetId !== "none") {
      void addToSet(Number(targetSetId), id).then(added => {
        if (!added) return;
        toast.success("Προστέθηκε στο set");
        setRecs(current => current.filter(rec => rec.track_id !== id));
      });
    } else {
      // no chosen set → audition the track instead
      audition(id);
    }
  };

  const changePage = (next: number) => {
    setPage(next);
    listRef.current?.scrollIntoView({ block: "start" });
  };

  return (
    <div ref={containerRef} className="@container">
      {duplicateDialog}
      <div className="space-y-6 px-5 pt-4 pb-8">
        <p className="text-xs text-cm-muted">Τι μπαίνει μετά — διαφανείς προτάσεις μετάβασης</p>
        {/* Controls */}
        <GlassPanel strong className="relative z-30 p-5" data-reveal>
          <div className="grid gap-4 @min-[40rem]:grid-cols-[1fr_auto_1fr]">
            <TrackPicker
              label="Track A"
              hint="από πού ξεκινάς"
              tone="cyan"
              value={trackA}
              onPick={setTrackA}
              onClear={() => setTrackA(null)}
              action={deckA && deckA.id !== trackA?.id ? (
                <button
                  type="button"
                  onClick={() => setTrackA(deckA)}
                  title={`Track A από το Deck A: ${deckA.title ?? deckA.file_name}`}
                  className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-cm-muted transition-colors hover:bg-cm-contrast/8 hover:text-cm-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-cyan/60"
                >
                  <Disc3 className="h-3 w-3" aria-hidden="true" />
                  Deck A
                </button>
              ) : undefined}
            />
            <div className="hidden items-center justify-center @min-[40rem]:flex">
              <div className="grid h-9 w-9 place-items-center rounded-full border border-cm-contrast/10 bg-cm-contrast/5 text-cm-faint">
                <ArrowRight className="h-4 w-4" />
              </div>
            </div>
            <TrackPicker
              label="Στόχος B"
              hint="προαιρετικός προορισμός (γέφυρα)"
              tone="violet"
              value={trackB}
              onPick={setTrackB}
              onClear={() => setTrackB(null)}
            />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-cm-contrast/[0.06] pt-4">
            {trackB ? (
              <SmartChip tone="violet" icon={Waypoints} className="text-[11px]">
                Γέφυρα A → B
              </SmartChip>
            ) : (
              <SmartChip tone="muted" className="text-[11px]">
                Επόμενο track
              </SmartChip>
            )}
            <span className="text-[11px] text-cm-faint">Πρόσθεσε σε:</span>
            <Select value={targetSetId} onValueChange={setTargetSetId}>
              <SelectTrigger className="h-7 w-auto min-w-[140px] cursor-pointer rounded-lg px-2 py-1 text-xs text-cm-text focus:ring-0 focus:ring-offset-0">
                <SelectValue placeholder="— κανένα —" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— κανένα (play) —</SelectItem>
                {sets.map((s) => (
                  <SelectItem key={s.id} value={String(s.id)}>
                    {s.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </GlassPanel>

        {/* Results */}
        <section ref={listRef} data-reveal className="scroll-mt-4">
          <SectionHeader
            right={
              recs.length > 0 ? (
                <span className="tabular-nums text-xs text-cm-faint">{pageRangeLabel(shownPage, recs.length)}</span>
              ) : undefined
            }
          >
            Προτάσεις μετάβασης
          </SectionHeader>

          {!trackA ? (
            <EmptyState icon={Sparkles} title="Διάλεξε Track A">
              Ψάξε και επίλεξε από πού ξεκινάς. Πρόσθεσε προαιρετικά Στόχο B για γέφυρα (πρόταση που οδηγεί A → B).
            </EmptyState>
          ) : loading ? (
            <div className="grid gap-3 @min-[34rem]:grid-cols-2 @min-[64rem]:grid-cols-3">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="h-32 animate-pulse rounded-2xl bg-cm-contrast/[0.03]" />
              ))}
            </div>
          ) : recs.length === 0 ? (
            <EmptyState icon={Workflow} title="Καμία πρόταση">
              {ran ? "Δεν βρέθηκαν υποψήφια tracks για αυτή την επιλογή." : "…"}
            </EmptyState>
          ) : (
            <div>
              <div className="grid gap-3 @min-[34rem]:grid-cols-2 @min-[64rem]:grid-cols-3">
                {pageSlice(recs, shownPage).map((rec) => (
                  <RecommendationCard key={rec.track_id} rec={rec} onAdd={handleAdd} onPlay={handlePlay} />
                ))}
              </div>
              <Pager page={shownPage} pageCount={pageCountFor(recs.length)} onPage={changePage} className="mt-4 justify-center" />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/** Search-box track picker: debounced `api.listTracks(q)` → choose one. */
function TrackPicker({
  label,
  hint,
  tone,
  value,
  onPick,
  onClear,
  action,
}: {
  label: string;
  hint: string;
  tone: "cyan" | "violet";
  value: Track | null;
  onPick: (t: Track) => void;
  onClear: () => void;
  /** Extra control at the end of the label row (Track A's «Deck A» shortcut). */
  action?: ReactNode;
}) {
  const [keyFormat] = usePref("keyFormat");
  const [q, setQ] = useState("");
  const [res, setRes] = useState<Track[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (value) return; // picked → stop searching
    if (timer.current) window.clearTimeout(timer.current);
    const term = q.trim();
    if (!term) {
      setRes([]);
      setOpen(false);
      return;
    }
    setSearching(true);
    timer.current = window.setTimeout(async () => {
      try {
        const rows = await api.listTracks(term, 8);
        setRes(rows);
        setOpen(true);
      } catch {
        setRes([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [q, value]);

  const ringTone = tone === "cyan" ? "text-cm-cyan" : "text-cm-violet";

  if (value) {
    const code = formatKey(value.key_text, fallbackKey(value), keyFormat);
    const bpm = effectiveBpm(value);
    return (
      <div>
        <div className="mb-1.5 flex items-center gap-2">
          <span className={`text-[10px] font-semibold uppercase tracking-widest ${ringTone}`}>{label}</span>
          <span className="text-[10px] text-cm-faint">{hint}</span>
          {action}
        </div>
        <div className="flex items-center gap-3 rounded-xl border border-cm-contrast/10 bg-cm-contrast/[0.04] p-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-cm-text">{value.title ?? value.file_name}</div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-cm-muted">
              <span className="truncate">{value.artist ?? "—"}</span>
              <span style={{color: bpmColor(bpm)}} className="font-mono tabular-nums text-cm-faint">
                {bpm != null ? `${bpm.toFixed(0)} BPM` : "— BPM"}
              </span>
              {code && (
                <SmartChip tone={tone} className="px-1.5 py-0 font-mono text-[10px]">
                  <span style={{color: keyColor(value.key_text, fallbackKey(value))}}>{code}</span>
                </SmartChip>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClear}
            title="Καθάρισε"
            aria-label={`Καθάρισε ${label}`}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-cm-contrast/8 text-cm-muted transition hover:bg-cm-rose/20 hover:text-cm-rose cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-contrast/20"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={pickerRef} className="relative">
      <div className="mb-1.5 flex items-center gap-2">
        <span className={`text-[10px] font-semibold uppercase tracking-widest ${ringTone}`}>{label}</span>
        <span className="text-[10px] text-cm-faint">{hint}</span>
        {action}
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute z-10 left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-cm-faint" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => res.length > 0 && setOpen(true)}
          placeholder="Αναζήτηση artist / title…"
          aria-label={`Αναζήτηση ${label}`}
          className="pl-8 text-cm-text placeholder:text-cm-faint"
        />
      </div>
      {open && res.length > 0 && (
        <ul className="absolute z-50 mt-1 max-h-64 w-full overflow-y-auto rounded-xl border surface-menu p-1">
          {res.map((t) => {
            const code = formatKey(t.key_text, fallbackKey(t), keyFormat);
            const bpm = effectiveBpm(t);
            return (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(t);
                    setQ("");
                    setRes([]);
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition menu-item focus-visible:outline-none"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-cm-text">{t.title ?? t.file_name}</div>
                    <div className="truncate text-[10px] text-cm-muted">{t.artist ?? "—"}</div>
                  </div>
                  {bpm != null && (
                    <span style={{color: bpmColor(bpm)}} className="shrink-0 font-mono text-[10px] tabular-nums text-cm-faint">{bpm.toFixed(0)} BPM</span>
                  )}
                  {code && <span style={{color: keyColor(t.key_text, fallbackKey(t))}} className="shrink-0 font-mono text-[10px] text-cm-faint">{code}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {open && !searching && res.length === 0 && q.trim() && (
        <div className="absolute z-50 mt-1 w-full rounded-xl border surface-menu px-3 py-2 text-[11px] text-cm-faint">
          Κανένα track.
        </div>
      )}
    </div>
  );
}
