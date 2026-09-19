import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, CardAction, Button, Badge } from 'cratemind-frontend'

export function BasicCard() {
  return (
    <Card style={{ maxWidth: 380 }}>
      <CardHeader>
        <CardTitle>Track Analysis</CardTitle>
        <CardDescription>Energy and harmonic profile for the selected track</CardDescription>
      </CardHeader>
      <CardContent>
        <p style={{ fontSize: 14 }}>BPM: 128 · Key: 8A · Duration: 6:42</p>
      </CardContent>
      <CardFooter style={{ gap: 8 }}>
        <Button size="sm">Approve</Button>
        <Button variant="outline" size="sm">Skip</Button>
      </CardFooter>
    </Card>
  )
}

export function WithAction() {
  return (
    <Card style={{ maxWidth: 380 }}>
      <CardHeader>
        <CardTitle>Duplicate Group</CardTitle>
        <CardDescription>3 tracks with matching fingerprints</CardDescription>
        <CardAction>
          <Badge variant="outline">Review</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
          <span>Cosmic Gate — Exploration Of Space (Original).flac</span>
          <span>Cosmic Gate — Exploration Of Space (320).mp3</span>
          <span>Cosmic Gate — Exploration Of Space.aiff</span>
        </div>
      </CardContent>
    </Card>
  )
}
