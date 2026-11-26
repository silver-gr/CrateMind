import * as React from "react"
import { CheckIcon, ChevronRightIcon } from "lucide-react"
import { ContextMenu as ContextMenuPrimitive } from "radix-ui"

import { cn } from "@/lib/cn"
import { shownEntries, type MenuEntry, type MenuSource } from "@/lib/menus/entries"
import { allowsNativeMenu } from "@/lib/nativeContextMenu"

/* Same surface as Select, Popover and SetActions: surface-menu, rounded-xl, xs items, menu-item hover/focus states.
   A right-click menu only fades (no zoom), and not at all with reduced motion. */
const CONTENT_CLASS =
  "z-50 min-w-52 max-w-80 overflow-x-hidden overflow-y-auto rounded-xl border surface-menu p-1.5 text-popover-foreground outline-hidden data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-100 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-75 motion-reduce:animate-none"
/* A checked radio or checkbox reads by its mark and cyan text; the hover fill stays for the highlighted row only. */
const MARKED_CLASS = "pl-8 data-[state=checked]:not-data-[highlighted]:bg-transparent!"
const ITEM_CLASS =
  "relative flex cursor-default select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-cm-muted outline-hidden menu-item data-[disabled]:pointer-events-none data-[disabled]:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-3.5"

function ContextMenu(props: React.ComponentProps<typeof ContextMenuPrimitive.Root>) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />
}

function ContextMenuTrigger(props: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />
}

function ContextMenuContent({ className, collisionPadding = 8, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        data-slot="context-menu-content"
        collisionPadding={collisionPadding}
        className={cn(CONTENT_CLASS, "max-h-(--radix-context-menu-content-available-height) origin-(--radix-context-menu-content-transform-origin)", className)}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuItem({ className, inset, danger, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Item> & { inset?: boolean; danger?: boolean }) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-danger={danger || undefined}
      className={cn(ITEM_CLASS, inset && "pl-8", danger && "text-cm-rose data-[highlighted]:text-cm-rose", className)}
      {...props}
    />
  )
}

/** Checkbox and radio items keep their mark in the icon column, so labels line up with the icon items. */
function ContextMenuCheckboxItem({ className, children, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.CheckboxItem>) {
  return (
    <ContextMenuPrimitive.CheckboxItem data-slot="context-menu-checkbox-item" className={cn(ITEM_CLASS, MARKED_CLASS, className)} {...props}>
      <span className="absolute left-2.5 flex size-3.5 items-center justify-center">
        <ContextMenuPrimitive.ItemIndicator><CheckIcon className="text-cm-cyan" /></ContextMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.CheckboxItem>
  )
}

function ContextMenuRadioGroup(props: React.ComponentProps<typeof ContextMenuPrimitive.RadioGroup>) {
  return <ContextMenuPrimitive.RadioGroup data-slot="context-menu-radio-group" {...props} />
}

function ContextMenuRadioItem({ className, children, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.RadioItem>) {
  return (
    <ContextMenuPrimitive.RadioItem data-slot="context-menu-radio-item" className={cn(ITEM_CLASS, MARKED_CLASS, className)} {...props}>
      <span className="absolute left-2.5 flex size-3.5 items-center justify-center">
        <ContextMenuPrimitive.ItemIndicator><CheckIcon className="text-cm-cyan" /></ContextMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.RadioItem>
  )
}

function ContextMenuSub(props: React.ComponentProps<typeof ContextMenuPrimitive.Sub>) {
  return <ContextMenuPrimitive.Sub data-slot="context-menu-sub" {...props} />
}

function ContextMenuSubTrigger({ className, inset, children, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.SubTrigger> & { inset?: boolean }) {
  return (
    <ContextMenuPrimitive.SubTrigger
      data-slot="context-menu-sub-trigger"
      className={cn(ITEM_CLASS, "data-[state=open]:bg-(--cm-hover) data-[state=open]:text-cm-text", inset && "pl-8", className)}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto text-cm-faint" />
    </ContextMenuPrimitive.SubTrigger>
  )
}

function ContextMenuSubContent({ className, collisionPadding = 8, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.SubContent>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.SubContent
        data-slot="context-menu-sub-content"
        collisionPadding={collisionPadding}
        className={cn(CONTENT_CLASS, "max-h-(--radix-context-menu-content-available-height) origin-(--radix-context-menu-content-transform-origin)", className)}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuLabel({ className, inset, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Label> & { inset?: boolean }) {
  return (
    <ContextMenuPrimitive.Label
      data-slot="context-menu-label"
      className={cn("truncate px-2.5 pb-1.5 pt-1 text-[11px] text-cm-faint", inset && "pl-8", className)}
      {...props}
    />
  )
}

function ContextMenuSeparator({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return <ContextMenuPrimitive.Separator data-slot="context-menu-separator" className={cn("-mx-1.5 my-1 h-px bg-cm-line/20", className)} {...props} />
}

/** A key that works in this place, right-aligned and faint. */
function ContextMenuShortcut({ className, ...props }: React.ComponentProps<"kbd">) {
  return <kbd data-slot="context-menu-shortcut" className={cn("ml-auto shrink-0 pl-4 font-mono text-[10px] text-cm-faint", className)} {...props} />
}

/** Why an item is disabled right now («παίζει»), in the shortcut's place. */
function ContextMenuReason({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="context-menu-reason" className={cn("ml-auto shrink-0 pl-4 text-[10px] text-cm-muted", className)} {...props} />
}

const Label = ({ text }: { text: string }) => <span className="min-w-0 flex-1 truncate">{text}</span>

type Children = { children?: React.ReactNode }
type OnSelect = { disabled?: boolean; onSelect?: (event: Event) => void }

/** The styled parts a menu surface renders entries with: the right-click menu's below, the «…» button's in dropdown-menu.tsx. */
export type MenuParts = {
  Item: React.ComponentType<Children & OnSelect & { danger?: boolean; inset?: boolean }>
  CheckboxItem: React.ComponentType<Children & OnSelect & { checked?: boolean }>
  RadioGroup: React.ComponentType<Children & { value?: string }>
  RadioItem: React.ComponentType<Children & OnSelect & { value: string }>
  Sub: React.ComponentType<Children>
  SubTrigger: React.ComponentType<Children & { disabled?: boolean; inset?: boolean }>
  SubContent: React.ComponentType<Children & { className?: string }>
  Label: React.ComponentType<Children & { inset?: boolean }>
  Separator: React.ComponentType
}

/** Renders `MenuEntry[]` with a surface's parts; a run of radio entries becomes one radio group. */
function renderEntries(entries: MenuEntry[], P: MenuParts): React.ReactNode[] {
  // One icon column for the whole list once any row has an icon or a mark, so every label starts at the same x.
  const inset = entries.some(e => ((e.type === "item" || e.type === "sub") && e.icon) || e.type === "check" || e.type === "radio")
  const out: React.ReactNode[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const key = `${i}:${entry.type}:${"label" in entry ? entry.label : ""}`
    switch (entry.type) {
      case "separator":
        out.push(<P.Separator key={key} />)
        break
      case "label":
        out.push(<P.Label key={key} inset={inset}>{entry.label}</P.Label>)
        break
      case "item": {
        const Icon = entry.icon
        out.push(
          <P.Item key={key} disabled={entry.disabled} danger={entry.danger} inset={inset && !Icon} onSelect={() => entry.onSelect()}>
            {Icon && <Icon aria-hidden="true" />}
            <Label text={entry.label} />
            {entry.disabled && entry.reason ? <ContextMenuReason>{entry.reason}</ContextMenuReason>
              : entry.shortcut ? <ContextMenuShortcut>{entry.shortcut}</ContextMenuShortcut> : null}
          </P.Item>,
        )
        break
      }
      case "check":
        out.push(
          <P.CheckboxItem key={key} checked={entry.checked} disabled={entry.disabled} onSelect={() => entry.onSelect()}>
            <Label text={entry.label} />
          </P.CheckboxItem>,
        )
        break
      case "radio": {
        let end = i
        while (end + 1 < entries.length && entries[end + 1].type === "radio") end++
        const group = entries.slice(i, end + 1) as Extract<MenuEntry, { type: "radio" }>[]
        const checked = group.findIndex(r => r.checked)
        out.push(
          <P.RadioGroup key={key} value={checked < 0 ? "" : String(checked)}>
            {group.map((radio, j) => (
              <P.RadioItem key={j} value={String(j)} disabled={radio.disabled} onSelect={() => radio.onSelect()}>
                <Label text={radio.label} />
                {radio.shortcut && <ContextMenuShortcut>{radio.shortcut}</ContextMenuShortcut>}
              </P.RadioItem>
            ))}
          </P.RadioGroup>,
        )
        i = end
        break
      }
      case "sub": {
        const Icon = entry.icon
        out.push(
          <P.Sub key={key}>
            <P.SubTrigger disabled={entry.disabled} inset={inset && !Icon}>
              {Icon && <Icon aria-hidden="true" />}
              <Label text={entry.label} />
              {entry.disabled && entry.reason && <ContextMenuReason className="pl-2">{entry.reason}</ContextMenuReason>}
            </P.SubTrigger>
            <P.SubContent className="max-h-72">
              {renderEntries(entry.entries, P)}
            </P.SubContent>
          </P.Sub>,
        )
        break
      }
    }
  }
  return out
}

const CONTEXT_MENU_PARTS: MenuParts = {
  Item: ContextMenuItem,
  CheckboxItem: ContextMenuCheckboxItem,
  RadioGroup: ContextMenuRadioGroup,
  RadioItem: ContextMenuRadioItem,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
  Label: ContextMenuLabel,
  Separator: ContextMenuSeparator,
}

/** Renders `MenuEntry[]` in a right-click menu. */
function MenuEntries({ entries }: { entries: MenuEntry[] }) {
  return <>{renderEntries(entries, CONTEXT_MENU_PARTS)}</>
}

/**
 * One menu for a whole list: the trigger is the list's own container and `pick` maps the right-clicked row
 * (`rowSelector`, or the container itself) to a target. No row → no menu and no webview menu. Text fields and
 * selected text keep the webview's menu. The row carries `data-menu-target` while its menu is open.
 * Without a `menu` the children render alone.
 */
function ActionContextMenu<T>({ rowSelector, pick, menu, children }: {
  rowSelector?: string
  pick: (row: HTMLElement) => T | null | undefined
  menu: MenuSource<T> | undefined
  children: React.ReactElement
}) {
  // `target` is set only while the menu is open; `last` keeps its entries for the fade-out.
  const [target, setTarget] = React.useState<{ value: T } | null>(null)
  const current = React.useRef<{ value: T } | null>(null)
  const pressed = React.useRef<{ value: T; row: HTMLElement } | null>(null)
  const last = React.useRef<MenuEntry[]>([])
  const marked = React.useRef<HTMLElement | null>(null)
  const byPointer = React.useRef(true)

  if (!menu) return children

  function unmark() {
    marked.current?.removeAttribute("data-menu-target")
    marked.current = null
  }

  function picked(event: React.SyntheticEvent<HTMLElement>): { value: T; row: HTMLElement } | null {
    const row = rowSelector ? (event.target as Element).closest<HTMLElement>(rowSelector) : event.currentTarget
    const value = row && event.currentTarget.contains(row) ? pick(row) : null
    return value == null || !row ? null : { value, row }
  }

  function choose(choice: { value: T; row: HTMLElement }) {
    unmark()
    if (rowSelector) {
      choice.row.setAttribute("data-menu-target", "")
      marked.current = choice.row
    }
    current.current = { value: choice.value }
    setTarget(current.current)
  }

  function onContextMenu(event: React.MouseEvent<HTMLElement>) {
    pressed.current = null
    const choice = picked(event)
    if (!choice) {
      event.preventDefault()
      return
    }
    // The Menu key and Shift+F10 fire a contextmenu without a pointer (Chromium: pointerType "").
    byPointer.current = (event.nativeEvent as PointerEvent).pointerType !== ""
    choose(choice)
  }

  // A touch or pen long-press opens the menu from Radix's own timer, without a contextmenu: pick its row here.
  function onPointerDown(event: React.PointerEvent<HTMLElement>) {
    if (event.pointerType === "mouse") return
    pressed.current = picked(event)
    byPointer.current = true
  }

  return (
    <ContextMenu modal open={target !== null} onOpenChange={open => {
      if (open) {
        if (pressed.current) choose(pressed.current)
        pressed.current = null
        // No row under the pointer: the menu stays shut.
        if (current.current) menu.onOpenChange?.(true, current.current.value)
        return
      }
      unmark()
      if (current.current) menu.onOpenChange?.(false, current.current.value)
      current.current = null
      setTarget(null)
    }}>
      <ContextMenuTrigger asChild
        onContextMenuCapture={event => { if (allowsNativeMenu(event.target, window.getSelection())) event.stopPropagation() }}
        onContextMenu={onContextMenu}
        onPointerDown={onPointerDown}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={event => {
        // A pointer-opened menu must not send focus back to the search box (it would swallow J/K and Space).
        if (byPointer.current) event.preventDefault()
      }}>
        <OpenEntries menu={menu} target={target} last={last} />
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** Rendered only inside the open (or fading) menu, so a closed menu never rebuilds its entries. */
function OpenEntries<T>({ menu, target, last }: { menu: MenuSource<T>; target: { value: T } | null; last: React.RefObject<MenuEntry[]> }) {
  last.current = shownEntries(menu, target, last.current)
  return <MenuEntries entries={last.current} />
}

export {
  CONTENT_CLASS,
  ITEM_CLASS,
  MARKED_CLASS,
  renderEntries,
  ActionContextMenu,
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuReason,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  MenuEntries,
}
