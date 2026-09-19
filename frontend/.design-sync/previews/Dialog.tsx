import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, Button } from 'cratemind-frontend'

export function Open() {
  return (
    <Dialog open>
      <DialogContent style={{ position: 'relative', transform: 'none', maxWidth: 420 }}>
        <DialogHeader>
          <DialogTitle>Confirm Export</DialogTitle>
          <DialogDescription>Export 14 tracks as M3U8 playlist to your output folder?</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm">Cancel</Button>
          <Button size="sm">Export</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
