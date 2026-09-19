import { Badge } from 'cratemind-frontend'

export function Variants() {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <Badge>Default</Badge>
      <Badge variant="secondary">Secondary</Badge>
      <Badge variant="outline">Outline</Badge>
      <Badge variant="destructive">Destructive</Badge>
    </div>
  )
}

export function DJContexts() {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <Badge variant="outline">128 BPM</Badge>
      <Badge variant="outline">8A</Badge>
      <Badge variant="secondary">FLAC</Badge>
      <Badge variant="destructive">Duplicate</Badge>
    </div>
  )
}
