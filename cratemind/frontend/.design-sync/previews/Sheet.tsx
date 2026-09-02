import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, Button } from 'cratemind-frontend'

export function Open() {
  return (
    <Sheet open>
      <SheetContent style={{ position: 'relative', transform: 'none', maxWidth: 400, minHeight: 300 }}>
        <SheetHeader>
          <SheetTitle>Track Details</SheetTitle>
          <SheetDescription>Cosmic Gate — Exploration Of Space</SheetDescription>
        </SheetHeader>
        <div style={{ padding: '16px 24px', fontSize: 13 }}>
          <p>BPM: 128 · Key: 8A · Duration: 6:42</p>
          <p style={{ marginTop: 8, opacity: 0.7 }}>Format: FLAC · 1411 kbps</p>
        </div>
      </SheetContent>
    </Sheet>
  )
}
