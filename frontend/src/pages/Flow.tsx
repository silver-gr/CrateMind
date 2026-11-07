import { effectiveBpm } from "../lib/tempo";
import { bpmColor } from "../lib/bpmColor";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import GradientText from "../components/GradientText";
import { api } from "../lib/api";
import { useSetTrackAddition } from "../lib/useSetTrackAddition";
import { GlassPanel } from "../components/ui/GlassPanel";
import { SectionHeader } from "../components/ui/SectionHeader";
import { EmptyState } from "../components/ui/EmptyState";
import { SmartChip } from "../components/ui/SmartChip";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import RecommendationCard from "../components/RecommendationCard";
import { recMatchPercents } from "../lib/aggregate";
import { usePlayer } from "../lib/player";
import { keyColor, formatKey } from "../lib/camelot";
import { usePref } from "../lib/prefs";
import type { DJSet, Recommendation, Track } from "../lib/types";
import { Workflow, Search, X, ArrowRight, Sparkles, Waypoints } from "../lib/icons";

gsap.registerPlugin(useGSAP);

const SCRATCH_TITLE = "Flow scratch";

export default function Flow() {
  const { addToSet, duplicateDialog } = useSetTrackAddition();
  const { slots, load, eject } = usePlayer();

  const [scratchSetId, setScratchSetId] = useState<number | null>(null);
  const [sets, setSets] = useState<DJSet[]>([]);
  const [targetSetId, setTargetSetId] = useState<string>("none");

  // Track A lives on the shared Deck A.
  const trackA = slots.A.track;
  const [trackB, setTrackB] = useState<Track | null>(null);

  const [recs, setRecs] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(false);
  const [ran, setRan] = useState(false);
  const [setupError, setSetupError] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);

  // Ensure a single reusable, persisted, EMPTY scratch set. Never create per query.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const existing = await api.listSets();
        if (cancelled) return;
        setSets(existing);
        const scratch = existing.find((s) => s.title === SCRATCH_TITLE) ?? (await api.createSet(SCRATCH_TITLE));
        if (cancelled) return;
        setScratchSetId(scratch.id);
        setSets((prev) => (prev.some((s) => s.id === scratch.id) ? prev : [scratch, ...prev]));
      } catch {
        if (!cancelled) setSetupError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const runRecommend = useCallback(
    async (a: Track, b: Track | null, setId: number) => {
      setLoading(true);
      setRan(true);
      try {
        // Backend contract (sets.py recommend_next): A is passed by id (after_track_id),
        // B is the bridge target (before_track_id); need_bridge auto-enables when B is set.
        // Candidates exclude set members — the scratch set is kept EMPTY so nothing is filtered.
        const result = await api.recommendNext(setId, {
          after_track_id: a.id,
          before_track_id: b?.id,
          need_bridge: !!b,
          limit: 12,
        });
        setRecs(result);
      } catch {
        toast.error("Σφάλμα recommender");
        setRecs([]);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Auto-run when A (and optionally B) is chosen and the scratch set is ready.
  useEffect(() => {
    if (trackA && scratchSetId != null) {
      runRecommend(trackA, trackB, scratchSetId);
    } else {
      setRecs([]);
      setRan(false);
    }
    // keyed on the id so reloading the same track doesn't re-query
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackA?.id, trackB, scratchSetId, runRecommend]);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.fromTo("[data-reveal]", { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.4, stagger: 0.05, ease: "power2.out", clearProps: "opacity,transform" });
      });
      return () => mm.revert();
    },
    { scope: containerRef, dependencies: [recs.length, loading], revertOnUpdate: true },
  );

  const matches = useMemo(() => recMatchPercents(recs), [recs]);

  const handlePlay = (rec: Recommendation) =>
    api.getTrack(rec.track_id).then((d) => load("B", d.track, { play: true })).catch(() => toast.error("Αδυναμία αναπαραγωγής"));

  const handleAdd = (id: number) => {
    if (targetSetId !== "none") {
      void addToSet(Number(targetSetId), id)
        .then(added => { if (added) toast.success("Προστέθηκε στο set"); });
    } else {
      // no chosen set → no-op that auditions the track instead of polluting scratch
      api.getTrack(id).then((d) => load("B", d.track, { play: true })).catch(() => toast.error("Αδυναμία αναπαραγωγής"));
    }
  };

  // Real user sets only (never offer the scratch set as an add target).
  const targetSets = sets.filter((s) => s.id !== scratchSetId && s.title !== SCRATCH_TITLE);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
    {duplicateDialog}
    <div ref={containerRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
      {/* Header */}
      <div className="sticky top-0 z-40 border-b border-cm-border bg-cm-glass-strong backdrop-blur-xl">
        <div className="flex items-center justify-between gap-4 px-6 py-3">
          <div className="flex min-w-0 items-center gap-4">
            <GradientText
              colors={["#4dd6f7", "#9b6dff", "#c2f04a"]}
              animationSpeed={9}
              className="!mx-0 !cursor-default !font-bold shrink-0 text-lg tracking-tight"
            >
              CrateMind
            </GradientText>
            <div className="min-w-0 border-l border-cm-contrast/10 pl-4">
              <h1 className="flex items-center gap-2 text-base font-semibold leading-tight text-cm-text">
                <Workflow className="h-4 w-4 text-cm-chartreuse" /> Flow Finder
              </h1>
              <p className="text-[11px] text-cm-muted">Τι μπαίνει μετά — διαφανείς προτάσεις μετάβασης</p>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-6 px-6 pt-5 pb-10">
        {/* Controls */}
        <GlassPanel strong className="relative z-30 p-5" data-reveal>
          <div className="grid gap-4 lg:grid-cols-[1fr_auto_1fr]">
            <TrackPicker
              label="Track A"
              hint="από πού ξεκινάς"
              tone="cyan"
              value={trackA}
              onPick={(t) => { if (!load("A", t, { play: false, ifIdle: true })) toast("Το Deck A παίζει — δεν φορτώθηκε"); }}
              onClear={() => eject("A")}
            />
            <div className="hidden items-center justify-center lg:flex">
              <div className="grid h-9 w-9 place-items-center rounded-full border border-cm-contrast/10 bg-cm-contrast/5 text-cm-faint">
                <ArrowRight className="h-4 w-4" />
              </div>
            </div>
            <TrackPicker
              label="Target B"
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
                bridge mode · A → B
              </SmartChip>
            ) : (
              <SmartChip tone="muted" className="text-[11px]">
                next-track mode
              </SmartChip>
            )}
            <span className="text-[11px] text-cm-faint">Πρόσθεσε σε:</span>
            <Select value={targetSetId} onValueChange={setTargetSetId}>
              <SelectTrigger className="h-7 w-auto min-w-[140px] cursor-pointer rounded-lg px-2 py-1 text-xs text-cm-text focus:ring-0 focus:ring-offset-0">
                <SelectValue placeholder="— κανένα —" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— κανένα (play) —</SelectItem>
                {targetSets.map((s) => (
                  <SelectItem key={s.id} value={String(s.id)}>
                    {s.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="ml-auto text-[10px] text-cm-faint">
              Μόνιμο κενό set «Flow scratch» — δεν γράφεται τίποτα σε αυτό.
            </span>
          </div>
        </GlassPanel>

        {/* Results */}
        <section data-reveal>
          <SectionHeader
            right={
              recs.length > 0 ? (
                <span className="tabular-nums text-xs text-cm-faint">{recs.length} προτάσεις</span>
              ) : undefined
            }
          >
            Προτάσεις μετάβασης
          </SectionHeader>

          {setupError ? (
            <EmptyState icon={X} title="Σφάλμα σύνδεσης">
              Δεν ήταν δυνατή η προετοιμασία του scratch set. Έλεγξε ότι τρέχει το backend.
            </EmptyState>
          ) : !trackA ? (
            <EmptyState icon={Sparkles} title="Διάλεξε Track A">
              Ψάξε και επίλεξε από πού ξεκινάς. Πρόσθεσε προαιρετικά Target B για bridge mode (πρόταση που οδηγεί A → B).
            </EmptyState>
          ) : loading ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="h-32 animate-pulse rounded-2xl bg-cm-contrast/[0.03]" />
              ))}
            </div>
          ) : recs.length === 0 ? (
            <EmptyState icon={Workflow} title="Καμία πρόταση">
              {ran ? "Ο recommender δεν επέστρεψε υποψήφια tracks για αυτό το context." : "…"}
            </EmptyState>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {recs.map((rec, i) => (
                <RecommendationCard
                  key={rec.track_id}
                  rec={rec}
                  match={matches[i]}
                  onAdd={handleAdd}
                  onPlay={handlePlay}
                />
              ))}
            </div>
          )}
        </section>
      </div>
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
}: {
  label: string;
  hint: string;
  tone: "cyan" | "violet";
  value: Track | null;
  onPick: (t: Track) => void;
  onClear: () => void;
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
    const code = formatKey(value.key_text, value.key_analyzed, keyFormat);
    const bpm = effectiveBpm(value);
    return (
      <div>
        <div className="mb-1.5 flex items-center gap-2">
          <span className={`text-[10px] font-semibold uppercase tracking-widest ${ringTone}`}>{label}</span>
          <span className="text-[10px] text-cm-faint">{hint}</span>
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
                  <span style={{color: keyColor(value.key_text, value.key_analyzed)}}>{code}</span>
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
            const code = formatKey(t.key_text, t.key_analyzed, keyFormat);
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
                  {code && <span style={{color: keyColor(t.key_text, t.key_analyzed)}} className="shrink-0 font-mono text-[10px] text-cm-faint">{code}</span>}
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
