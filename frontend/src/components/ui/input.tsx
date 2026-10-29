import * as React from "react"

import { cn } from "@/lib/cn"
import { ClearFieldButton, useClearableField } from "./clearable-field"

type InputProps = React.ComponentProps<"input"> & {
  wrapperClassName?: string
  onClear?: () => void
}

function Input({ className, wrapperClassName, type, ref, onChange, onClear, ...props }: InputProps) {
  const textual = type === undefined || ["text", "search", "email", "url", "tel", "password"].includes(type)
  const { fieldRef, handleChange, clear, hasValue } = useClearableField(ref, props.value, props.defaultValue, onChange, onClear)
  const input = (
    <input
      ref={fieldRef}
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-md border surface-field px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
        className,
        textual && "peer pr-9 [&::-webkit-search-cancel-button]:appearance-none"
      )}
      {...props}
      onChange={handleChange}
    />
  )
  if (!textual) return input
  return (
    <span data-slot="input-wrapper" className={cn("relative block w-full min-w-0", wrapperClassName)}>
      {input}
      {hasValue && !props.disabled && !props.readOnly && <ClearFieldButton onClear={clear} label={props["aria-label"]} />}
    </span>
  )
}

export { Input }
