import { EnergyMeter } from 'cratemind-frontend'

export function EnergyLevels() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 12, width: 60 }}>Low</span>
        <EnergyMeter value={2} metric="energy" />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 12, width: 60 }}>Medium</span>
        <EnergyMeter value={5} metric="energy" />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 12, width: 60 }}>High</span>
        <EnergyMeter value={8} metric="energy" />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 12, width: 60 }}>Max</span>
        <EnergyMeter value={10} metric="energy" />
      </div>
    </div>
  )
}

export function DarknessLevels() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 12, width: 60 }}>Light</span>
        <EnergyMeter value={2} metric="darkness" />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 12, width: 60 }}>Mid</span>
        <EnergyMeter value={5} metric="darkness" />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 12, width: 60 }}>Dark</span>
        <EnergyMeter value={9} metric="darkness" />
      </div>
    </div>
  )
}

export function NullValue() {
  return <EnergyMeter value={null} />
}

export function NoLabel() {
  return <EnergyMeter value={7} showValue={false} />
}
