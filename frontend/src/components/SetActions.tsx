import { useEffect, useRef } from "react";
import { Copy, Plus, Save } from "../lib/icons";

export const SET_EXPORTS = [
  { fmt: "m3u", label: "M3U" },
  { fmt: "csv", label: "CSV" },
  { fmt: "markdown", label: "Markdown" },
  { fmt: "json-backup", label: "JSON" },
] as const;

export type SetExportFormat = typeof SET_EXPORTS[number]["fmt"];

interface Props {
  disabled: boolean;
  onNew: () => void;
  onDuplicate: () => void;
  onSave: () => void;
  onExport: (format: SetExportFormat) => void;
}

/** Native disclosure keeps the compact action list keyboard accessible. */
export default function SetActions({ disabled, onNew, onDuplicate, onSave, onExport }: Props) {
  const menu = useRef<HTMLDetailsElement>(null);
  const close = () => { if (menu.current) menu.current.open = false; };
  useEffect(() => {
    const dismissOutside = (event: Event) => {
      if (menu.current?.open && !menu.current.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", dismissOutside);
    // WebKit can blur the summary without focusing a pressed menu button.
    // Dismiss when focus actually enters an outside control.
    document.addEventListener("focusin", dismissOutside);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("focusin", dismissOutside);
    };
  }, []);
  const actionClass = "flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-left text-xs text-cm-muted transition menu-item focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-cyan disabled:cursor-default disabled:opacity-40";

  return (
    <details ref={menu} data-set-actions-menu className="relative shrink-0"
      onKeyDown={event => {
        if (event.key === "Escape") {
          close();
          menu.current?.querySelector("summary")?.focus();
        }
      }}>
      <summary aria-label="Ενέργειες set" title="Ενέργειες set"
        className="flex h-9 w-9 cursor-pointer list-none items-center justify-center rounded-lg border surface-field text-cm-muted transition hover:bg-cm-cyan/10 hover:text-cm-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-cyan [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="mb-1 text-xl leading-none">…</span>
      </summary>
      <div className="absolute right-0 top-full z-40 mt-1 w-60 rounded-xl border surface-menu p-1.5"
        onClick={event => { if ((event.target as HTMLElement).closest("button")) close(); }}>
        <button type="button" onClick={onNew} className={actionClass}><Plus className="h-3.5 w-3.5" />Νέο set</button>
        <button type="button" onClick={onDuplicate} disabled={disabled} className={actionClass}><Copy className="h-3.5 w-3.5" />Δημιουργία αντιγράφου</button>
        <button type="button" onClick={onSave} disabled={disabled} className={actionClass}>
          <Save className="h-3.5 w-3.5" />
          <span>Αποθήκευση<span className="block text-[10px] text-cm-faint">Αντίγραφο ασφαλείας JSON</span></span>
        </button>
        <div className="my-1 border-t border-cm-line/20" />
        {SET_EXPORTS.map(({ fmt, label }) => (
          <button key={fmt} type="button" onClick={() => onExport(fmt)} disabled={disabled} className={actionClass}>Εξαγωγή {label}</button>
        ))}
      </div>
    </details>
  );
}
