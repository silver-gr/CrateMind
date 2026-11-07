import { preferenceStorage } from "../../lib/preferenceStorage";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NavLink, useLocation } from "react-router-dom";
import { useCapabilities, visibleNavGroups } from "../../lib/capabilities";
import { usePref } from "../../lib/prefs";
import { toolsHeading } from "../../lib/profileCopy";
import { energyMapTitle } from "../../lib/energyMapAxes";
import { cn } from "../../lib/cn";
import { ThemeToggle } from "../ui/ThemeToggle";
import MetallicPaint from "../ui/MetallicPaint";
import { useTheme } from "../../lib/theme";
import { AudioSettingsButton, BackgroundSettingsButton } from "./AppearanceControls";
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
type Group = { heading?: string; tools?: boolean; items: Item[] }; // `tools`: heading follows the profile

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
    tools: true,
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
                : "text-cm-muted hover:bg-cm-contrast/5 hover:text-cm-text",
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
            className="absolute right-1.5 top-1/2 -translate-y-1/2 flex h-6 w-6 items-center justify-center rounded-lg text-cm-muted/70 transition hover:bg-cm-contrast/10 hover:text-cm-text"
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
                      : "text-cm-muted hover:bg-cm-contrast/5 hover:text-cm-text",
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

/** The logo symbol. Swap the file at this path for a new export; no other change is needed. */
// Vector symbol (hand-redrawn ink paths); "/logo-mark.png" is the earlier raster silhouette.
const LOGO_MARK_SRC = "/logo-mark.svg";

/** Full-colour art, framed to the SVG's 1000x1000 viewBox (see public/logo-color.png). */
const LOGO_COLOR_SRC = "/logo-color.png";

/**
 * Logo symbol: the full-colour art underneath, the Metallic Paint mark (React Bits "prism"
 * preset) blended on top. MetallicPaint fits the square image to the box height and scales it
 * by `scale`, so the colour layer is a centred square of height 92% to coincide with the metal.
 * Dark: `screen` (the shader's dark-blue stripes leave the colour alone, its near-white stripes
 * add highlights). Light: `multiply` (white stripes keep the colour, dark stripes shade it).
 */
function BrandMark() {
  const [theme] = useTheme();
  const light = theme === "light";
  const layer = "pointer-events-none absolute left-1/2 top-1/2 aspect-square h-[92%] max-w-none -translate-x-1/2 -translate-y-1/2 select-none";
  return (
    <div className="relative isolate h-full w-full">
      <img src={LOGO_COLOR_SRC} alt="" draggable={false} aria-hidden="true" className={cn(layer, "opacity-40 blur-md")} />
      <img src={LOGO_COLOR_SRC} alt="" draggable={false} aria-hidden="true" className={cn(layer, light ? "opacity-75" : "opacity-70")} />
      <div className={cn("absolute inset-0", light ? "opacity-90 mix-blend-multiply" : "opacity-90 mix-blend-screen")}>
        <MetallicPaint
          imageSrc={LOGO_MARK_SRC}
          color="#9cc4ff"
          dispersion={1}
          density={6}
          softness={0.8}
          distortion={0.4}
          edgeBend={0.4}
          angle={0}
          scale={0.92} // 92% of the 250px box height = 230px art; matches the colour layers' h-[92%]
          lightMode={light}
        />
      </div>
    </div>
  );
}

/** «CrateMind» wordmark in Metallic Paint text mode: the user's "liquid" settings in Geist, in white. */
function BrandWordmark() {
  const [theme] = useTheme();
  return (
    <MetallicPaint
      text="CrateMind"
      fontFamily="'Geist Variable', system-ui, sans-serif"
      fontWeight={800}
      color="#ffffff"
      density={0.8}
      softness={0.18}
      dispersion={0.2}
      distortion={0.48}
      edgeBend={0.32}
      angle={102}
      speed={0.95}
      scale={1.03} // kept from the Inter version so the wordmark stays as large (the preset's 0.49 suits its 300px demo box)
      lightMode={theme === "light"}
    />
  );
}

/** Island nav button: icon only, label via tooltip on top. */
type TipSide = "top" | "right";

function IslandItem({ to, label, icon: Icon, side = "top" }: Item & { side?: TipSide }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <NavLink
          to={to}
          aria-label={label}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-cm-muted transition hover:bg-cm-contrast/5 hover:text-cm-text aria-[current=page]:bg-cm-cyan/15 aria-[current=page]:text-cm-cyan"
        >
          <Icon className="h-4 w-4" />
        </NavLink>
      </TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}

function IslandButton({
  onClick,
  label,
  tip,
  icon: Icon,
  side = "top",
}: {
  onClick: () => void;
  label: string;
  tip: string;
  icon: typeof LayoutDashboard;
  side?: TipSide;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-cm-muted transition hover:bg-cm-contrast/5 hover:text-cm-text"
        >
          <Icon className="h-4 w-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side={side}>{tip}</TooltipContent>
    </Tooltip>
  );
}

const Divider = () => <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-cm-contrast/10" />;
const RailDivider = () => <span aria-hidden className="my-1 h-px w-5 shrink-0 bg-cm-contrast/10" />;

/** The collapsed icon rail (Ρυθμίσεις > «Σύμπτυξη πλαϊνής μπάρας» = «Στενή πλαϊνή μπάρα»). */
export const RAIL_WIDTH = 56;
/** Width morph between the full sidebar and the rail; the rail icons then cascade in (index.css cm-rail-in). */
export const RAIL_MORPH_MS = 420;
const RAIL_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export default function Sidebar() {
  const location = useLocation();
  const capabilities = useCapabilities();
  const [profile] = usePref("libraryProfile");
  const groups = visibleNavGroups(GROUPS, capabilities, profile).map(group =>
    group.tools ? {
      ...group,
      heading: toolsHeading(profile),
      items: group.items.map(item => item.to === "/energy-maps" ? { ...item, label: energyMapTitle(profile) } : item),
    } : group);

  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return preferenceStorage.getItem(STORAGE_KEY) === "1";
  });

  const [collectionsExpanded, setCollectionsExpanded] = useState(() => {
    if (typeof window === "undefined") return false;
    return preferenceStorage.getItem("cm:sidebar-collections-expanded") === "1";
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
      preferenceStorage.setItem("cm:sidebar-collections-expanded", next ? "1" : "0");
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
    preferenceStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  // Pages can fold/unfold the sidebar (Set Builder «Εστίαση στο set»).
  useEffect(() => {
    const onRequest = (e: Event) => {
      const detail = (e as CustomEvent<{ collapsed: boolean }>).detail;
      if (detail && typeof detail.collapsed === "boolean") setCollapsed(detail.collapsed);
    };
    window.addEventListener("cratemind:sidebar-collapse", onRequest);
    return () => window.removeEventListener("cratemind:sidebar-collapse", onRequest);
  }, []);

  const [collapseStyle] = usePref("sidebarCollapseStyle");
  const rail = collapsed && collapseStyle === "rail";
  // Collapsing to the rail (or expanding from it) morphs the aside's width from the old size to the new one.
  // `morph` is the width to render while animating; null means "no animation, use the resting width".
  const [morph, setMorph] = useState<{ width: number; animate: boolean } | null>(null);
  const wasRail = useRef(rail);
  useLayoutEffect(() => {
    if (wasRail.current === rail) return;
    wasRail.current = rail;
    if (collapseStyle !== "rail" || prefersReducedMotion()) return;
    const from = rail ? width : RAIL_WIDTH;
    const to = rail ? RAIL_WIDTH : width;
    setMorph({ width: from, animate: false });
    // Two frames: paint the starting width first, then transition to the target.
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => { raf2 = requestAnimationFrame(() => setMorph({ width: to, animate: true })); });
    const done = window.setTimeout(() => setMorph(null), RAIL_MORPH_MS + 60);
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); window.clearTimeout(done); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rail]);
  const morphStyle = (resting: number) => ({
    width: `${morph?.width ?? resting}px`,
    transition: morph?.animate ? `width ${RAIL_MORPH_MS}ms ${RAIL_EASE}` : undefined,
  });

  // Collapsed + «Στενή πλαϊνή μπάρα» → an attached, scrollable icon rail on the left edge.
  if (rail) {
    let n = 0;
    const cascade = () => ({ animationDelay: `${120 + 18 * n++}ms` });
    return (
      <aside
        aria-label="Πλαϊνή μπάρα"
        style={morphStyle(RAIL_WIDTH)}
        className="relative flex shrink-0 flex-col items-center overflow-hidden border-r border-cm-line/20 dark:border-white/8 bg-cm-bg-2/40 backdrop-blur-xl"
      >
        <NavLink to="/dashboard" tabIndex={-1} aria-hidden="true" className="cm-rail-in mt-3 block h-9 w-10 shrink-0" style={cascade()}>
          <BrandMark />
        </NavLink>
        <nav aria-label="Πλοήγηση" className="mt-2 flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto overflow-x-hidden px-2 py-1">
          {groups.flatMap((g, gi) => [
            ...(gi > 0 ? [<RailDivider key={`d${gi}`} />] : []),
            ...g.items.map((it) => (
              <span key={it.to} className="cm-rail-in" style={cascade()}>
                <IslandItem {...it} side="right" />
              </span>
            )),
          ])}
        </nav>
        <div className="cm-rail-in flex shrink-0 flex-col items-center gap-1 px-2 pb-3 pt-1" style={cascade()}>
          <RailDivider />
          <BackgroundSettingsButton />
          <ThemeToggle compact />
          <AudioSettingsButton />
          <IslandButton onClick={openPalette} label="Αναζήτηση (⌘K)" tip="Αναζήτηση · ⌘K" icon={Search} side="right" />
          <IslandButton onClick={() => setCollapsed(false)} label="Ανάπτυξη πλαϊνής μπάρας" tip="Ανάπτυξη πλαϊνής μπάρας" icon={PanelLeft} side="right" />
        </div>
      </aside>
    );
  }

  // Collapsed → floating island nav bar, centered above the player dock.
  if (collapsed) {
    const island = (
      <div
        style={{ bottom: "calc(var(--cm-player-height, 64px) + 12px)" }}
        className="pointer-events-none fixed inset-x-0 z-50 flex justify-center px-3"
      >
        <div className="pointer-events-auto flex max-w-[calc(100vw-1.5rem)] items-center gap-1 overflow-x-auto rounded-2xl border border-cm-line/20 dark:border-white/10 bg-cm-bg-2/85 px-2 py-1.5 shadow-[0_8px_40px_-8px_rgba(0,0,0,0.7)] backdrop-blur-xl">
          <NavLink to="/dashboard" tabIndex={-1} aria-hidden="true" className="block h-8 w-9 shrink-0">
            <BrandMark />
          </NavLink>
          <Divider />
          {groups.flatMap((g, gi) => [
            ...(gi > 0 ? [<Divider key={`d${gi}`} />] : []),
            ...g.items.map((it) => <IslandItem key={it.to} {...it} />),
          ])}

          <Divider />
          <BackgroundSettingsButton />
          <ThemeToggle compact />
          <AudioSettingsButton />
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
      style={morphStyle(width)}
      className={cn("relative flex shrink-0 flex-col border-r border-cm-line/20 dark:border-white/8 bg-cm-bg-2/40 backdrop-blur-xl", morph && "overflow-hidden")}
    >
      <ResizeHandle
        orientation="vertical"
        isDragging={isDragging}
        ariaLabel="Αλλαγή πλάτους αριστερής μπάρας"
        className="absolute -right-1.5 top-0 bottom-0 z-30"
        {...handleProps}
      />
      <div className="shrink-0 px-3 pt-4">
        <div className="mb-4 flex flex-col items-center gap-2 pt-1">
          <NavLink to="/dashboard" tabIndex={-1} aria-hidden="true" className="block h-[250px] w-[250px] max-w-full shrink-0 overflow-hidden">
            <BrandMark />
          </NavLink>
          <NavLink to="/dashboard" aria-label="CrateMind — Πίνακας" className="-mt-5 block h-[70px] w-[270px] max-w-full shrink-0 overflow-hidden rounded-lg focus-visible:outline-2 focus-visible:outline-cm-cyan">
            <BrandWordmark />
          </NavLink>
        </div>

        <button
          type="button"
          onClick={openPalette}
          className="mb-2 flex w-full items-center gap-2 rounded-xl border border-cm-line/20 dark:border-white/8 bg-cm-contrast/5 px-3 py-2 text-sm text-cm-muted transition hover:border-cm-cyan/30 hover:text-cm-text"
        >
          <Search className="h-4 w-4 shrink-0" />
          <span className="flex-1 text-left">Αναζήτηση</span>
          <kbd className="rounded border border-cm-line/20 dark:border-white/15 bg-cm-contrast/5 px-1.5 py-0.5 font-mono text-[10px] text-cm-faint">⌘K</kbd>
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

      <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-1.5 px-3 pb-4 pt-2">
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          aria-label="Σύμπτυξη πλαϊνής μπάρας"
          className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm text-cm-muted transition hover:bg-cm-line/5 hover:text-cm-text"
        >
          <ChevronLeft className="h-4 w-4 shrink-0" />
          <span className="truncate">Σύμπτυξη</span>
        </button>
        <BackgroundSettingsButton />
        <ThemeToggle compact />
        <AudioSettingsButton />
      </div>
    </aside>
  );
}
