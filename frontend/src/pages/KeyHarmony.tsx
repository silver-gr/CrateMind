import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { KeyStats } from "../lib/types";
import { GlassPanel } from "../components/ui/GlassPanel";
import { MetricCard } from "../components/ui/MetricCard";
import { SectionHeader } from "../components/ui/SectionHeader";
import { EmptyState } from "../components/ui/EmptyState";
import { Button, buttonVariants } from "../components/ui/button";
import { Gauge } from "../components/ui/Gauge";
import { KeyWheel } from "../components/ui/KeyWheel";
import { ALL_CAMELOT, CAMELOT_TO_MUSICAL, toCamelot, camelotCode, keyColor, neighbors } from "../lib/camelot";
import { cn } from "../lib/cn";
import { KeyRound, ArrowRight, Compass, Music2, RefreshCw, TriangleAlert } from "../lib/icons";

const fmt = (n: number) => n.toLocaleString("el-GR");
const libraryUrl = (code: string) => `/library?q=${encodeURIComponent(`key:${code}`)}`;
const NEIGHBOR_LABELS = ["Επόμενο στον κύκλο (+1)", "Προηγούμενο στον κύκλο (−1)", "Σχετικό major / minor"];
const METRIC_CLASS = "p-2 [&_.text-4xl]:text-2xl [&_.text-sm]:text-xs [&_svg]:hidden sm:p-4 sm:[&_.text-4xl]:text-4xl sm:[&_.text-sm]:text-sm sm:[&_svg]:block";

function KeySelection({ code, counts, onSelect }: {
  code: string;
  counts: Record<string, number>;
  onSelect: (code: string) => void;
}) {
  const cam = toCamelot(code)!;
  const count = counts[code] ?? 0;
  return (
    <GlassPanel strong className="p-5">
      <SectionHeader>Επιλεγμένο key</SectionHeader>
      <div aria-live="polite" aria-atomic="true" className="mb-5 flex items-center gap-4">
        <span className="grid h-16 w-16 shrink-0 place-items-center rounded-xl bg-cm-cyan/10 font-mono text-2xl font-bold text-cm-cyan">
          {code}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-xl font-semibold text-cm-text">{CAMELOT_TO_MUSICAL[code]}</h3>
          <p className="text-sm text-cm-muted">{cam.side === "A" ? "Minor" : "Major"} · {fmt(count)} tracks</p>
        </div>
      </div>
      {count > 0 ? (
        <Link to={libraryUrl(code)} className={cn(buttonVariants(), "w-full bg-cm-cyan text-cm-bg hover:bg-cm-cyan/85")}>
          Προβολή {fmt(count)} tracks <ArrowRight aria-hidden="true" />
        </Link>
      ) : (
        <Button disabled className="w-full">Δεν υπάρχουν tracks σε {code}</Button>
      )}
      <h3 className="mt-6 mb-3 text-sm font-medium text-cm-text">Αρμονικά γειτονικά keys</h3>
      <ul className="divide-y divide-cm-border">
        {neighbors(cam).map(camelotCode).map((neighbor, i) => (
          <li key={neighbor}>
            <button
              type="button"
              onClick={() => onSelect(neighbor)}
              aria-label={`${neighbor}, ${CAMELOT_TO_MUSICAL[neighbor]}, ${NEIGHBOR_LABELS[i]}, ${fmt(counts[neighbor] ?? 0)} tracks`}
              className="flex min-h-16 w-full items-center gap-3 rounded-md px-1 py-3 text-left transition-colors hover:bg-cm-cyan/5 focus-visible:outline-2 focus-visible:outline-cm-cyan"
            >
              <span className="w-10 shrink-0 font-mono text-base font-semibold text-cm-cyan">{neighbor}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-cm-text">{CAMELOT_TO_MUSICAL[neighbor]}</span>
                <span className="block text-xs text-cm-muted">{NEIGHBOR_LABELS[i]}</span>
              </span>
              <span className="font-mono text-sm tabular-nums text-cm-muted">{fmt(counts[neighbor] ?? 0)}</span>
              <ArrowRight aria-hidden="true" className="size-3.5 shrink-0 text-cm-muted" />
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-xs leading-relaxed text-cm-muted">
        Η αρμονική γειτνίαση είναι οδηγός μίξης. Έλεγξε επίσης BPM, φράση και το αποτέλεσμα με ακρόαση.
      </p>
    </GlassPanel>
  );
}

export default function KeyHarmony() {
  const [stats, setStats] = useState<KeyStats | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    api.keyStats(controller.signal).then((data) => {
      if (controller.signal.aborted) return;
      setStats(data);
      const mostCommon = ALL_CAMELOT.filter((code) => data.counts[code] > 0)
        .sort((a, b) => data.counts[b] - data.counts[a])[0];
      setSelected((current) => current ?? mostCommon ?? null);
    }).catch(() => {
      if (!controller.signal.aborted) setError(true);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [revision]);

  const distinct = Object.values(stats?.counts ?? {}).filter((count) => count > 0).length;
  const coverage = stats?.total ? stats.keyed / stats.total : 0;
  const ranked = ALL_CAMELOT.filter((code) => (stats?.counts[code] ?? 0) > 0)
    .sort((a, b) => stats!.counts[b] - stats!.counts[a]);

  return (
    <div className="h-full overflow-y-auto" aria-busy={loading}>
      <header className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-cm-border bg-cm-bg/95 px-4 py-4 sm:px-6">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-lg font-semibold text-cm-text">
            <KeyRound aria-hidden="true" className="size-5 text-cm-cyan" /> Key &amp; Harmony
          </h1>
          <p className="mt-1 text-xs text-cm-muted">Εξερεύνησε τα keys σου και βρες αρμονικά ταιριάσματα.</p>
        </div>
        <Button variant="outline" size="sm" aria-label="Ανανέωση δεδομένων" disabled={loading} onClick={() => setRevision((r) => r + 1)}>
          <RefreshCw aria-hidden="true" className={loading ? "motion-safe:animate-spin" : ""} /><span className="sr-only sm:not-sr-only">Ανανέωση</span>
        </Button>
      </header>

      <div className="mx-auto max-w-7xl space-y-5 px-4 pt-5 pb-28 sm:px-6">
        {error ? (
          <div role="alert">
            <EmptyState icon={TriangleAlert} title="Δεν φορτώθηκαν τα δεδομένα των keys" action={
              <Button variant="outline" onClick={() => setRevision((r) => r + 1)}>Δοκίμασε ξανά</Button>
            }>
              Δεν ήταν δυνατή η σύνδεση με τη βιβλιοθήκη. Δοκίμασε ξανά για να δεις τις μετρήσεις.
            </EmptyState>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2 sm:gap-3">
              <MetricCard className={METRIC_CLASS} label={<><span className="sm:hidden">Σύνολο</span><span className="hidden sm:inline">Tracks στη βιβλιοθήκη</span></>} value={fmt(stats?.total ?? 0)} icon={Music2} tone="cyan" loading={loading} />
              <MetricCard className={METRIC_CLASS} label={<><span className="sm:hidden">Με key</span><span className="hidden sm:inline">Με αναγνωρίσιμο key</span></>} value={fmt(stats?.keyed ?? 0)} icon={KeyRound} tone="chartreuse" loading={loading} />
              <MetricCard className={METRIC_CLASS} label={<><span className="sm:hidden">Keys</span><span className="hidden sm:inline">Διαφορετικά keys</span></>} value={`${distinct}/24`} icon={Compass} tone="violet" loading={loading} />
            </div>

            {loading ? (
              <GlassPanel className="flex min-h-80 items-center justify-center p-6" role="status">
                <p className="text-sm text-cm-muted">Φόρτωση κατανομής keys…</p>
              </GlassPanel>
            ) : stats && stats.keyed === 0 ? (
              <EmptyState icon={KeyRound} title={stats.total === 0 ? "Η βιβλιοθήκη είναι κενή" : "Δεν βρέθηκαν αναγνωρίσιμα keys"} action={
                <Link to="/settings" className={buttonVariants({ variant: "outline" })}>Άνοιγμα ρυθμίσεων</Link>
              }>
                {stats.total === 0
                  ? "Πρόσθεσε τη βιβλιοθήκη σου από τις ρυθμίσεις για να εξερευνήσεις τα keys της."
                  : `Διαβάζουμε key από τα metadata ή την ανάλυση ήχου. Χωρίς key: ${fmt(stats.missing)} tracks. Μη αναγνωρίσιμες τιμές: ${fmt(stats.unrecognized)}. Μπορείς να ξεκινήσεις ανάλυση από τις ρυθμίσεις.`}
              </EmptyState>
            ) : stats && (
              <>
                <GlassPanel className="p-4 sm:p-5">
                  <div className="flex flex-col gap-5 lg:flex-row lg:items-center">
                    <div className="flex items-center gap-3 lg:max-w-72">
                      <Gauge value={coverage} size={60} tone="cyan" label={`${(coverage * 100).toLocaleString("el-GR", { maximumFractionDigits: 2 })}%`} className="shrink-0" />
                      <div><h2 className="text-sm font-medium text-cm-text">Κάλυψη βιβλιοθήκης</h2><p className="mt-1 text-xs leading-relaxed text-cm-muted">Metadata πρώτα, αλλιώς ανάλυση ήχου. Τα keys της ανάλυσης είναι εκτιμήσεις.</p></div>
                    </div>
                    <dl className="grid flex-1 grid-cols-2 gap-4 sm:grid-cols-4">
                      {([["Από metadata", stats.metadata], ["Από ανάλυση ήχου", stats.analyzed], ["Χωρίς key", stats.missing], ["Μη αναγνωρίσιμη τιμή", stats.unrecognized]] as const).map(([label, value]) => (
                        <div key={label}><dt className="text-xs text-cm-muted">{label}</dt><dd className="mt-1 font-mono text-lg tabular-nums text-cm-text">{fmt(value)}</dd></div>
                      ))}
                    </dl>
                  </div>
                </GlassPanel>
                <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
                  <GlassPanel strong className="min-w-0 p-4 sm:p-6">
                    <SectionHeader right={<span className="text-xs text-cm-muted">{fmt(distinct)} από 24 keys</span>}>Τροχός Camelot</SectionHeader>
                    <p id="wheel-instructions" className="mb-4 text-sm text-cm-muted">
                      Διάλεξε key για να δεις τα tracks και τους αρμονικούς γείτονές του.
                    </p>
                    <div className="mx-auto max-w-[400px]">
                      <KeyWheel counts={stats.counts} selected={selected} onSelect={setSelected} size={400} className="h-auto w-full" />
                    </div>
                    <div className="mt-4 flex flex-wrap justify-center gap-x-5 gap-y-1 text-xs text-cm-muted">
                      <span>A · Minor (εσωτερικά)</span><span>B · Major (εξωτερικά)</span>
                    </div>
                    <p className="mt-3 text-center text-xs leading-relaxed text-cm-muted">
                      Φωτεινότητα = πλήθος tracks. Το επιλεγμένο key έχει παχύ περίγραμμα, οι γείτονες διακεκομμένο.
                    </p>
                  </GlassPanel>

                  <div className="min-w-0">
                    {selected && <KeySelection code={selected} counts={stats.counts} onSelect={setSelected} />}
                  </div>
                </div>

                <GlassPanel className="p-4 sm:p-5">
                  <SectionHeader>Keys ανά πλήθος tracks</SectionHeader>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {ranked.map((code) => (
                      <button
                        key={code}
                        type="button"
                        aria-pressed={selected === code}
                        onClick={() => setSelected(code)}
                        className={cn("relative isolate flex min-h-12 items-center gap-3 overflow-hidden rounded-lg border px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-cm-cyan", selected === code ? "border-cm-cyan bg-cm-cyan/10" : "border-cm-border hover:border-cm-cyan/50")}
                      >
                        <span aria-hidden="true" className="absolute inset-y-0 left-0 -z-10 bg-cm-cyan/5" style={{ width: `${stats.counts[code] / stats.counts[ranked[0]] * 100}%` }} />
                        <span className="w-9 shrink-0 font-mono font-semibold" style={{ color: keyColor(code) }}>{code}</span>
                        <span className="flex-1 text-sm text-cm-muted">{CAMELOT_TO_MUSICAL[code]}</span>
                        <span className="font-mono text-sm tabular-nums text-cm-text">{fmt(stats.counts[code])}</span>
                      </button>
                    ))}
                  </div>
                </GlassPanel>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
