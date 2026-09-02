import { GlassPanel } from 'cratemind-frontend'

export function Default() {
  return (
    <div style={{ background: 'oklch(0.12 0.028 274)', padding: 24, borderRadius: 12 }}>
      <GlassPanel className="p-5" style={{ maxWidth: 360 }}>
        <h3 style={{ fontWeight: 600, marginBottom: 8 }}>Library Stats</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, opacity: 0.8 }}>
          <span>2,847 tracks scanned</span>
          <span>342 approved · 89 testing · 12 retired</span>
          <span>23 duplicate groups found</span>
        </div>
      </GlassPanel>
    </div>
  )
}
