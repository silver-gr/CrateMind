import { Input } from 'cratemind-frontend'

export function Default() {
  return <Input placeholder="Search tracks…" style={{ maxWidth: 300 }} />
}

export function Disabled() {
  return <Input placeholder="Locked" disabled style={{ maxWidth: 300 }} />
}

export function WithValue() {
  return <Input defaultValue="Cosmic Gate" style={{ maxWidth: 300 }} />
}
