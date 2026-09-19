import { EmptyState } from 'cratemind-frontend'

export function Default() {
  return (
    <EmptyState
      title="No tracks found"
      description="Try adjusting your search or scan a new folder"
      style={{ maxWidth: 400 }}
    />
  )
}
