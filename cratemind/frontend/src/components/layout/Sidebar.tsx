import { NavLink } from "react-router-dom";
import { cn } from "../../lib/cn";
import {
  Boxes,
  Disc3,
  LayoutDashboard,
  LibraryIcon,
  ListMusic,
  SettingsIcon,
  Tags,
} from "../../lib/icons";

const NAV = [
  { to: "/dashboard", label: "Πίνακας", icon: LayoutDashboard },
  { to: "/library", label: "Βιβλιοθήκη", icon: LibraryIcon },
  { to: "/tag", label: "Ουρά tagging", icon: Tags },
  { to: "/sets", label: "Χτίσιμο set", icon: ListMusic },
  { to: "/duplicates", label: "Διπλότυπα", icon: Boxes },
  { to: "/settings", label: "Ρυθμίσεις", icon: SettingsIcon },
];

export default function Sidebar() {
  return (
    <aside className="flex w-60 shrink-0 flex-col gap-1 border-r border-white/8 bg-cm-bg-2/40 px-3 py-4 backdrop-blur-xl">
      <div className="mb-6 flex items-center gap-2.5 px-2">
        <div className="glow-cyan flex h-9 w-9 items-center justify-center rounded-xl bg-cm-cyan/15">
          <Disc3 className="h-5 w-5 text-cm-cyan" />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-tight text-cm-text">CrateMind</div>
          <div className="text-[10px] uppercase tracking-[0.15em] text-cm-faint">
            Τοπική DJ νοημοσύνη
          </div>
        </div>
      </div>

      <nav className="flex flex-col gap-0.5">
        {NAV.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              cn(
                "group relative flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition",
                isActive
                  ? "bg-cm-cyan/10 text-cm-text"
                  : "text-cm-muted hover:bg-white/5 hover:text-cm-text",
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
        ))}
      </nav>

      <div className="mt-auto px-2 pt-4">
        <div className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] text-cm-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-cm-chartreuse shadow-[0_0_8px_var(--color-cm-chartreuse)]" />
          Τοπική DB · Ιδιωτικό
        </div>
      </div>
    </aside>
  );
}
