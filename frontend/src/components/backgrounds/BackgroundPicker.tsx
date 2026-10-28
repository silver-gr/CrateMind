import { useId } from "react";
import { usePref } from "../../lib/prefs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { BACKGROUND_OPTIONS, isBackgroundId } from "./backgrounds";

export default function BackgroundPicker({ compact = false }: { compact?: boolean }) {
  const id = useId();
  const [background, setBackground] = usePref("background");
  const selectedBackground = isBackgroundId(background) ? background : "soft-aurora";
  return (
    <div className={compact ? "flex min-w-0 items-center justify-between gap-2" : "space-y-1.5"}>
      <label htmlFor={id} className="shrink-0 text-[11px] font-medium text-cm-muted">Φόντο</label>
      <Select
        value={selectedBackground}
        onValueChange={(value) => { if (isBackgroundId(value)) setBackground(value); }}
      >
        <SelectTrigger id={id} aria-label="Φόντο εφαρμογής" data-background-value={selectedBackground} size="sm" className={compact ? "w-[170px] shrink-0 text-xs" : "min-w-0 w-full text-xs"}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {BACKGROUND_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value} data-background-option={option.value}>{option.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}
