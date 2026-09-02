import { GlassCard, Badge } from 'cratemind-frontend'

export function Default() {
  return (
    <div style={{ background: 'oklch(0.12 0.028 274)', padding: 24, borderRadius: 12 }}>
      <GlassCard className="p-5" style={{ maxWidth: 340 }}>
        <h3 style={{ fontWeight: 600, marginBottom: 4 }}>Now Playing</h3>
        <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 12 }}>Cosmic Gate — Exploration Of Space</p>
        <div style={{ display: 'flex', gap: 6 }}>
          <Badge variant="outline">128 BPM</Badge>
          <Badge variant="outline">8A</Badge>
        </div>
      </GlassCard>
    </div>
  )
}

export function Interactive() {
  return (
    <div style={{ background: 'oklch(0.12 0.028 274)', padding: 24, borderRadius: 12 }}>
      <GlassCard interactive className="p-5" style={{ maxWidth: 340 }}>
        <h3 style={{ fontWeight: 600, marginBottom: 4 }}>Set Builder</h3>
        <p style={{ fontSize: 13, opacity: 0.7 }}>14 tracks · 1h 23m</p>
      </GlassCard>
    </div>
  )
}
