import { SectionHeader, Badge } from 'cratemind-frontend'

export function Default() {
  return <SectionHeader>Library Overview</SectionHeader>
}

export function WithRight() {
  return (
    <SectionHeader right={<Badge variant="outline">23 new</Badge>}>
      Recent Imports
    </SectionHeader>
  )
}
