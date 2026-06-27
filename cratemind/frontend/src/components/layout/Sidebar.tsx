import { NavLink } from "react-router-dom";
import { cn } from "../../lib/cn";
import {
  Archive,
  AudioWaveform,
  BarChart3,
  Boxes,
  FolderTree,
  Hash,
  KeyRound,
  LayoutDashboard,
  LibraryIcon,
  ListMusic,
  Music4,
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
      { to: "/library", label: "Βιβλιοθήκη", icon: LibraryIcon },
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

export default function Sidebar() {
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
          onClick={() => window.dispatchEvent(new Event("cm:palette"))}
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
          Τοπική DB · Ιδιωτικό
        </div>
      </div>
    </aside>
  );
}
