import { Separator } from 'cratemind-frontend'

export function Horizontal() {
  return (
    <div style={{ maxWidth: 300 }}>
      <p style={{ fontSize: 13, marginBottom: 8 }}>Track Details</p>
      <Separator />
      <p style={{ fontSize: 13, marginTop: 8 }}>Transition Notes</p>
    </div>
  )
}
