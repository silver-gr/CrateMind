import { ElectricFrame } from 'cratemind-frontend'

export function Default() {
  return (
    <div style={{ background: 'oklch(0.12 0.028 274)', padding: 24, borderRadius: 12 }}>
      <ElectricFrame>
        <div style={{ padding: 24, background: 'oklch(0.20 0.040 274)', borderRadius: 16 }}>
          <h3 style={{ fontWeight: 600, marginBottom: 4 }}>Hero Section</h3>
          <p style={{ fontSize: 13, opacity: 0.7 }}>Animated electric border frame</p>
        </div>
      </ElectricFrame>
    </div>
  )
}
