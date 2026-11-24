import { fallbackKey, formatKey, keyColor, uncertainKey, type KeyFormat, type KeySources } from "../../lib/camelot";
import { cn } from "../../lib/cn";

const UNCERTAIN_KEY_TITLE = "Αβέβαιο key: μόνο από την ανάλυση του CrateMind, χωρίς αρκετή βεβαιότητα";

export function KeyBadge({ keyText, analyzed, uncertain, className }: {
  keyText?: string | null;
  analyzed?: string | null;
  uncertain?: boolean;
  className?: string;
}) {
  const code = formatKey(keyText, analyzed);
  const color = keyColor(code);
  return (
    <span className={cn("inline-flex shrink-0 items-center justify-center rounded-md border border-cm-border bg-cm-panel px-1.5 py-0.5 font-mono text-[10px] leading-tight text-cm-faint", uncertain && "opacity-55", className)}
      title={uncertain ? UNCERTAIN_KEY_TITLE : undefined}
      style={color ? {
        color,
        borderColor: `color-mix(in oklch, ${color} 35%, transparent)`,
        backgroundColor: `color-mix(in oklch, ${color} 12%, transparent)`,
      } : undefined}>
      <span className="truncate">{code}{uncertain && "?"}</span>
    </span>
  );
}

/** A track's key as text; an uncertain key (see uncertainKey) is dimmed, with a trailing «?» and a tooltip. */
export function KeyLabel({ track, format }: { track: KeySources; format?: KeyFormat }) {
  const code = formatKey(track.key_text, fallbackKey(track), format);
  if (!uncertainKey(track)) return <>{code}</>;
  return <span className="opacity-55" title={UNCERTAIN_KEY_TITLE}>{code}?</span>;
}
