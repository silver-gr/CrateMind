import { Button } from 'cratemind-frontend'

export function Variants() {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <Button>Default</Button>
      <Button variant="destructive">Destructive</Button>
      <Button variant="outline">Outline</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="link">Link</Button>
    </div>
  )
}

export function Sizes() {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <Button size="xs">Extra Small</Button>
      <Button size="sm">Small</Button>
      <Button size="default">Default</Button>
      <Button size="lg">Large</Button>
    </div>
  )
}

export function States() {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <Button>Enabled</Button>
      <Button disabled>Disabled</Button>
    </div>
  )
}

export function IconButtons() {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <Button size="icon-xs" variant="ghost">✕</Button>
      <Button size="icon-sm" variant="outline">⟨</Button>
      <Button size="icon">▶</Button>
      <Button size="icon-lg" variant="secondary">⚙</Button>
    </div>
  )
}
