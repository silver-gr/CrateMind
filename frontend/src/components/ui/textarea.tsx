import * as React from "react"

import { cn } from "@/lib/cn"
import { ClearFieldButton, useClearableField } from "./clearable-field"

type TextareaProps = React.ComponentProps<"textarea"> & {
  wrapperClassName?: string
  onClear?: () => void
}

function Textarea({ className, wrapperClassName, ref, onChange, onClear, ...props }: TextareaProps) {
  const { fieldRef, handleChange, clear, hasValue } = useClearableField(ref, props.value, props.defaultValue, onChange, onClear)
  return (
    <span data-slot="textarea-wrapper" className={cn("relative block w-full min-w-0", wrapperClassName)}>
      <textarea
        ref={fieldRef}
        data-slot="textarea"
        className={cn(
          "flex field-sizing-content min-h-16 w-full rounded-md border surface-field px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 md:text-sm dark:aria-invalid:ring-destructive/40",
          className,
          "peer pr-9"
        )}
        {...props}
        onChange={handleChange}
      />
      {hasValue && !props.disabled && !props.readOnly && <ClearFieldButton onClear={clear} multiline label={props["aria-label"]} />}
    </span>
  )
}

export { Textarea }
