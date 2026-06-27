import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { useNavigate } from "react-router-dom";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import GradientText from "../components/GradientText";
import { api } from "../lib/api";
import { GlassPanel } from "../components/ui/GlassPanel";
import { MetricCard } from "../components/ui/MetricCard";
import { SectionHeader } from "../components/ui/SectionHeader";
import { EmptyState } from "../components/ui/EmptyState";
import { SmartChip } from "../components/ui/SmartChip";
import { Gauge } from "../components/ui/Gauge";
import { KeyWheel } from "../components/ui/KeyWheel";
import { ALL_CAMELOT, toCamelot, camelotCode, neighbors } from "../lib/camelot";
import type { ChipTone } from "../lib/queryChips";
import { KeyRound, ArrowRight, Compass, Music2, Sparkles } from "../lib/icons";

gsap.registerPlugin(useGSAP);

type IconType = ComponentType<{ className?: string }>;

// Harmonic-neighbour roles, in the exact order `neighbors()` returns them.
const NBR_META: { label: string; hint: string; tone: ChipTone }[] = [
  { label: "+1", hint: "ανέβασμα έντασης", tone: "chartreuse" },
  { label: "−1", hint: "χαλάρωση", tone: "cyan" },
  { label: "σχετικό", hint: "major ↔ minor", tone: "violet" },
];

export default function KeyHarmony() {
  const nav = useNavigate();
  const go = (q: string) => nav("/library?q=" + encodeURIComponent(q));

  const [counts, setCounts] = useState<Record<string, number>>({});
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    // Exact per-key counts for all 24 Camelot codes + library total, all parallel.
    const [codeCounts, totalR] = await Promise.all([
      Promise.all(
        ALL_CAMELOT.map((code) =>
          api.trackCount(`key:${code}`).then((r) => r.count).catch(() => 0),
        ),
      ),
      api.trackCount("").then((r) => r.count).catch(() => 0),
    ]);
    setCounts(Object.fromEntries(ALL_CAMELOT.map((code, i) => [code, codeCounts[i]])));
    setTotal(totalR);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.from("[data-reveal]", {
          opacity: 0,
          y: 12,
          duration: 0.4,
          stagger: 0.05,
          ease: "power2.out",
        });
      });
    },
    { scope: containerRef, dependencies: [loading] },
  );

  const keyed = Object.values(counts).reduce((a, b) => a + b, 0);
  const keyCoverage = total > 0 ? keyed / total : 0;
  const distinct = Object.values(counts).filter((c) => c > 0).length;
  const topKeys = ALL_CAMELOT
    .map((code) => ({ code, count: counts[code] ?? 0 }))
    .filter((k) => k.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  const selCam = selected ? toCamelot(selected) : null;
  const nbrCodes = selCam ? neighbors(selCam).map(camelotCode) : [];
  const selCount = selected ? counts[selected] ?? 0 : 0;

  const TILES: { label: string; value: number | string; tone: ChipTone; icon: IconType }[] = [
    { label: "Tracks", value: loading ? "…" : total, tone: "cyan", icon: Music2 },
    { label: "Με key", value: loading ? "…" : keyed, tone: "chartreuse", icon: KeyRound },
    { label: "Διακριτά keys", value: loading ? "…" : `${distinct}/24`, tone: "violet", icon: Compass },
  ];

  const empty = !loading && keyed === 0;

  return (
    <div ref={containerRef} className="h-full overflow-y-auto overflow-x-hidden">
      {/* Header */}
      <div className="sticky top-0 z-10 border-b border-white/[0.05] bg-cm-bg/80 backdrop-blur-md">
        <div className="flex items-center justify-between gap-4 px-6 py-3">
          <div className="flex min-w-0 items-center gap-4">
            <GradientText
              colors={["#4dd6f7", "#9b6dff", "#c2f04a"]}
              animationSpeed={9}
              className="!mx-0 !cursor-default !font-bold shrink-0 text-lg tracking-tight"
            >
              CrateMind
            </GradientText>
            <div className="min-w-0 border-l border-white/10 pl-4">
              <h1 className="flex items-center gap-2 text-base font-semibold leading-tight text-cm-text">
                <KeyRound className="h-4 w-4 text-cm-cyan" /> Key &amp; Harmony
              </h1>
              <p className="text-[11px] text-cm-muted">Camelot wheel &amp; αρμονικοί γείτονες — ακριβείς μετρήσεις</p>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-6 px-6 pt-5 pb-10">
        {/* Stat strip */}
        <div className="grid grid-cols-3 gap-3" data-reveal>
          {TILES.map((t) => (
            <MetricCard key={t.label} value={t.value} label={t.label} icon={t.icon} tone={t.tone} />
          ))}
        </div>

        {empty ? (
          <EmptyState icon={KeyRound} title="Κανένα track με Camelot key">
            Οι μετρήσεις βασίζονται σε ακριβές <span className="font-mono">key:&lt;code&gt;</span>. Δεν βρέθηκαν tracks
            με key_text σε μορφή Camelot (π.χ. <span className="font-mono">8A</span>). Πρόσθεσε key στα tracks για να
            ζωντανέψει ο τροχός.
          </EmptyState>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            {/* Wheel */}
            <GlassPanel strong className="flex flex-col items-center justify-center p-6" data-reveal>
              <SectionHeader className="w-full">Camelot Wheel</SectionHeader>
              {loading ? (
                <div className="h-[300px] w-[300px] animate-pulse rounded-full bg-white/[0.03]" />
              ) : (
                <KeyWheel
                  counts={counts}
                  selected={selected}
                  onSelect={(code) => setSelected((cur) => (cur === code ? null : code))}
                  size={300}
                />
              )}
              <p className="mt-4 text-center text-[11px] text-cm-faint">
                Φωτεινότητα φέτας = πλήθος tracks (ακριβές). Κλικ σε key για αρμονικούς γείτονες.
              </p>
            </GlassPanel>

            {/* Right column: coverage + selection detail */}
            <div className="space-y-4">
              <GlassPanel className="p-5" data-reveal>
                <SectionHeader>Κάλυψη Key</SectionHeader>
                <div className="flex items-center gap-4">
                  <Gauge value={keyCoverage} size={84} tone="cyan" sub="Camelot" />
                  <div className="min-w-0 text-xs leading-relaxed text-cm-muted">
                    <span className="font-mono tabular-nums text-cm-text">{keyed.toLocaleString("el-GR")}</span> από{" "}
                    <span className="font-mono tabular-nums text-cm-text">{total.toLocaleString("el-GR")}</span> tracks
                    έχουν key σε Camelot. Ακριβής μέτρηση από <span className="font-mono">key:&lt;code&gt;</span>.
                  </div>
                </div>
              </GlassPanel>

              <GlassPanel strong className="p-5" data-reveal>
                {selected && selCam ? (
                  <>
                    <SectionHeader right={<Compass className="h-3.5 w-3.5 text-cm-cyan" />}>
                      Επιλεγμένο key
                    </SectionHeader>
                    <div className="mb-4 flex items-center gap-3">
                      <div className="grid h-14 w-14 place-items-center rounded-2xl bg-cm-cyan/15 font-mono text-xl font-bold text-cm-cyan glow-violet">
                        {selected}
                      </div>
                      <div>
                        <div className="font-mono text-2xl font-bold tabular-nums text-cm-text">{selCount}</div>
                        <div className="text-[11px] uppercase tracking-wider text-cm-faint">tracks σε {selected}</div>
                      </div>
                    </div>

                    <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-cm-faint">
                      Αρμονικοί γείτονες
                    </p>
                    <ul className="space-y-1.5">
                      {nbrCodes.map((code, i) => {
                        const meta = NBR_META[i];
                        return (
                          <li key={code}>
                            <button
                              type="button"
                              onClick={() => setSelected(code)}
                              className="group flex w-full items-center gap-2 rounded-lg border border-white/8 bg-white/[0.03] px-2.5 py-1.5 text-left transition hover:border-cm-cyan/30 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-cyan/40"
                            >
                              <SmartChip tone={meta.tone} className="shrink-0 px-1.5 py-0 font-mono text-[10px]">
                                {code}
                              </SmartChip>
                              <span className="min-w-0 flex-1 truncate text-[11px] text-cm-muted">
                                <span className="font-mono text-cm-faint">{meta.label}</span> · {meta.hint}
                              </span>
                              <span className="shrink-0 font-mono text-xs tabular-nums text-cm-text">
                                {counts[code] ?? 0}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>

                    <button
                      type="button"
                      onClick={() => go(`key:${selected}`)}
                      className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-lg border border-cm-cyan/30 bg-cm-cyan/10 px-3 py-2 text-xs font-semibold text-cm-cyan transition hover:bg-cm-cyan/20 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-cyan/50"
                    >
                      Matching tracks σε {selected} <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  </>
                ) : (
                  <EmptyState icon={Sparkles} title="Διάλεξε key από τον τροχό" className="border-0 py-6">
                    Πάτησε μια φέτα στο Camelot wheel για να δεις τους αρμονικούς γείτονες και link στα matching tracks.
                  </EmptyState>
                )}
              </GlassPanel>

              {/* Top keys */}
              {topKeys.length > 0 && (
                <GlassPanel className="p-5" data-reveal>
                  <SectionHeader>Top keys</SectionHeader>
                  <div className="flex flex-wrap gap-1.5">
                    {topKeys.map((k) => (
                      <SmartChip
                        key={k.code}
                        tone="muted"
                        active={selected === k.code}
                        onClick={() => setSelected(k.code)}
                        title={`${k.code}: ${k.count} tracks`}
                        className="font-mono text-[11px]"
                      >
                        {k.code} · {k.count}
                      </SmartChip>
                    ))}
                  </div>
                </GlassPanel>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
