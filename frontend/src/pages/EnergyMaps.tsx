import { useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import GradientText from "../components/GradientText";
import { api } from "../lib/api";
import { GlassPanel } from "../components/ui/GlassPanel";
import { MetricCard } from "../components/ui/MetricCard";
import { SectionHeader } from "../components/ui/SectionHeader";
import { EmptyState } from "../components/ui/EmptyState";
import { Gauge, Bars } from "../components/ui/Gauge";
import type { ChipTone } from "../lib/queryChips";
import {
  BarChart3,
  Flame,
  Moon,
  Waypoints,
  Grid3x3,
  Tags,
  Music2,
} from "../lib/icons";

gsap.registerPlugin(useGSAP);

type IconType = ComponentType<{ className?: string }>;

// Energy 1→10: cool → hot. Mirrors the Dashboard energy ramp.
const ENERGY_TONES: ChipTone[] = [
  "blue", "blue", "cyan", "cyan", "chartreuse",
  "chartreuse", "amber", "amber", "magenta", "rose",
];
// Darkness 1→10: light → deep void.
const DARK_TONES: ChipTone[] = [
  "cyan", "cyan", "blue", "blue", "violet",
  "violet", "violet", "magenta", "magenta", "rose",
];

// Set-role buckets (English DJ terms by convention). Counted via `role:<code>`.
const ROLES: { code: string; tone: ChipTone }[] = [
  { code: "builder", tone: "blue" },
  { code: "bridge", tone: "cyan" },
  { code: "peak", tone: "chartreuse" },
  { code: "reset", tone: "violet" },
  { code: "closer", tone: "magenta" },
  { code: "afterhours", tone: "amber" },
];

// Coarse 5×5 bands for the energy×darkness grid (25 exact-count calls).
const BANDS: [number, number][] = [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10]];

export default function EnergyMaps() {
  const nav = useNavigate();
  const go = (q: string) => nav("/library?q=" + encodeURIComponent(q));

  const [energy, setEnergy] = useState<number[]>([]);
  const [darkness, setDarkness] = useState<number[]>([]);
  const [roles, setRoles] = useState<Record<string, number>>({});
  const [grid, setGrid] = useState<number[][]>([]); // [darknessBand][energyBand]
  const [total, setTotal] = useState(0);
  const [untagged, setUntagged] = useState(0);
  const [loading, setLoading] = useState(true);

  const containerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    // Exact bucket counts — NOT a sampled list. Each call is `/tracks/count`.
    const [energyData, darknessData, roleEntries, untaggedR, totalR] = await Promise.all([
      Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          api.trackCount(`energy:${i + 1}`).then((r) => r.count).catch(() => 0),
        ),
      ),
      Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          api.trackCount(`darkness:${i + 1}`).then((r) => r.count).catch(() => 0),
        ),
      ),
      Promise.all(
        ROLES.map(async (r) => {
          const count = await api.trackCount(`role:${r.code}`).then((x) => x.count).catch(() => 0);
          return [r.code, count] as const;
        }),
      ),
      api.trackCount("untagged").then((r) => r.count).catch(() => 0),
      api.trackCount("").then((r) => r.count).catch(() => 0),
    ]);

    // 2D grid — 25 parallel exact counts, still cheap.
    const gridData = await Promise.all(
      BANDS.map((d) =>
        Promise.all(
          BANDS.map((e) =>
            api
              .trackCount(`energy:${e[0]}-${e[1]} darkness:${d[0]}-${d[1]}`)
              .then((r) => r.count)
              .catch(() => 0),
          ),
        ),
      ),
    );

    setEnergy(energyData);
    setDarkness(darknessData);
    setRoles(Object.fromEntries(roleEntries));
    setUntagged(untaggedR);
    setTotal(totalR);
    setGrid(gridData);
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

  const energyTagged = energy.reduce((a, b) => a + b, 0);
  const darknessTagged = darkness.reduce((a, b) => a + b, 0);
  const tagCoverage = total > 0 ? (total - untagged) / total : 0;
  const energyCoverage = total > 0 ? energyTagged / total : 0;
  const darknessCoverage = total > 0 ? darknessTagged / total : 0;
  const gridMax = Math.max(1, ...grid.flat());

  const TILES: { label: string; value: number | string; tone: ChipTone; icon: IconType }[] = [
    { label: "Tracks", value: loading ? "…" : total, tone: "cyan", icon: Music2 },
    { label: "Με ένταση", value: loading ? "…" : energyTagged, tone: "amber", icon: Flame },
    { label: "Με σκοτάδι", value: loading ? "…" : darknessTagged, tone: "violet", icon: Moon },
    { label: "Χωρίς tags", value: loading ? "…" : untagged, tone: "blue", icon: Tags },
  ];

  const empty = !loading && total === 0;

  return (
    <div ref={containerRef} className="h-full overflow-y-auto overflow-x-hidden">
      {/* Header */}
      <div className="sticky top-0 z-10 border-b border-cm-border bg-cm-bg/80 backdrop-blur-md">
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
                <BarChart3 className="h-4 w-4 text-cm-violet" /> Energy Maps
              </h1>
              <p className="text-[11px] text-cm-muted">Κατανομή έντασης & σκοταδιού — ακριβείς μετρήσεις</p>
            </div>
          </div>
          <span className="hidden shrink-0 rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-[10px] uppercase tracking-wider text-cm-faint sm:inline">
            exact counts
          </span>
        </div>
      </div>

      <div className="space-y-6 px-6 pt-5 pb-10">
        {empty ? (
          <EmptyState icon={BarChart3} title="Κενή βιβλιοθήκη">
            Δεν υπάρχουν tracks ακόμη. Κάνε import/scan και ταξινόμησε ένταση & σκοτάδι για να γεμίσουν οι χάρτες.
          </EmptyState>
        ) : (
          <>
            {/* Stat strip */}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {TILES.map((t) => (
                <div key={t.label} data-reveal>
                  <MetricCard value={t.value} label={t.label} icon={t.icon} tone={t.tone} />
                </div>
              ))}
            </div>

            {/* Coverage gauges */}
            <GlassPanel className="p-5" data-reveal>
              <SectionHeader>Κάλυψη ταξινόμησης</SectionHeader>
              <div className="flex flex-wrap items-center justify-around gap-4">
                <Gauge value={tagCoverage} size={92} tone="chartreuse" sub="Tags" />
                <Gauge value={energyCoverage} size={92} tone="amber" sub="Ένταση" />
                <Gauge value={darknessCoverage} size={92} tone="violet" sub="Σκοτάδι" />
              </div>
              <p className="mt-3 text-center text-[11px] text-cm-faint">
                Ποσοστά επί {total.toLocaleString("el-GR")} tracks — ακριβείς μετρήσεις, όχι δείγμα.
              </p>
            </GlassPanel>

            {/* Energy + Darkness histograms */}
            <div className="grid gap-6 lg:grid-cols-2">
              <GlassPanel className="p-5" data-reveal>
                <SectionHeader right={<Flame className="h-3.5 w-3.5 text-cm-amber" />}>
                  Κατανομή έντασης
                </SectionHeader>
                {loading ? (
                  <div className="h-[140px] animate-pulse rounded-xl bg-white/[0.03]" />
                ) : (
                  <Bars
                    data={energy.map((c, i) => ({ label: String(i + 1), value: c, tone: ENERGY_TONES[i] }))}
                    height={140}
                    onSelect={(lbl) => go(`energy:${lbl}`)}
                    className="w-full"
                  />
                )}
                <p className="mt-2 text-[11px] text-cm-faint">Κλικ σε μπάρα → Library φιλτραρισμένη σε αυτή την ένταση.</p>
              </GlassPanel>

              <GlassPanel className="p-5" data-reveal>
                <SectionHeader right={<Moon className="h-3.5 w-3.5 text-cm-violet" />}>
                  Κατανομή σκοταδιού
                </SectionHeader>
                {loading ? (
                  <div className="h-[140px] animate-pulse rounded-xl bg-white/[0.03]" />
                ) : (
                  <Bars
                    data={darkness.map((c, i) => ({ label: String(i + 1), value: c, tone: DARK_TONES[i] }))}
                    height={140}
                    onSelect={(lbl) => go(`darkness:${lbl}`)}
                    className="w-full"
                  />
                )}
                <p className="mt-2 text-[11px] text-cm-faint">Κλικ σε μπάρα → Library φιλτραρισμένη σε αυτό το σκοτάδι.</p>
              </GlassPanel>
            </div>

            {/* Roles + 2D grid */}
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
              <GlassPanel className="p-5" data-reveal>
                <SectionHeader right={<Waypoints className="h-3.5 w-3.5 text-cm-cyan" />}>
                  Ρόλοι στο set
                </SectionHeader>
                {loading ? (
                  <div className="h-[130px] animate-pulse rounded-xl bg-white/[0.03]" />
                ) : (
                  <Bars
                    data={ROLES.map((r) => ({ label: r.code, value: roles[r.code] ?? 0, tone: r.tone }))}
                    height={130}
                    onSelect={(lbl) => go(`role:${lbl}`)}
                    className="w-full"
                  />
                )}
                <p className="mt-2 text-[11px] text-cm-faint">Κλικ → Library με <span className="font-mono">role:&lt;ρόλος&gt;</span>.</p>
              </GlassPanel>

              <GlassPanel className="p-5" data-reveal>
                <SectionHeader right={<Grid3x3 className="h-3.5 w-3.5 text-cm-magenta" />}>
                  Ένταση × Σκοτάδι
                </SectionHeader>
                {loading ? (
                  <div className="h-[230px] animate-pulse rounded-xl bg-white/[0.03]" />
                ) : (
                  <EnergyDarknessGrid grid={grid} gridMax={gridMax} onSelect={go} />
                )}
              </GlassPanel>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** 5×5 heat grid: energy (cols, low→high) × darkness (rows, high→low). Each cell = exact count. */
function EnergyDarknessGrid({
  grid,
  gridMax,
  onSelect,
}: {
  grid: number[][];
  gridMax: number;
  onSelect: (q: string) => void;
}) {
  if (!grid.length) return null;
  // Render darkness high (9-10) at top → low (1-2) at bottom.
  const rows = [...BANDS.keys()].reverse();
  return (
    <div className="space-y-2">
      <div
        className="grid items-stretch gap-1.5"
        style={{ gridTemplateColumns: `auto repeat(5, minmax(0, 1fr))` }}
        role="grid"
        aria-label="Πλέγμα έντασης επί σκοταδιού"
      >
        {/* corner */}
        <div aria-hidden />
        {/* energy band headers */}
        {BANDS.map((e) => (
          <div key={`eh-${e[0]}`} className="pb-0.5 text-center font-mono text-[9px] text-cm-faint">
            {e[0]}–{e[1]}
          </div>
        ))}

        {rows.map((dIdx) => {
          const d = BANDS[dIdx];
          return (
            <FragmentRow key={`row-${dIdx}`}>
              <div className="flex items-center justify-end pr-1 font-mono text-[9px] text-cm-faint">
                {d[0]}–{d[1]}
              </div>
              {BANDS.map((e, eIdx) => {
                const count = grid[dIdx]?.[eIdx] ?? 0;
                const intensity = count / gridMax;
                const hue = 200 + eIdx * 22; // cyan → violet across energy
                const fill = `oklch(${(0.34 + 0.22 * intensity).toFixed(3)} ${(0.06 + 0.13 * intensity).toFixed(3)} ${hue} / ${(0.18 + 0.62 * intensity).toFixed(3)})`;
                return (
                  <button
                    key={`c-${dIdx}-${eIdx}`}
                    type="button"
                    onClick={() => onSelect(`energy:${e[0]}-${e[1]} darkness:${d[0]}-${d[1]}`)}
                    title={`ένταση ${e[0]}–${e[1]} · σκοτάδι ${d[0]}–${d[1]} → ${count} tracks`}
                    aria-label={`Ένταση ${e[0]} έως ${e[1]}, σκοτάδι ${d[0]} έως ${d[1]}: ${count} tracks`}
                    className="grid aspect-square place-items-center rounded-md border border-white/10 font-mono text-xs tabular-nums text-white/90 transition hover:brightness-150 hover:border-cm-cyan/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-cyan/50"
                    style={{ background: fill }}
                  >
                    {count > 0 ? count : ""}
                  </button>
                );
              })}
            </FragmentRow>
          );
        })}
      </div>
      <div className="flex items-center justify-between text-[10px] text-cm-faint">
        <span>← χαμηλή ένταση · υψηλή ένταση →</span>
        <span>↑ βαθύ σκοτάδι</span>
      </div>
    </div>
  );
}

// CSS-grid rows need their cells as direct children of the grid; group via fragment.
function FragmentRow({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
