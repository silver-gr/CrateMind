import { useId } from "react";
import { KEY_WHEEL_SOURCES, KEY_WHEEL_SOURCE_LABELS, type KeyWheelSource } from "../lib/keyWheelSource";

export default function KeyWheelSourceControl({ value, keys, unavailable, onChange, legend = "Πηγή key για αρμονική συμβατότητα" }: {
  legend?: string;
  value: KeyWheelSource | null;
  keys: Record<KeyWheelSource, string | null>;
  unavailable: Record<KeyWheelSource, string>;
  onChange: (source: KeyWheelSource) => void;
}) {
  const name = useId();
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">{legend}</legend>
      <div className="grid grid-cols-3 overflow-hidden rounded-lg border surface-field">
        {KEY_WHEEL_SOURCES.map(source => (
          <label key={source} title={keys[source] ? `${KEY_WHEEL_SOURCE_LABELS[source]} · ${keys[source]}` : unavailable[source]}
            className="relative min-w-0 border-r border-cm-border last:border-r-0">
            <input type="radio" name={name} value={source} checked={value === source}
              disabled={!keys[source]} onChange={() => onChange(source)}
              onClick={() => { if (value === source) onChange(source); }}
              aria-label={keys[source] ? `${KEY_WHEEL_SOURCE_LABELS[source]} · ${keys[source]}` : `${KEY_WHEEL_SOURCE_LABELS[source]} · ${unavailable[source]}`}
              className="peer sr-only" />
            <span className="flex min-h-9 cursor-pointer items-center justify-center px-1.5 text-[11px] font-medium text-cm-muted transition-colors peer-checked:bg-cm-cyan/15 peer-checked:text-cm-cyan peer-focus-visible:ring-2 peer-focus-visible:ring-inset peer-focus-visible:ring-cm-cyan peer-disabled:cursor-default peer-disabled:opacity-40 hover:bg-cm-cyan/5">
              {KEY_WHEEL_SOURCE_LABELS[source]}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
