import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { NavLink, useLocation } from "react-router-dom";
import { canAccessRoute, useCapabilities } from "../../lib/capabilities";
import { cn } from "../../lib/cn";
import { ThemeToggle } from "../ui/ThemeToggle";
import { ResizeHandle } from "../ui/ResizeHandle";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { useResizable } from "../../lib/useResizable";
import {
  Archive,
  AudioWaveform,
  BarChart3,
  Boxes,
  ChevronDown,
  ChevronLeft,
  Disc3,
  FolderTree,
  GitBranch,
  Hash,
  KeyRound,
  Layers,
  LayoutDashboard,
  LibraryIcon,
  ListMusic,
  Music4,
  PanelLeft,
  Search,
  SettingsIcon,
  ShieldCheck,
  SlidersHorizontal,
  Tags,
  Workflow,
} from "../../lib/icons";

type SubItem = { to: string; label: string; icon: typeof LayoutDashboard };
type Item = {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  subItems?: SubItem[];
};
type Group = { heading?: string; items: Item[] };

const GROUPS: Group[] = [
  { items: [{ to: "/dashboard", label: "Πίνακας", icon: LayoutDashboard }] },
  {
    heading: "Βιβλιοθήκη",
    items: [
      { to: "/library", label: "Βιβλιοθήκη", icon: LibraryIcon },
      {
        to: "/collections",
        label: "Συλλογές",
        icon: Disc3,
        subItems: [
          { to: "/provenance", label: "Προέλευση συλλογών", icon: GitBranch },
          { to: "/recovery", label: "Πληρότητα & ανάκτηση", icon: ShieldCheck },
          { to: "/canonical", label: "Μεταδεδομένα & καλλιτέχνες", icon: SlidersHorizontal },
          { to: "/unified", label: "Ενοποιημένη βιβλιοθήκη", icon: Layers },
        ],
      },
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
const SIDEBAR_MIN_WIDTH = 292;

const openPalette = () => window.dispatchEvent(new Event("cm:palette"));

/** Full sidebar nav row: icon + label, active accent bar, and optional sub-items. */
function NavItem({
  item,
  isExpanded,
  onToggleExpand,
  onSelect,
}: {
  item: Item;
  isExpanded?: boolean;
  onToggleExpand?: (e: React.MouseEvent) => void;
  onSelect?: () => void;
}) {
  const Icon = item.icon;
  const hasSubItems = Boolean(item.subItems && item.subItems.length > 0);

  return (
    <div className="flex flex-col gap-0.5">
      <div className="group/row relative flex items-center">
        <NavLink
          to={item.to}
          onClick={onSelect}
          className={({ isActive }) =>
            cn(
              "group relative flex flex-1 items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition",
              hasSubItems && "pr-8",
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
              <span className="truncate">{item.label}</span>
            </>
          )}
        </NavLink>

        {hasSubItems && (
          <button
            type="button"
            onClick={onToggleExpand}
            aria-label={isExpanded ? "Σύμπτυξη υπο-ενοτήτων" : "Ανάπτυξη υπο-ενοτήτων"}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 flex h-6 w-6 items-center justify-center rounded-lg text-cm-muted/70 transition hover:bg-white/10 hover:text-cm-text"
          >
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 transition-transform duration-200",
                isExpanded && "rotate-180 text-cm-cyan",
              )}
            />
          </button>
        )}
      </div>

      {hasSubItems && isExpanded && (
        <div className="ml-5 flex flex-col gap-0.5 border-l border-black/10 dark:border-white/10 pl-2.5 py-0.5">
          {item.subItems!.map((sub) => {
            const SubIcon = sub.icon;
            return (
              <NavLink
                key={sub.to}
                to={sub.to}
                className={({ isActive }) =>
                  cn(
                    "group relative flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs transition",
                    isActive
                      ? "bg-cm-cyan/15 font-medium text-cm-cyan"
                      : "text-cm-muted hover:bg-white/5 hover:text-cm-text",
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <SubIcon
                      className={cn(
                        "h-3.5 w-3.5 shrink-0 transition-opacity",
                        isActive
                          ? "opacity-100 text-cm-cyan"
                          : "opacity-60 group-hover:opacity-100",
                      )}
                    />
                    <span className="truncate">{sub.label}</span>
                  </>
                )}
              </NavLink>
            );
          })}
        </div>
      )}
    </div>
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
  const location = useLocation();
  const capabilities = useCapabilities();
  const groups = GROUPS.map(group => ({
    ...group,
    items: group.items.filter(item => canAccessRoute(capabilities, item.to)).map(item => ({
      ...item, subItems: item.subItems?.filter(sub => canAccessRoute(capabilities, sub.to)),
    })),
  })).filter(group => group.items.length > 0);

  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  });

  const [collectionsExpanded, setCollectionsExpanded] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("cm:sidebar-collections-expanded") === "1";
  });

  const isCollectionsRoute = [
    "/collections",
    "/provenance",
    "/recovery",
    "/canonical",
    "/unified",
  ].some((route) => location.pathname === route || location.pathname.startsWith(`${route}/`));

  useEffect(() => {
    if (isCollectionsRoute) {
      setCollectionsExpanded(true);
    }
  }, [location.pathname, isCollectionsRoute]);

  const toggleCollections = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCollectionsExpanded((prev) => {
      const next = !prev;
      window.localStorage.setItem("cm:sidebar-collections-expanded", next ? "1" : "0");
      return next;
    });
  };

  const {
    size: width,
    isDragging,
    handleProps,
  } = useResizable({
    direction: "horizontal",
    initial: SIDEBAR_MIN_WIDTH,
    min: SIDEBAR_MIN_WIDTH,
    max: 350,
    storageKey: "cm:sidebar-width",
  });

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  // Collapsed → floating island nav bar, centered above the player dock.
  if (collapsed) {
    const island = (
      <div
        style={{ bottom: "calc(var(--cm-player-height, 64px) + 12px)" }}
        className="pointer-events-none fixed inset-x-0 z-50 flex justify-center px-3"
      >
        <div className="pointer-events-auto flex max-w-[calc(100vw-1.5rem)] items-center gap-1 overflow-x-auto rounded-2xl border border-cm-line/20 dark:border-white/10 bg-cm-bg-2/85 px-2 py-1.5 shadow-[0_8px_40px_-8px_rgba(0,0,0,0.7)] backdrop-blur-xl">
          {groups.flatMap((g, gi) => [
            ...(gi > 0 ? [<Divider key={`d${gi}`} />] : []),
            ...g.items.map((it) => <IslandItem key={it.to} {...it} />),
          ])}

          <Divider />
          <ThemeToggle compact />
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

    return typeof document !== "undefined" ? createPortal(island, document.body) : null;
  }

  // Expanded → full sidebar with resizable width.
  return (
    <aside
      style={{ width: `${width}px` }}
      className="relative flex shrink-0 flex-col border-r border-cm-line/20 dark:border-white/8 bg-cm-bg-2/40 backdrop-blur-xl"
    >
      <ResizeHandle
        orientation="vertical"
        isDragging={isDragging}
        ariaLabel="Αλλαγή πλάτους αριστερής μπάρας"
        className="absolute -right-1.5 top-0 bottom-0 z-30"
        {...handleProps}
      />
      <div className="shrink-0 px-3 pt-4">
        <NavLink
          to="/dashboard"
          aria-label="CrateMind — Πίνακας"
          className="mb-4 flex items-center justify-center px-2 pt-1 transition-opacity hover:opacity-80"
        >
          <img src="/logo.png" alt="CrateMind" width={250} height={250} className="h-[250px] w-[250px] shrink-0 select-none object-contain" draggable={false} />
        </NavLink>

        <button
          type="button"
          onClick={openPalette}
          className="mb-2 flex w-full items-center gap-2 rounded-xl border border-cm-line/20 dark:border-white/8 bg-white/5 px-3 py-2 text-sm text-cm-muted transition hover:border-cm-cyan/30 hover:text-cm-text"
        >
          <Search className="h-4 w-4 shrink-0" />
          <span className="flex-1 text-left">Αναζήτηση</span>
          <kbd className="rounded border border-cm-line/20 dark:border-white/15 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-cm-faint">⌘K</kbd>
        </button>
      </div>

      <nav className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-2">
        {groups.map((g, gi) => (
          <div key={g.heading ?? gi} className="flex flex-col gap-0.5">
            {g.heading && (
              <div className="px-3 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.15em] text-cm-faint/70">
                {g.heading}
              </div>
            )}
            {g.items.map((it) => (
              <NavItem
                key={it.to}
                item={it}
                isExpanded={it.to === "/collections" ? collectionsExpanded : undefined}
                onToggleExpand={it.to === "/collections" ? toggleCollections : undefined}
                onSelect={it.to === "/collections" ? () => setCollectionsExpanded(true) : undefined}
              />
            ))}
          </div>
        ))}
      </nav>

      <div className="grid shrink-0 grid-cols-[1fr_auto] items-center gap-2 px-3 pb-4 pt-2">
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          aria-label="Σύμπτυξη πλαϊνής μπάρας"
          className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm text-cm-muted transition hover:bg-cm-line/5 hover:text-cm-text"
        >
          <ChevronLeft className="h-4 w-4 shrink-0" />
          <span className="truncate">Σύμπτυξη</span>
        </button>
        <ThemeToggle compact />
      </div>
    </aside>
  );
}
