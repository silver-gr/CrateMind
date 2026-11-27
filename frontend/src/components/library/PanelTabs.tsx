import type { LucideIcon } from "lucide-react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { TabsList } from "@/components/ui/tabs";

/**
 * The pill tab row of a Library panel (the inspector and the side panel). It renders inside the consumer's own
 * Radix `Tabs` root. A pointer activation blurs the tab, so Space, J/K and the cue keys keep working
 * (keyboardGuard suppresses them while a tab has focus); a keyboard activation keeps the focus.
 * The active tab is the only tab stop (the list itself is not one), so Tab never lands on a stale tab.
 * A tab's icon shows only while the row is at least 20rem wide, so a narrow panel keeps its labels whole.
 */
export function PanelTabs<T extends string>({ tabs, value, ariaLabel }: {
  tabs: readonly { value: T; label: string; icon?: LucideIcon }[];
  value: T;
  ariaLabel: string;
}) {
  const index = Math.max(0, tabs.findIndex(t => t.value === value));
  return (
    <TabsList
      aria-label={ariaLabel}
      tabIndex={-1}
      style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
      className="@container/panel-tabs relative grid h-9 w-full"
    >
      {/* One pill behind equal triggers: it moves by its own width per index. */}
      <span
        aria-hidden="true"
        style={{ width: `calc((100% - 6px) / ${tabs.length})`, transform: `translateX(${index * 100}%)` }}
        className="pointer-events-none absolute inset-y-[3px] left-[3px] rounded-md surface-selected shadow-sm motion-safe:transition-transform motion-safe:duration-[260ms] motion-safe:ease-[var(--ease-out)]"
      />
      {tabs.map(t => (
        <TabsPrimitive.Trigger
          key={t.value}
          value={t.value}
          tabIndex={t.value === tabs[index]?.value ? 0 : -1}
          onClick={event => { if (event.detail > 0) event.currentTarget.blur(); }}
          className="relative z-10 flex h-full min-w-0 items-center justify-center gap-1.5 rounded-md px-1.5 text-xs font-medium whitespace-nowrap text-cm-muted transition-colors duration-150 hover:text-cm-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-cyan/60 data-[state=active]:text-cm-text"
        >
          {t.icon && <t.icon aria-hidden="true" className="hidden size-3 shrink-0 @min-[20rem]/panel-tabs:block" />}
          <span className="truncate">{t.label}</span>
        </TabsPrimitive.Trigger>
      ))}
    </TabsList>
  );
}
