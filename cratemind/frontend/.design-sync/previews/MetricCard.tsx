import { MetricCard } from 'cratemind-frontend'

export function Tones() {
  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      <MetricCard value={2847} label="Tracks" tone="cyan" />
      <MetricCard value={342} label="Approved" tone="chartreuse" />
      <MetricCard value={23} label="Duplicates" tone="amber" />
      <MetricCard value={12} label="Retired" tone="rose" />
    </div>
  )
}

export function WithHint() {
  return <MetricCard value={89} label="Testing" hint="Awaiting review" tone="blue" />
}
