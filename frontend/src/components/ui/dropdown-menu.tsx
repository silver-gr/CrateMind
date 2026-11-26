import * as React from "react"
import { CheckIcon, ChevronRightIcon } from "lucide-react"
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui"

import { cn } from "@/lib/cn"
import type { MenuEntry } from "@/lib/menus/entries"
import { CONTENT_CLASS, ITEM_CLASS, MARKED_CLASS, renderEntries, type MenuParts } from "./context-menu"

/* The «…» buttons' menus: the right-click menu's twin (same surface, items, fade and entries), opened by a click. */
const DropdownMenu = DropdownMenuPrimitive.Root
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger

function DropdownMenuContent({ className, sideOffset = 4, collisionPadding = 8, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(CONTENT_CLASS, "max-h-(--radix-dropdown-menu-content-available-height) origin-(--radix-dropdown-menu-content-transform-origin)", className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  )
}

function Mark() {
  return (
    <span className="absolute left-2.5 flex size-3.5 items-center justify-center">
      <DropdownMenuPrimitive.ItemIndicator><CheckIcon className="text-cm-cyan" /></DropdownMenuPrimitive.ItemIndicator>
    </span>
  )
}

const PARTS: MenuParts = {
  Item: ({ inset, danger, ...props }) => (
    <DropdownMenuPrimitive.Item data-danger={danger || undefined}
      className={cn(ITEM_CLASS, inset && "pl-8", danger && "text-cm-rose data-[highlighted]:text-cm-rose")} {...props} />
  ),
  CheckboxItem: ({ children, ...props }) => (
    <DropdownMenuPrimitive.CheckboxItem className={cn(ITEM_CLASS, MARKED_CLASS)} {...props}><Mark />{children}</DropdownMenuPrimitive.CheckboxItem>
  ),
  RadioGroup: props => <DropdownMenuPrimitive.RadioGroup {...props} />,
  RadioItem: ({ children, ...props }) => (
    <DropdownMenuPrimitive.RadioItem className={cn(ITEM_CLASS, MARKED_CLASS)} {...props}><Mark />{children}</DropdownMenuPrimitive.RadioItem>
  ),
  Sub: props => <DropdownMenuPrimitive.Sub {...props} />,
  SubTrigger: ({ inset, children, ...props }) => (
    <DropdownMenuPrimitive.SubTrigger
      className={cn(ITEM_CLASS, "data-[state=open]:bg-(--cm-hover) data-[state=open]:text-cm-text", inset && "pl-8")} {...props}>
      {children}
      <ChevronRightIcon className="ml-auto text-cm-faint" />
    </DropdownMenuPrimitive.SubTrigger>
  ),
  SubContent: ({ className, ...props }) => (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.SubContent collisionPadding={8}
        className={cn(CONTENT_CLASS, "max-h-(--radix-dropdown-menu-content-available-height) origin-(--radix-dropdown-menu-content-transform-origin)", className)} {...props} />
    </DropdownMenuPrimitive.Portal>
  ),
  Label: ({ inset, ...props }) => (
    <DropdownMenuPrimitive.Label className={cn("truncate px-2.5 pb-1.5 pt-1 text-[11px] text-cm-faint", inset && "pl-8")} {...props} />
  ),
  Separator: () => <DropdownMenuPrimitive.Separator className="-mx-1.5 my-1 h-px bg-cm-line/20" />,
}

/** Renders `MenuEntry[]` in a «…» menu: the same entries as the right-click menu of the same thing. */
function DropdownMenuEntries({ entries }: { entries: MenuEntry[] }) {
  return <>{renderEntries(entries, PARTS)}</>
}

export { DropdownMenu, DropdownMenuContent, DropdownMenuEntries, DropdownMenuTrigger }
