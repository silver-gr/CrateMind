import { SmartChip } from 'cratemind-frontend'

export function Tones() {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <SmartChip tone="cyan">Trance</SmartChip>
      <SmartChip tone="violet">Progressive</SmartChip>
      <SmartChip tone="chartreuse">Peak-time</SmartChip>
      <SmartChip tone="amber">Warm-up</SmartChip>
      <SmartChip tone="rose">Avoid</SmartChip>
      <SmartChip tone="muted">Untagged</SmartChip>
    </div>
  )
}

export function Active() {
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <SmartChip tone="cyan" active>Selected</SmartChip>
      <SmartChip tone="violet">Not selected</SmartChip>
    </div>
  )
}
