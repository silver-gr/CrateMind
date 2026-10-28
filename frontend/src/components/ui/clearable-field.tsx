import * as React from "react"
import { X } from "lucide-react"

import { cn } from "@/lib/cn"

type TextField = HTMLInputElement | HTMLTextAreaElement

function useClearableField<T extends TextField>(
  ref: React.Ref<T> | undefined,
  value: React.ComponentProps<"input">["value"],
  defaultValue: React.ComponentProps<"input">["defaultValue"],
  onChange: React.ChangeEventHandler<T> | undefined,
  onClear: (() => void) | undefined,
) {
  const fieldRef = React.useRef<T>(null)
  const [uncontrolledValue, setUncontrolledValue] = React.useState(defaultValue ?? "")
  React.useImperativeHandle(ref, () => fieldRef.current!)

  React.useEffect(() => {
    const form = fieldRef.current?.form
    if (!form) return
    const reset = () => queueMicrotask(() => {
      if (fieldRef.current) setUncontrolledValue(fieldRef.current.value)
    })
    form.addEventListener("reset", reset)
    return () => form.removeEventListener("reset", reset)
  }, [])

  const handleChange: React.ChangeEventHandler<T> = (event) => {
    setUncontrolledValue(event.currentTarget.value)
    onChange?.(event)
  }

  const clear = () => {
    const field = fieldRef.current
    if (!field || field.matches(":disabled") || field.readOnly) return
    field.focus()
    // Bypass React's value tracker so the native input event follows the same
    // onChange path as typing, including controlled filters and form handlers.
    const prototype = Object.getPrototypeOf(field)
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, "")
    field.dispatchEvent(new Event("input", { bubbles: true }))
    setUncontrolledValue("")
    onClear?.()
  }

  return { fieldRef, handleChange, clear, hasValue: String(value ?? uncontrolledValue).length > 0 }
}

function ClearFieldButton({ onClear, multiline = false, label }: {
  onClear: () => void
  multiline?: boolean
  label?: string
}) {
  const description = label ? `Καθαρισμός: ${label}` : "Καθαρισμός πεδίου"
  return (
    <button
      type="button"
      aria-label={description}
      title={description}
      className={cn(
        "absolute right-1 flex size-7 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring peer-disabled:hidden",
        multiline ? "top-1" : "top-1/2 -translate-y-1/2",
      )}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onClear()
      }}
    >
      <X aria-hidden="true" className="size-4" />
    </button>
  )
}

export { ClearFieldButton, useClearableField }
