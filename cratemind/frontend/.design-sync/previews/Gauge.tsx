import { Gauge } from 'cratemind-frontend'

export function EnergyGauge() {
  return (
    <div style={{ display: 'flex', gap: 24, alignItems: 'flex-end' }}>
      <Gauge value={3} max={10} label="Low" />
      <Gauge value={7} max={10} label="High" />
      <Gauge value={10} max={10} label="Max" />
    </div>
  )
}
