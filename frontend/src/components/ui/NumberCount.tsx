import { cn } from "../../lib/cn";

const greekNumber = new Intl.NumberFormat("el-GR");

/** Stable locale-formatted counts, including frequently changing list totals. */
export function NumberCount({ value, className }: { value: number; className?: string }) {
  return <span className={cn("tabular-nums", className)}>{greekNumber.format(value)}</span>;
}
