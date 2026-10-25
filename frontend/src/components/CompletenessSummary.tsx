import { useEffect, useState } from 'react';
import { identityRequest } from './CompletenessControls';
import { BentoSpotlight } from './ui/BentoSpotlight';
import { MetricCard } from './ui/MetricCard';

type CompletenessMetrics = Record<string, number>;

export function useCompletenessMetrics(enabled = true) {
  const [metrics, setMetrics] = useState<CompletenessMetrics | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    identityRequest<CompletenessMetrics>('completeness-summary')
      .then(value => { if (active) setMetrics(value); })
      .catch(() => {});
    return () => { active = false; };
  }, [enabled]);
  return metrics;
}

export default function CompletenessSummary({ metrics }: { metrics: CompletenessMetrics | null }) {
  return (
    <section aria-label="Πληρότητα βιβλιοθήκης">
    <BentoSpotlight className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <MetricCard className="bento-card" loading={metrics === null} value={metrics?.locally_playable ?? '…'} label="Διαθέσιμα τοπικά" tone="chartreuse" />
      <MetricCard className="bento-card" loading={metrics === null} value={metrics?.remote_only ?? '…'} label="Μόνο σε πηγές" tone="blue" />
      <MetricCard className="bento-card" loading={metrics === null} value={metrics?.local_missing_files ?? '…'} label="Μη διαθέσιμες τοπικές ομάδες" tone="amber" />
      <MetricCard className="bento-card" loading={metrics === null} value={metrics?.in_recovery_queue ?? '…'} label="Προς απόκτηση" tone="violet" />
      <div className="col-span-2 flex items-center justify-center">
        <a href="/recovery" className="flex w-full max-w-[300px] items-center justify-center rounded-xl border border-cm-cyan/25 bg-cm-cyan/12 px-3 py-2 text-sm font-medium text-cm-cyan transition hover:border-cm-cyan/40 hover:bg-cm-cyan/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-cyan/50">
          Πληρότητα βιβλιοθήκης →
        </a>
      </div>
    </BentoSpotlight>
    </section>
  );
}
