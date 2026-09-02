import { Segmented } from 'cratemind-frontend'

export function Default() {
  return (
    <Segmented
      options={['All', 'Approved', 'Testing', 'Retired']}
      value="All"
      onChange={() => {}}
    />
  )
}
