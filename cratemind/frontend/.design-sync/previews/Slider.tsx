import { Slider } from 'cratemind-frontend'

export function Default() {
  return <Slider defaultValue={[50]} max={100} style={{ maxWidth: 280 }} />
}

export function Range() {
  return <Slider defaultValue={[25, 75]} max={100} style={{ maxWidth: 280 }} />
}
