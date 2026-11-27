import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import {
  Activity,
  Archive,
  AudioWaveform,
  FolderTree,
  Grid3x3,
  Palette,
  Scan,
  Search,
  SlidersHorizontal,
  Sparkles,
  Tags,
  Volume2,
  Waves,
} from "../../lib/icons";
import {
  matchSettingsSections,
  SETTINGS_GROUPS,
  type SettingsSection,
  type SettingsSectionId,
} from "../../lib/settingsSections";
import { Input } from "../ui/input";

const ICONS: Record<SettingsSectionId, ComponentType<{ className?: string }>> = {
  general: SlidersHorizontal,
  appearance: Palette,
  folders: FolderTree,
  scan: Scan,
  vocabularies: Tags,
  analysis: AudioWaveform,
  djay: Grid3x3,
  llm: Sparkles,
  playback: Volume2,
  waveforms: Waves,
  backup: Archive,
  status: Activity,
};

/**
 * Settings sidebar: search, then the sections grouped by topic. In a narrow container it becomes one
 * horizontal strip of sections (no search, no group labels, no footer). Needs an `@container` ancestor.
 */
export function SettingsNav({
  sections,
  current,
  onSelect,
  footer,
}: {
  sections: readonly SettingsSection[];
  current: SettingsSectionId;
  onSelect: (id: SettingsSectionId) => void;
  footer?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const visible = matchSettingsSections(sections, query);
  const activeRef = useRef<HTMLButtonElement>(null);
  // The narrow strip scrolls sideways: keep the current section in view.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current]);

  return (
    <nav
      aria-label="Ενότητες ρυθμίσεων"
      className="flex shrink-0 flex-col border-b border-cm-border @[52rem]:h-full @[52rem]:w-[248px] @[52rem]:border-b-0 @[52rem]:border-r"
    >
      <div className="hidden px-4 pt-5 @[52rem]:block">
        <label className="relative flex items-center">
          <span className="sr-only">Αναζήτηση ρυθμίσεων</span>
          <Search className="pointer-events-none absolute left-2.5 h-4 w-4 text-cm-faint" />
          <Input
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Enter" && visible[0]) onSelect(visible[0].id);
            }}
            placeholder="Αναζήτηση"
            className="h-8 pl-8 text-xs"
          />
        </label>
      </div>
      <div className="flex gap-1 overflow-x-auto px-3 py-2 @[52rem]:min-h-0 @[52rem]:flex-1 @[52rem]:flex-col @[52rem]:gap-4 @[52rem]:overflow-y-auto @[52rem]:py-4">
        {SETTINGS_GROUPS.map(group => {
          const items = visible.filter(section => section.group === group.id);
          if (items.length === 0) return null;
          return (
            <div key={group.id} className="contents @[52rem]:flex @[52rem]:flex-col @[52rem]:gap-0.5">
              <h2 className="micro-label hidden px-2.5 pb-1 text-cm-faint @[52rem]:block">{group.label}</h2>
              {items.map(item => {
                const Icon = ICONS[item.id];
                const active = item.id === current;
                return (
                  <button
                    key={item.id}
                    ref={active ? activeRef : undefined}
                    type="button"
                    aria-current={active ? "page" : undefined}
                    onClick={() => onSelect(item.id)}
                    className={cn(
                      "flex h-8 shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-2.5 text-left text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-cyan/60",
                      active
                        ? "bg-cm-cyan/10 text-cm-cyan shadow-[inset_0_0_0_1px_oklch(from_var(--cm-cyan)_l_c_h/0.22)]"
                        : "text-cm-muted hover:bg-cm-cyan/10 hover:text-cm-text",
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    {item.label}
                  </button>
                );
              })}
            </div>
          );
        })}
        {visible.length === 0 && <p className="px-2.5 text-xs text-cm-muted">Καμία ρύθμιση για «{query.trim()}».</p>}
      </div>
      {footer && <div className="hidden p-3 @[52rem]:block">{footer}</div>}
    </nav>
  );
}
