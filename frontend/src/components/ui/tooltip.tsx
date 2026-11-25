"use client"

import * as React from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import { cn } from "@/lib/cn"

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-fit max-w-xs origin-(--radix-tooltip-content-transform-origin) rounded-lg border surface-menu px-2.5 py-1.5 text-xs leading-snug text-balance text-cm-text animate-in fade-in-0 zoom-in-97 duration-125 ease-out data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-97 data-[state=closed]:duration-100 data-[state=instant-open]:animate-none",
          className
        )}
        {...props}
      >
        {children}
        {/* The pointer: the bubble's fill, with the border drawn as a hairline shadow on its two free sides. */}
        <TooltipPrimitive.Arrow width={12} height={6} className="fill-[var(--cm-overlay)] drop-shadow-[0_1px_0_var(--cm-border-hi)]" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

/**
 * A fast bubble for text the user should not miss: a caveat, a warning, a control that has no effect yet.
 * A plain name or a detail that can wait stays a native `title`. The child must be one element that takes a ref.
 */
function Hint({
  text,
  side = "top",
  children,
}: {
  text: React.ReactNode
  side?: React.ComponentProps<typeof TooltipPrimitive.Content>["side"]
  children: React.ReactElement
}) {
  return (
    <Tooltip delayDuration={80}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{text}</TooltipContent>
    </Tooltip>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, Hint }
