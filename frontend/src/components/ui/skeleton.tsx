import { cn } from "@/lib/cn"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-cm-contrast/8", className)}
      {...props}
    />
  )
}

export { Skeleton }
