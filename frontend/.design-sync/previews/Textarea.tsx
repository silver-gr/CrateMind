import { Textarea } from 'cratemind-frontend'

export function Default() {
  return <Textarea placeholder="Transition notes…" style={{ maxWidth: 320 }} />
}

export function WithContent() {
  return (
    <Textarea
      defaultValue="Mix into 8B at the break. EQ swap works best — cut lows on outgoing, bring in slowly over 16 bars."
      style={{ maxWidth: 320 }}
    />
  )
}
