import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../lib/api";
import { usePlayer, type DeckId } from "../lib/player";
import type { Track } from "../lib/types";
import { filterRoutes, useCapabilities } from "../lib/capabilities";
import { energyMapTitle } from "../lib/energyMapAxes";
import { usePref } from "../lib/prefs";
import { openAbout } from "../lib/appInfo";
import { quickPresets } from "../lib/profileCopy";
import { preferenceStorage } from "../lib/preferenceStorage";
import { TOP_BAR_HEIGHT } from "../lib/deckView";
import {
  PALETTE_HEIGHT_KEY,
  paletteDragHeight,
  paletteFrame,
  paletteHeight,
  paletteKeyHeight,
  parsePaletteHeight,
  type PaletteFrame,
} from "../lib/paletteHeight";
import { useTheme } from "../lib/theme";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "./ui/command";
import { Kbd } from "./ui/KeyboardHint";
import {
  Archive,
  UserRound,
  BarChart3,
  BookOpen,
  Boxes,
  CheckCircle2,
  Crosshair,
  Flame,
  GitBranch,
  Hash,
  HistoryIcon,
  ImageIcon,
  Info,
  KeyRound,
  LayoutDashboard,
  LibraryIcon,
  ListMusic,
  Moon,
  Music4,
  SettingsIcon,
  Sun,
  Tags,
} from "../lib/icons";

export const NAV = [
  { to: "/dashboard", label: "Πίνακας", icon: LayoutDashboard },
  { to: "/library", label: "Βιβλιοθήκη", icon: LibraryIcon },
  { to: "/library?panel=artists", label: "Καλλιτέχνες", icon: UserRound },
  { to: "/library?tab=crates", label: "Crates", icon: Archive },
  { to: "/library?tab=sets", label: "Sets / Playlists", icon: ListMusic },
  { to: "/tag", label: "Χαρακτηρισμός tracks", icon: Tags },
  { to: "/sets", label: "Χτίσιμο set", icon: ListMusic },
  { to: "/library?panel=history", label: "Ιστορικό", icon: HistoryIcon },
  { to: "/energy-maps", label: "Energy Maps", icon: BarChart3 },
  { to: "/key-harmony", label: "Key & Harmony", icon: KeyRound },
  { to: "/tag-cloud", label: "Tag Cloud", icon: Hash },
  { to: "/duplicates", label: "Διπλότυπα", icon: Boxes },
  { to: "/settings", label: "Ρυθμίσεις", icon: SettingsIcon },
];

const PRESET_ICONS: Record<string, typeof Crosshair> = {
  weapons: Crosshair,
  approved: CheckCircle2,
  untagged: Flame,
  "role:bridge": GitBranch,
};

function readFrame(): PaletteFrame {
  const bar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--cm-titlebar-height"));
  return paletteFrame(document.documentElement.clientHeight || window.innerHeight, Number.isFinite(bar) ? bar : TOP_BAR_HEIGHT);
}

function readStored(): number | null {
  try { return parsePaletteHeight(preferenceStorage.getItem(PALETTE_HEIGHT_KEY)); } catch { return null; }
}

function writeStored(height: number | null) {
  try {
    if (height === null) preferenceStorage.removeItem(PALETTE_HEIGHT_KEY);
    else preferenceStorage.setItem(PALETTE_HEIGHT_KEY, String(height));
  } catch { /* the height is a convenience */ }
}

/**
 * The palette's height while it is open: the stored choice (or about 70% of the window) clamped to this window, kept in
 * step with window resizes. Only the user's drag, keys or double-click write the preference; a clamp never does.
 */
function usePaletteHeight(open: boolean) {
  const [frame, setFrame] = useState<PaletteFrame | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const stored = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    stored.current = readStored();
    const sync = () => {
      const next = readFrame();
      setFrame(next);
      setHeight(paletteHeight(stored.current, next));
    };
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [open]);
  const choose = (next: number | null, persist: boolean) => {
    if (!frame) return;
    if (persist) { stored.current = next; writeStored(next); }
    setHeight(paletteHeight(next, frame));
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !frame || height === null) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const start = height;
    let latest = start;
    const move = (ev: PointerEvent) => { latest = paletteDragHeight(start, ev.clientY - startY, frame); setHeight(latest); };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      if (latest !== start) choose(latest, true);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // The handle sits inside cmdk's root, which would move the selection on arrows, Home / End and run it on Enter.
    // Escape still reaches the dialog, and Tab moves focus as usual.
    if (e.key !== "Escape" && e.key !== "Tab") e.stopPropagation();
    if (!frame || height === null) return;
    const next = paletteKeyHeight(e.key, height, frame);
    if (next === null) return;
    e.preventDefault();
    choose(next, true);
  };
  return { frame, height, onPointerDown, onKeyDown, reset: () => choose(null, true) };
}

/** Global ⌘K / Ctrl+K command palette: jump to a screen or a Library crate, or load a track on a deck. */
export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const capabilities = useCapabilities();
  const [profile] = usePref("libraryProfile");
  const nav = filterRoutes(NAV, capabilities, profile)
    .map(item => item.to === "/energy-maps" ? { ...item, label: energyMapTitle(profile) } : item);
  const presets = quickPresets(profile).map(p => ({ ...p, icon: PRESET_ICONS[p.q] ?? Hash }));
  const { load } = usePlayer();
  const size = usePaletteHeight(open);
  const [theme, setTheme] = useTheme();
  const [search, setSearch] = useState("");
  const [found, setFound] = useState<{ text: string; tracks: Track[] }>({ text: "", tracks: [] });
  const searchText = search.trim();
  const tracks = open && searchText.length >= 2 && found.text === searchText ? found.tracks : [];

  // Two or more typed letters search the library (the Library's search language), a moment after typing stops.
  useEffect(() => {
    if (!open || searchText.length < 2) return;
    let current = true;
    const timer = window.setTimeout(() => {
      api.listTracks(searchText, 8).then(rows => { if (current) setFound({ text: searchText, tracks: rows }); }).catch(() => {});
    }, 200);
    return () => { current = false; window.clearTimeout(timer); };
  }, [open, searchText]);

  // The palette stays mounted, so every way of closing it starts the next ⌘K empty.
  useEffect(() => { if (!open) setSearch(""); }, [open]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    function onOpen() {
      setOpen(true);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("cm:palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("cm:palette", onOpen);
    };
  }, []);

  function loadTrack(deck: DeckId, track: Track) {
    setOpen(false);
    if (!load(deck, track, { play: false, ifIdle: true })) toast(`Το Deck ${deck} παίζει — δεν φορτώθηκε`);
  }

  function go(to: string) {
    setOpen(false);
    navigate(to);
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Εντολές"
      description="Πλοήγηση και γρήγορη αναζήτηση"
      // A fixed height (the user's, or about 70% of the window) with a fixed top: filtering never moves or resizes the box.
      // transition-none: the content's duration-240 would otherwise animate every height step of a drag.
      className="flex flex-col transition-none"
      style={size.frame && size.height !== null ? { top: size.frame.top, height: size.height } : undefined}
    >
      <CommandInput placeholder="Πήγαινε σε… ή ψάξε crate ή κομμάτι" value={search} onValueChange={setSearch} />
      <CommandList className="max-h-none min-h-0 flex-1">
        {tracks.length === 0 && <CommandEmpty>Κανένα αποτέλεσμα.</CommandEmpty>}
        <CommandGroup heading="Πλοήγηση">
          {nav.map((n) => (
            <CommandItem key={n.to} value={n.label} onSelect={() => go(n.to)}>
              <n.icon className="h-4 w-4" />
              <span>{n.label}</span>
            </CommandItem>
          ))}
          <CommandItem value="Σχετικά με το CrateMind" keywords={["έκδοση", "άδεια", "συντελεστές"]} onSelect={() => { setOpen(false); openAbout(); }}>
            <Info className="h-4 w-4" />
            <span>Σχετικά με το CrateMind</span>
          </CommandItem>
          <CommandItem value="Λεξικό όρων" keywords={["βοήθεια", "όροι", "εξηγήσεις", "LUFS", "limiter", "Sync", "Camelot"]} onSelect={() => go("/glossary")}>
            <BookOpen className="h-4 w-4" />
            <span>Λεξικό όρων</span>
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        {/* The top bar's two buttons drop out in a narrow window; these keep them in reach (Settings > «Εμφάνιση» too). */}
        <CommandGroup heading="Εμφάνιση">
          <CommandItem value={theme === "dark" ? "Εναλλαγή σε Ηλιακό Φως (Solar Void)" : "Εναλλαγή σε Νυχτερινό Κενό (Night Void)"}
            keywords={["θέμα", "φωτεινό", "σκοτεινό"]} onSelect={() => { setOpen(false); setTheme(theme === "dark" ? "light" : "dark"); }}>
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            <span>{theme === "dark" ? "Εναλλαγή σε Ηλιακό Φως (Solar Void)" : "Εναλλαγή σε Νυχτερινό Κενό (Night Void)"}</span>
          </CommandItem>
          <CommandItem value="Επιλογή φόντου" keywords={["φόντο", "background", "Balatro"]} onSelect={() => go("/settings?section=appearance")}>
            <ImageIcon className="h-4 w-4" />
            <span>Επιλογή φόντου</span>
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Γρήγορα crates">
          {presets.map((p) => (
            <CommandItem
              key={p.q}
              value={`crate ${p.label}`}
              onSelect={() => go(`/library?q=${encodeURIComponent(p.q)}`)}
            >
              <p.icon className="h-4 w-4" />
              <span>{p.label}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        {tracks.length > 0 && (
          <CommandGroup heading="Κομμάτια" forceMount>
            {tracks.flatMap(track => (["A", "B"] as const).map(deck => (
              // forceMount: the library search already matched these rows; cmdk's own filter would drop most of them.
              <CommandItem key={`${track.id}-${deck}`} value={`track-${track.id}-${deck}`} forceMount onSelect={() => loadTrack(deck, track)}>
                <Music4 className="h-4 w-4" />
                <span className="min-w-0 truncate">{track.title || track.file_name}{track.artist ? ` · ${track.artist}` : ""}</span>
                <span className="ml-auto shrink-0 text-[11px] text-cm-faint">Φόρτωση στο Deck {deck}</span>
              </CommandItem>
            )))}
          </CommandGroup>
        )}
      </CommandList>
      <div className="flex items-center gap-3 border-t border-cm-border px-3 py-2 text-[11px] text-cm-faint">
        <span className="inline-flex items-center gap-1"><Kbd>↑↓</Kbd> επιλογή</span>
        <span className="inline-flex items-center gap-1"><Kbd>↵</Kbd> άνοιγμα</span>
        <span className="ml-auto inline-flex items-center gap-1"><Kbd>Esc</Kbd> κλείσιμο</span>
      </div>
      {size.frame && size.height !== null && (
        // The bottom edge: drag, arrows or Home / End change the height; a double-click returns to the default.
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="horizontal"
          aria-label="Ύψος παλέτας"
          aria-valuenow={size.height}
          aria-valuemin={size.frame.min}
          aria-valuemax={size.frame.max}
          title="Σύρε για να αλλάξεις το ύψος · διπλό κλικ για το αρχικό"
          onPointerDown={size.onPointerDown}
          onKeyDown={size.onKeyDown}
          onDoubleClick={size.reset}
          className="group absolute inset-x-0 bottom-0 flex h-2.5 cursor-row-resize touch-none items-end justify-center outline-none"
        >
          <span aria-hidden className="mb-0.5 h-1 w-8 rounded-full bg-cm-contrast/15 transition-colors duration-150 group-hover:bg-cm-cyan/70 group-focus-visible:bg-cm-cyan group-focus-visible:shadow-[0_0_8px_var(--color-cm-cyan)]" />
        </div>
      )}
    </CommandDialog>
  );
}
