import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { PageHeader } from "../components/ui/PageHeader";
import { api } from "../lib/api";
import { energyMapAxes, energyMapTitle, type EnergyMapAxes } from "../lib/energyMapAxes";
import { usePref } from "../lib/prefs";
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

// Page copy per profile. DJ: energy × darkness; therapy: arousal × valence (the second axis is valence).
const COPY = {
  dj: {
    subtitle: "Κατανομή έντασης & σκοταδιού — ακριβείς μετρήσεις",
    empty: "Δεν υπάρχουν tracks ακόμη. Κάνε import/scan και ταξινόμησε ένταση & σκοτάδι για να γεμίσουν οι χάρτες.",
    tiles: ["Με ένταση", "Με σκοτάδι", "Χωρίς tags"],
    gauges: ["Ένταση", "Σκοτάδι"],
    energyTitle: "Κατανομή έντασης",
    energyHint: "Κλικ σε μπάρα → Library φιλτραρισμένη σε αυτή την ένταση.",
    secondTitle: "Κατανομή σκοταδιού",
    secondHint: "Κλικ σε μπάρα → Library φιλτραρισμένη σε αυτό το σκοτάδι.",
    gridTitle: "Ένταση × Σκοτάδι",
    gridLabel: "Πλέγμα έντασης επί σκοταδιού",
  },
  therapy: {
    subtitle: "Κατανομή διέγερσης & συναισθηματικού σθένους — ακριβείς μετρήσεις",
    empty: "Δεν υπάρχουν tracks ακόμη. Κάνε σάρωση ή εισαγωγή και ταξινόμησε διέγερση & σθένος για να γεμίσουν οι χάρτες.",
    tiles: ["Με διέγερση", "Με σθένος", "Αταξινόμητα"],
    gauges: ["Διέγερση", "Σθένος"],
    energyTitle: "Κατανομή διέγερσης",
    energyHint: "Κλικ σε μπάρα → Βιβλιοθήκη φιλτραρισμένη σε αυτή τη διέγερση.",
    secondTitle: "Κατανομή σθένους",
    secondHint: "Κλικ σε μπάρα → Βιβλιοθήκη φιλτραρισμένη σε αυτό το σθένος.",
    gridTitle: "Διέγερση × Συναισθηματικό σθένος",
    gridLabel: "Πλέγμα διέγερσης επί σθένους",
  },
};

export default function EnergyMaps() {
  const nav = useNavigate();
  const go = (q: string) => nav("/library?q=" + encodeURIComponent(q));
  const [profile] = usePref("libraryProfile");
  const therapy = profile === "therapy";
  const copy = COPY[profile];
  const axes = useMemo(() => energyMapAxes(profile), [profile]);
  const secondField = therapy ? "valence" : "darkness"; // the second histogram

  const [energy, setEnergy] = useState<number[]>([]);
  const [second, setSecond] = useState<number[]>([]);
  const [roles, setRoles] = useState<Record<string, number>>({});
  const [grid, setGrid] = useState<number[][]>([]); // [row][col] in display order
  const [total, setTotal] = useState(0);
  const [untagged, setUntagged] = useState(0);
  const [loading, setLoading] = useState(true);

  const containerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    // Exact bucket counts — NOT a sampled list. Each call is `/tracks/count`.
    const [energyData, secondData, roleEntries, untaggedR, totalR] = await Promise.all([
      Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          api.trackCount(`energy:${i + 1}`).then((r) => r.count).catch(() => 0),
        ),
      ),
      Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          api.trackCount(`${secondField}:${i + 1}`).then((r) => r.count).catch(() => 0),
        ),
      ),
      // Therapy has no set roles: skip the 6 role counts.
      therapy ? Promise.resolve([]) : Promise.all(
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
      axes.rows.bands.map((r) =>
        Promise.all(
          axes.cols.bands.map((c) =>
            api
              .trackCount(axes.cellQuery(c, r))
              .then((x) => x.count)
              .catch(() => 0),
          ),
        ),
      ),
    );

    setEnergy(energyData);
    setSecond(secondData);
    setRoles(Object.fromEntries(roleEntries));
    setUntagged(untaggedR);
    setTotal(totalR);
    setGrid(gridData);
    setLoading(false);
  }, [axes, secondField, therapy]);

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
    // Run once on mount: the [data-reveal] wrappers persist through loading. Re-running
    // on `loading` started a second from-tween mid-flight and froze cards near opacity 0.
    { scope: containerRef },
  );

  const energyTagged = energy.reduce((a, b) => a + b, 0);
  const secondTagged = second.reduce((a, b) => a + b, 0);
  const tagCoverage = total > 0 ? (total - untagged) / total : 0;
  const energyCoverage = total > 0 ? energyTagged / total : 0;
  const secondCoverage = total > 0 ? secondTagged / total : 0;
  const gridMax = Math.max(1, ...grid.flat());

  const TILES: { label: string; value: number | string; tone: ChipTone; icon: IconType }[] = [
    { label: "Tracks", value: loading ? "…" : total, tone: "cyan", icon: Music2 },
    { label: copy.tiles[0], value: loading ? "…" : energyTagged, tone: "amber", icon: Flame },
    { label: copy.tiles[1], value: loading ? "…" : secondTagged, tone: "violet", icon: Moon },
    { label: copy.tiles[2], value: loading ? "…" : untagged, tone: "blue", icon: Tags },
  ];

  const empty = !loading && total === 0;

  return (
    <div ref={containerRef} className="h-full overflow-y-auto overflow-x-hidden">
      <PageHeader sticky icon={BarChart3} title={energyMapTitle(profile)} subtitle={copy.subtitle} />

      <div className="space-y-6 px-6 pt-5 pb-10">
        {empty ? (
          <EmptyState icon={BarChart3} title="Κενή βιβλιοθήκη">
            {copy.empty}
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
                <Gauge value={energyCoverage} size={92} tone="amber" sub={copy.gauges[0]} />
                <Gauge value={secondCoverage} size={92} tone="violet" sub={copy.gauges[1]} />
              </div>
              <p className="mt-3 text-center text-[11px] text-cm-faint">
                Ποσοστά επί {total.toLocaleString("el-GR")} tracks — ακριβείς μετρήσεις, όχι δείγμα.
              </p>
            </GlassPanel>

            {/* Energy + Darkness histograms */}
            <div className="grid gap-6 lg:grid-cols-2">
              <GlassPanel className="p-5" data-reveal>
                <SectionHeader right={<Flame className="h-3.5 w-3.5 text-cm-amber" />}>
                  {copy.energyTitle}
                </SectionHeader>
                {loading ? (
                  <div className="h-[140px] animate-pulse rounded-xl bg-cm-contrast/[0.03]" />
                ) : (
                  <Bars
                    data={energy.map((c, i) => ({ label: String(i + 1), value: c, tone: ENERGY_TONES[i] }))}
                    height={140}
                    onSelect={(lbl) => go(`energy:${lbl}`)}
                    className="w-full"
                  />
                )}
                <p className="mt-2 text-[11px] text-cm-faint">{copy.energyHint}</p>
              </GlassPanel>

              <GlassPanel className="p-5" data-reveal>
                <SectionHeader right={<Moon className="h-3.5 w-3.5 text-cm-violet" />}>
                  {copy.secondTitle}
                </SectionHeader>
                {loading ? (
                  <div className="h-[140px] animate-pulse rounded-xl bg-cm-contrast/[0.03]" />
                ) : (
                  <Bars
                    data={second.map((c, i) => ({ label: String(i + 1), value: c, tone: DARK_TONES[i] }))}
                    height={140}
                    onSelect={(lbl) => go(`${secondField}:${lbl}`)}
                    className="w-full"
                  />
                )}
                <p className="mt-2 text-[11px] text-cm-faint">{copy.secondHint}</p>
              </GlassPanel>
            </div>

            {/* Roles (DJ only) + 2D grid */}
            <div className={therapy ? "grid max-w-3xl gap-6" : "grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]"}>
              {!therapy && <GlassPanel className="p-5" data-reveal>
                <SectionHeader right={<Waypoints className="h-3.5 w-3.5 text-cm-cyan" />}>
                  Ρόλοι στο set
                </SectionHeader>
                {loading ? (
                  <div className="h-[130px] animate-pulse rounded-xl bg-cm-contrast/[0.03]" />
                ) : (
                  <Bars
                    data={ROLES.map((r) => ({ label: r.code, value: roles[r.code] ?? 0, tone: r.tone }))}
                    height={130}
                    onSelect={(lbl) => go(`role:${lbl}`)}
                    className="w-full"
                  />
                )}
                <p className="mt-2 text-[11px] text-cm-faint">Κλικ → Library με <span className="font-mono">role:&lt;ρόλος&gt;</span>.</p>
              </GlassPanel>}

              <GlassPanel className="p-5" data-reveal>
                <SectionHeader right={<Grid3x3 className="h-3.5 w-3.5 text-cm-magenta" />}>
                  {copy.gridTitle}
                </SectionHeader>
                {loading ? (
                  <div className="h-[230px] animate-pulse rounded-xl bg-cm-contrast/[0.03]" />
                ) : (
                  <MapGrid grid={grid} gridMax={gridMax} axes={axes} label={copy.gridLabel} onSelect={go} />
                )}
              </GlassPanel>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** 5×5 heat grid: `axes.cols` (low→high) × `axes.rows` (high→low). Each cell = exact count. */
function MapGrid({
  grid,
  gridMax,
  axes,
  label,
  onSelect,
}: {
  grid: number[][];
  gridMax: number;
  axes: EnergyMapAxes;
  label: string;
  onSelect: (q: string) => void;
}) {
  if (!grid.length) return null;
  const { cols, rows } = axes;
  const colWord = cols.label.toLocaleLowerCase("el");
  const rowWord = rows.label.toLocaleLowerCase("el");
  return (
    <div className="space-y-2">
      <div
        className="grid items-stretch gap-1.5"
        style={{ gridTemplateColumns: `auto repeat(5, minmax(0, 1fr))` }}
        role="grid"
        aria-label={label}
      >
        {/* corner */}
        <div aria-hidden />
        {/* column band headers */}
        {cols.bands.map((c) => (
          <div key={`eh-${c[0]}`} className="pb-0.5 text-center font-mono text-[9px] text-cm-faint">
            {c[0]}–{c[1]}
          </div>
        ))}

        {rows.bands.map((r, rIdx) => (
          <FragmentRow key={`row-${r[0]}`}>
            <div className="flex items-center justify-end pr-1 font-mono text-[9px] text-cm-faint">
              {r[0]}–{r[1]}
            </div>
            {cols.bands.map((c, cIdx) => {
              const count = grid[rIdx]?.[cIdx] ?? 0;
              const intensity = count / gridMax;
              const hue = 200 + cIdx * 22; // cyan → violet across the columns
              const fill = `oklch(${(0.34 + 0.22 * intensity).toFixed(3)} ${(0.06 + 0.13 * intensity).toFixed(3)} ${hue} / ${(0.18 + 0.62 * intensity).toFixed(3)})`;
              return (
                <button
                  key={`c-${r[0]}-${c[0]}`}
                  type="button"
                  onClick={() => onSelect(axes.cellQuery(c, r))}
                  title={`${colWord} ${c[0]}–${c[1]} · ${rowWord} ${r[0]}–${r[1]} → ${count} tracks`}
                  aria-label={`${cols.label} ${c[0]} έως ${c[1]}, ${rowWord} ${r[0]} έως ${r[1]}: ${count} tracks`}
                  className="grid aspect-square place-items-center rounded-md border border-white/10 font-mono text-xs tabular-nums text-white/90 transition hover:brightness-150 hover:border-cm-cyan/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-cyan/50"
                  style={{ background: fill }}
                >
                  {count > 0 ? count : ""}
                </button>
              );
            })}
          </FragmentRow>
        ))}
      </div>
      <div className="flex items-center justify-between text-[10px] text-cm-faint">
        <span>{cols.legend}</span>
        <span>{rows.legend}</span>
      </div>
    </div>
  );
}

// CSS-grid rows need their cells as direct children of the grid; group via fragment.
function FragmentRow({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
