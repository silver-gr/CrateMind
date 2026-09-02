import { Switch } from 'cratemind-frontend'

export function States() {
  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <Switch /> Off
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <Switch defaultChecked /> On
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <Switch disabled /> Disabled
      </label>
    </div>
  )
}
