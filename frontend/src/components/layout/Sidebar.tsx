import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { cn } from "../../lib/cn";
import { Shiny } from "../ui/Shiny";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import {
  Archive,
  AudioWaveform,
  BarChart3,
  Boxes,
  ChevronLeft,
  Disc3,
  FolderTree,
  Hash,
  KeyRound,
  LayoutDashboard,
  LibraryIcon,
  ListMusic,
  Music4,
  PanelLeft,
  Search,
  SettingsIcon,
  Tags,
  Workflow,
} from "../../lib/icons";

type Item = { to: string; label: string; icon: typeof LayoutDashboard };
type Group = { heading?: string; items: Item[] };

const GROUPS: Group[] = [
  { items: [{ to: "/dashboard", label: "Πίνακας", icon: LayoutDashboard }] },
  {
    heading: "Βιβλιοθήκη",
    items: [
      { to: "/provenance", label: "Προέλευση συλλογών", icon: Disc3 },
      { to: "/recovery", label: "Πληρότητα & ανάκτηση", icon: Disc3 },
      { to: "/collections", label: "Συλλογές", icon: Disc3 },
      { to: "/canonical", label: "Μεταδεδομένα & καλλιτέχνες", icon: Disc3 },
      { to: "/unified", label: "Ενοποιημένη βιβλιοθήκη", icon: Disc3 },
      { to: "/library", label: "Βιβλιοθήκη", icon: LibraryIcon },
      { to: "/artists", label: "Καλλιτέχνες", icon: AudioWaveform },
      { to: "/crates", label: "Crates", icon: Archive },
      { to: "/playlists", label: "Sets / Playlists", icon: Music4 },
      { to: "/smart-folders", label: "Έξυπνοι φάκελοι", icon: FolderTree },
    ],
  },
  {
    heading: "Εργαλεία DJ",
    items: [
      { to: "/tag", label: "Ουρά tagging", icon: Tags },
      { to: "/sets", label: "Χτίσιμο set", icon: ListMusic },
      { to: "/flow", label: "Flow Finder", icon: Workflow },
      { to: "/energy-maps", label: "Energy Maps", icon: BarChart3 },
      { to: "/key-harmony", label: "Key & Harmony", icon: KeyRound },
      { to: "/tag-cloud", label: "Tag Cloud", icon: Hash },
      { to: "/phrase-finder", label: "Phrase Finder", icon: AudioWaveform },
    ],
  },
  {
    heading: "Συλλογή",
    items: [
      { to: "/duplicates", label: "Διπλότυπα", icon: Boxes },
      { to: "/settings", label: "Ρυθμίσεις", icon: SettingsIcon },
    ],
  },
];

const STORAGE_KEY = "cm:sidebar-collapsed";

const openPalette = () => window.dispatchEvent(new Event("cm:palette"));

/** Full sidebar nav row: icon + label, active accent bar. */
function NavItem({ to, label, icon: Icon }: Item) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "group relative flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition",
          isActive ? "bg-cm-cyan/10 text-cm-text" : "text-cm-muted hover:bg-white/5 hover:text-cm-text",
        )
      }
    >
      {({ isActive }) => (
        <>
          <span
            className={cn(
              "absolute left-0 top-1/2 h-5 -translate-y-1/2 rounded-full bg-cm-cyan transition-all",
              isActive ? "w-0.5 opacity-100" : "w-0 opacity-0",
            )}
          />
          <Icon className={cn("h-4 w-4 shrink-0", isActive && "text-cm-cyan")} />
          <span className="truncate">{label}</span>
        </>
      )}
    </NavLink>
  );
}

/** Island nav button: icon only, label via tooltip on top. */
function IslandItem({ to, label, icon: Icon }: Item) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <NavLink
          to={to}
          aria-label={label}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-cm-muted transition hover:bg-white/5 hover:text-cm-text aria-[current=page]:bg-cm-cyan/15 aria-[current=page]:text-cm-cyan"
        >
          <Icon className="h-4 w-4" />
        </NavLink>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

function IslandButton({
  onClick,
  label,
  tip,
  icon: Icon,
}: {
  onClick: () => void;
  label: string;
  tip: string;
  icon: typeof LayoutDashboard;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-cm-muted transition hover:bg-white/5 hover:text-cm-text"
        >
          <Icon className="h-4 w-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{tip}</TooltipContent>
    </Tooltip>
  );
}

const Divider = () => <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-white/10" />;

export default function Sidebar() {
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  });

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  // Collapsed → floating island nav bar, centered above the player dock.
  if (collapsed) {
    return (
      <div className="pointer-events-none fixed inset-x-0 bottom-[72px] z-30 flex justify-center px-3">
        <div className="pointer-events-auto flex max-w-[calc(100vw-1.5rem)] items-center gap-1 overflow-x-auto rounded-2xl border border-white/10 bg-cm-bg-2/85 px-2 py-1.5 shadow-[0_8px_40px_-8px_rgba(0,0,0,0.7)] backdrop-blur-xl">
          {GROUPS.flatMap((g, gi) => [
            ...(gi > 0 ? [<Divider key={`d${gi}`} />] : []),
            ...g.items.map((it) => <IslandItem key={it.to} {...it} />),
          ])}

          <Divider />
          <IslandButton onClick={openPalette} label="Αναζήτηση (⌘K)" tip="Αναζήτηση · ⌘K" icon={Search} />
          <IslandButton
            onClick={() => setCollapsed(false)}
            label="Ανάπτυξη πλαϊνής μπάρας"
            tip="Ανάπτυξη πλαϊνής μπάρας"
            icon={PanelLeft}
          />
        </div>
      </div>
    );
  }

  // Expanded → full sidebar.
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-white/8 bg-cm-bg-2/40 backdrop-blur-xl">
      <div className="shrink-0 px-3 pt-4">
        <NavLink
          to="/dashboard"
          aria-label="CrateMind — Πίνακας"
          className="mb-4 flex items-center justify-center px-2 pt-1 transition-opacity hover:opacity-80"
        >
          <img src="/logo.png" alt="CrateMind" className="h-auto w-40 select-none" draggable={false} />
        </NavLink>

        <button
          type="button"
          onClick={openPalette}
          className="mb-2 flex w-full items-center gap-2 rounded-xl border border-white/8 bg-white/5 px-3 py-2 text-sm text-cm-muted transition hover:border-cm-cyan/30 hover:text-cm-text"
        >
          <Search className="h-4 w-4 shrink-0" />
          <span className="flex-1 text-left">Αναζήτηση</span>
          <kbd className="rounded border border-white/15 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-cm-faint">⌘K</kbd>
        </button>
      </div>

      <nav className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-2">
        {GROUPS.map((g, gi) => (
          <div key={g.heading ?? gi} className="flex flex-col gap-0.5">
            {g.heading && (
              <div className="px-3 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.15em] text-cm-faint/70">
                {g.heading}
              </div>
            )}
            {g.items.map((it) => (
              <NavItem key={it.to} {...it} />
            ))}
          </div>
        ))}
      </nav>

      <div className="shrink-0 px-3 pb-4 pt-2">
        <div className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] text-cm-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-cm-chartreuse shadow-[0_0_8px_var(--color-cm-chartreuse)]" />
          <Shiny text="Τοπική DB · Ιδιωτικό" />
        </div>

        <button
          type="button"
          onClick={() => setCollapsed(true)}
          aria-label="Σύμπτυξη πλαϊνής μπάρας"
          className="mt-2 flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm text-cm-muted transition hover:bg-white/5 hover:text-cm-text"
        >
          <ChevronLeft className="h-4 w-4 shrink-0" />
          <span className="truncate">Σύμπτυξη</span>
        </button>
      </div>
    </aside>
  );
}
