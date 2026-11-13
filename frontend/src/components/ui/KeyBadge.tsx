import { formatKey, keyColor } from "../../lib/camelot";
import { cn } from "../../lib/cn";

export function KeyBadge({ keyText, analyzed, className }: {
  keyText?: string | null;
  analyzed?: string | null;
  className?: string;
}) {
  const code = formatKey(keyText, analyzed);
  const color = keyColor(code);
  return (
    <span className={cn("inline-flex shrink-0 items-center justify-center rounded-md border border-cm-border bg-cm-panel px-1.5 py-0.5 font-mono text-[10px] leading-tight text-cm-faint", className)}
      style={color ? {
        color,
        borderColor: `color-mix(in oklch, ${color} 35%, transparent)`,
        backgroundColor: `color-mix(in oklch, ${color} 12%, transparent)`,
      } : undefined}>
      <span className="truncate">{code}</span>
    </span>
  );
}
