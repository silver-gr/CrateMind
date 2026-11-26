import { useEffect, useState } from "react";
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
  MicVocal,
  BarChart3,
  Boxes,
  CheckCircle2,
  Crosshair,
  Flame,
  GitBranch,
  Hash,
  HistoryIcon,
  Info,
  KeyRound,
  LayoutDashboard,
  LibraryIcon,
  ListMusic,
  Music4,
  SettingsIcon,
  Tags,
} from "../lib/icons";

export const NAV = [
  { to: "/dashboard", label: "Πίνακας", icon: LayoutDashboard },
  { to: "/library", label: "Βιβλιοθήκη", icon: LibraryIcon },
  { to: "/library?panel=artists", label: "Καλλιτέχνες", icon: MicVocal },
  { to: "/library?tab=crates", label: "Crates", icon: Archive },
  { to: "/library?tab=sets", label: "Sets / Playlists", icon: Music4 },
  { to: "/tag", label: "Ουρά tagging", icon: Tags },
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
    >
      <CommandInput placeholder="Πήγαινε σε… ή ψάξε crate ή κομμάτι" value={search} onValueChange={setSearch} />
      <CommandList>
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
    </CommandDialog>
  );
}
