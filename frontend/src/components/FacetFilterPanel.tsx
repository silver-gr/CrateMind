import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { api } from "../lib/api";
import { ANALYSIS_FINISHED, BPM_UPDATED, queryHasBpmFilter } from "../lib/bpmUpdates";
import { cn } from "../lib/cn";
import { FACETS_CHANGED, useFacets } from "../lib/facets";
import { ChevronDown } from "../lib/icons";
import { axisLabel, type Axis } from "../lib/labels";
import { getPref, setPref, usePref, type LibraryProfile } from "../lib/prefs";
import {
  boundsFromQuery, facetTokenActive, foldText, setRangeToken, toggleFacetToken, tokenizeQuery,
} from "../lib/queryGrammar";
import type { Facet } from "../lib/types";
import { nextRadioIndex } from "./FacetEditor";
import { Slider } from "./ui/slider";

/** Runs `fetch` per call and hands only the newest call's result to `apply`; older responses are dropped. */
export function createLatestLoader<A, T>(fetch: (arg: A) => Promise<T>, apply: (result: T) => void, fail?: () => void) {
  let sequence = 0;
  return {
    load(arg: A) {
      const mine = ++sequence;
      fetch(arg).then(
        result => { if (mine === sequence) apply(result); },
        () => { if (mine === sequence) fail?.(); },
      );
    },
    cancel() { sequence += 1; },
  };
}

interface RangeSpec {
  field: "bpm" | Axis;
  label: string;
  min: number;
  max: number;
  thumbLabels: [string, string];
}

function rangeSpecs(profile: LibraryProfile): RangeSpec[] {
  const [bpmMin, bpmMax] = profile === "therapy" ? [40, 240] : [60, 300];
  const axes: Axis[] = ["energy", profile === "therapy" ? "valence" : "darkness"];
  return [
    { field: "bpm", label: "BPM", min: bpmMin, max: bpmMax, thumbLabels: ["Ελάχιστο BPM", "Μέγιστο BPM"] },
    ...axes.map(axis => {
      const label = axisLabel(axis, profile);
      return { field: axis, label, min: 1, max: 10, thumbLabels: [`${label}: ελάχιστο`, `${label}: μέγιστο`] as [string, string] };
    }),
  ];
}

/** The query without the tokens this panel writes: positive facet values and the slider ranges. */
export function clearPanelTokens(query: string, facets: readonly Facet[], specs: readonly RangeSpec[]): string {
  let next = query;
  for (const facet of facets) {
    for (const value of facet.values) {
      if (facetTokenActive(next, facet.key, value.value)) {
        next = toggleFacetToken(next, facet.key, value.value, { single: false, siblings: [] });
      }
    }
  }
  // Every token the slider shows (`lo-hi`, `N`, `N+`, `N-`) is the panel's own.
  for (const spec of specs) if (boundsFromQuery(next, spec.field, spec.min, spec.max)) next = setRangeToken(next, spec.field, null);
  return next;
}

function hasPanelTokens(query: string, facets: readonly Facet[], specs: readonly RangeSpec[]): boolean {
  return facets.some(facet => facet.values.some(value => facetTokenActive(query, facet.key, value.value)))
    || specs.some(spec => boundsFromQuery(query, spec.field, spec.min, spec.max) !== null);
}

/** Arrow keys move focus within a radio group; Space or Enter then chooses. */
function onRadioKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
  const radios = [...(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]:not([aria-disabled="true"])') ?? [])];
  const next = nextRadioIndex(event.key, radios.indexOf(event.currentTarget), radios.length);
  if (next === null) return;
  event.preventDefault();
  event.stopPropagation();
  radios[next].focus();
}

function Section({ id, title, open, onToggle, children }: {
  id: string; title: string; open: boolean; onToggle(): void; children: ReactNode;
}) {
  const bodyId = `facet-panel-${id}`;
  return (
    <section className="border-b border-cm-border/60 py-2 last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
        className="flex w-full cursor-pointer items-center gap-1.5 rounded px-1 py-1 text-left text-[11px] font-medium uppercase tracking-wider text-cm-faint hover:text-cm-text"
      >
        <ChevronDown aria-hidden="true" className={cn("h-3 w-3 shrink-0 transition-transform", !open && "-rotate-90")} />
        <span className="min-w-0 truncate">{title}</span>
      </button>
      <div id={bodyId} hidden={!open} className="mt-1">{children}</div>
    </section>
  );
}

function FacetValues({ facet, counts, draft, onApply }: {
  facet: Facet; counts: Record<string, number> | null; draft: string; onApply(next: string): void;
}) {
  const single = !facet.multi;
  const siblings = facet.values.map(v => v.value);
  const tokens = tokenizeQuery(draft).filter(t => t.field?.toLowerCase() === facet.key);
  const excluded = new Set(tokens.filter(t => t.neg && t.value !== "*").map(t => foldText(t.value)));
  const any = tokens.find(t => t.value === "*");
  const active = facet.values.map(v => facetTokenActive(draft, facet.key, v.value));
  const anyActive = active.some(Boolean);

  return (
    <>
      {any && (
        <p className="mb-1 px-1 text-[11px] text-cm-muted">{any.neg ? "εκτός · οποιαδήποτε τιμή" : "οποιαδήποτε τιμή"}</p>
      )}
      {facet.values.length === 0 && <p className="px-1 text-xs text-cm-faint">Καμία τιμή ακόμη</p>}
      <div role={single ? "radiogroup" : "group"} aria-label={facet.label} className="space-y-0.5">
        {facet.values.map((value, index) => {
          const on = active[index];
          const out = excluded.has(foldText(value.value));
          const count = counts ? counts[String(value.id)] ?? 0 : null;
          // A zero count only means "no results" when the click would narrow the query;
          // replacing the selection of a single-value facet can still give results.
          const disabled = out || (count === 0 && !on && !(single && anyActive));
          // aria-disabled, not `disabled`: the value stays focusable, so the radiogroup's
          // tab stop and the focus on a just-removed value survive a zero count.
          const tabStop = on || (index === 0 && !anyActive);
          const a11y = single
            ? { role: "radio" as const, "aria-checked": on, tabIndex: tabStop ? 0 : -1, onKeyDown: onRadioKeyDown }
            : { role: "checkbox" as const, "aria-checked": on };
          return (
            <button
              key={value.id}
              type="button"
              {...a11y}
              aria-disabled={disabled || undefined}
              onClick={() => { if (!disabled) onApply(toggleFacetToken(draft, facet.key, value.value, { single, siblings })); }}
              className={cn(
                "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition hover:bg-cm-line/5 aria-disabled:cursor-not-allowed aria-disabled:opacity-45 dark:hover:bg-white/5",
                on ? "bg-cm-violet/15 text-cm-text ring-1 ring-cm-violet/40" : "text-cm-muted",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "h-2.5 w-2.5 shrink-0 border border-cm-violet/60",
                  single ? "rounded-full" : "rounded-sm",
                  on && "bg-cm-violet",
                )}
              />
              <span className="min-w-0 flex-1 truncate">{value.value}</span>
              {out ? (
                <span className="shrink-0 text-[10px] text-cm-rose">εκτός</span>
              ) : count !== null && (
                <span className="shrink-0 font-mono text-[10px] tabular-nums text-cm-faint">{count.toLocaleString("el-GR")}</span>
              )}
            </button>
          );
        })}
      </div>
    </>
  );
}

/** Keyboard steps commit one by one (Radix), so they apply once the keys rest; a pointer release applies at once. */
const KEYBOARD_COMMIT_MS = 400;

function RangeControl({ spec, draft, onApply }: { spec: RangeSpec; draft: string; onApply(next: string): void }) {
  // `energy:7`, `energy:8+` and `bpm:150-` show what they filter, not «όλα».
  const current = boundsFromQuery(draft, spec.field, spec.min, spec.max);
  const clamp = (n: number) => Math.min(spec.max, Math.max(spec.min, n));
  const lo = current ? clamp(current[0]) : spec.min;
  const hi = current ? clamp(current[1]) : spec.max;
  const [value, setValue] = useState<[number, number]>([lo, hi]);
  useEffect(() => setValue([lo, hi]), [lo, hi]);
  const keyboard = useRef(false);
  const pendingCommit = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(pendingCommit.current), []);

  return (
    <div className="px-1 pb-1">
      <div className="mb-2 flex justify-end font-mono text-[11px] tabular-nums text-cm-muted">
        {value[0] === spec.min && value[1] === spec.max ? "όλα" : `${value[0]}–${value[1]}`}
      </div>
      <Slider
        min={spec.min}
        max={spec.max}
        step={1}
        minStepsBetweenThumbs={0}
        value={value}
        thumbLabels={spec.thumbLabels}
        onKeyDown={() => { keyboard.current = true; }}
        onPointerDown={() => { keyboard.current = false; }}
        onValueChange={next => setValue([next[0], next[1]])}
        onValueCommit={([a, b]) => {
          // The full range is no filter, so it writes no token.
          const range: [number, number] | null = a <= spec.min && b >= spec.max ? null : [a, b];
          const apply = () => onApply(setRangeToken(draft, spec.field, range));
          clearTimeout(pendingCommit.current);
          if (keyboard.current) pendingCommit.current = setTimeout(apply, KEYBOARD_COMMIT_MS);
          else apply();
        }}
      />
    </div>
  );
}

/** The panel body, without data fetching (rendered directly by tests). */
export function FacetFilterView({ facets, counts, draft, profile, collapsed, onToggleSection, onApply }: {
  facets: readonly Facet[];
  counts: Record<string, number> | null;
  draft: string;
  profile: LibraryProfile;
  collapsed: readonly string[];
  onToggleSection(id: string): void;
  onApply(next: string): void;
}) {
  const specs = rangeSpecs(profile);
  const clearable = hasPanelTokens(draft, facets, specs);
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-cm-text">Φίλτρα</h2>
        {/* aria-disabled, not `disabled`: clearing empties the panel, and a natively disabled button would drop focus. */}
        <button
          type="button"
          aria-disabled={!clearable || undefined}
          onClick={() => { if (clearable) onApply(clearPanelTokens(draft, facets, specs)); }}
          className="cursor-pointer rounded px-1.5 py-0.5 text-[11px] text-cm-cyan transition hover:bg-cm-cyan/10 aria-disabled:cursor-not-allowed aria-disabled:opacity-40"
        >
          Καθαρισμός φίλτρων
        </button>
      </div>
      {specs.map(spec => (
        <Section key={spec.field} id={spec.field} title={spec.label}
          open={!collapsed.includes(spec.field)} onToggle={() => onToggleSection(spec.field)}>
          <RangeControl spec={spec} draft={draft} onApply={onApply} />
        </Section>
      ))}
      {facets.length === 0 && <p className="px-1 py-2 text-xs text-cm-faint">Δεν υπάρχουν λεξιλόγια ακόμη.</p>}
      {facets.map(facet => (
        <Section key={facet.id} id={`v${facet.id}`} title={facet.label}
          open={!collapsed.includes(facet.key)} onToggle={() => onToggleSection(facet.key)}>
          <FacetValues facet={facet} counts={counts} draft={draft} onApply={onApply} />
        </Section>
      ))}
    </div>
  );
}

/**
 * The Library «Φίλτρα» rail. The text query stays the single source of truth: every
 * click rebuilds it from the draft input and applies it. Counts follow the applied query.
 */
export function FacetFilterPanel({ draft, applied, onApply }: {
  draft: string;
  applied: string;
  onApply(next: string): void;
}) {
  const { facets } = useFacets();
  const [profile] = usePref("libraryProfile");
  const [panel] = usePref("libraryFacetPanel");
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const loader = useMemo(
    () => createLatestLoader((q: string) => api.facetCounts(q), result => setCounts(result.counts), () => setCounts(null)),
    [],
  );

  // Refetch on an applied-query change and after every vocabulary or bulk write (FACETS_CHANGED);
  // under a `bpm:` filter also after a BPM change or a finished analysis.
  useEffect(() => {
    loader.load(applied);
    const onChange = () => loader.load(applied);
    const bpmEvents = queryHasBpmFilter(applied) ? [BPM_UPDATED, ANALYSIS_FINISHED] : [];
    for (const name of [FACETS_CHANGED, ...bpmEvents]) window.addEventListener(name, onChange);
    return () => {
      for (const name of [FACETS_CHANGED, ...bpmEvents]) window.removeEventListener(name, onChange);
      loader.cancel();
    };
  }, [loader, applied]);

  function toggleSection(id: string) {
    const current = getPref("libraryFacetPanel");
    const collapsed = current.collapsed.includes(id)
      ? current.collapsed.filter(c => c !== id)
      : [...current.collapsed, id];
    setPref("libraryFacetPanel", { ...current, collapsed });
  }

  return (
    <aside
      id="library-facet-panel"
      aria-label="Φίλτρα"
      className="absolute inset-y-0 left-0 z-20 w-[232px] shrink-0 overflow-y-auto border-r border-cm-border bg-cm-bg p-3 shadow-xl lg:static lg:z-auto lg:bg-cm-bg-2/40 lg:shadow-none"
    >
      <FacetFilterView
        facets={facets}
        counts={counts}
        draft={draft}
        profile={profile}
        collapsed={panel.collapsed}
        onToggleSection={toggleSection}
        onApply={onApply}
      />
    </aside>
  );
}
