import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup, SelectLabel } from 'cratemind-frontend'

export function Default() {
  return (
    <Select>
      <SelectTrigger style={{ width: 200 }}>
        <SelectValue placeholder="Set role…" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Roles</SelectLabel>
          <SelectItem value="opener">Opener</SelectItem>
          <SelectItem value="warmup">Warm-up</SelectItem>
          <SelectItem value="peak">Peak-time</SelectItem>
          <SelectItem value="closer">Closer</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
