import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "./ui/command";
import {
  Archive,
  BarChart3,
  Boxes,
  CheckCircle2,
  Crosshair,
  Flame,
  GitBranch,
  Hash,
  KeyRound,
  LayoutDashboard,
  LibraryIcon,
  ListMusic,
  Music4,
  SettingsIcon,
  Tags,
  Workflow,
} from "../lib/icons";

const NAV = [
  { to: "/dashboard", label: "Πίνακας", icon: LayoutDashboard },
  { to: "/library", label: "Βιβλιοθήκη", icon: LibraryIcon },
  { to: "/crates", label: "Crates", icon: Archive },
  { to: "/playlists", label: "Sets / Playlists", icon: Music4 },
  { to: "/tag", label: "Ουρά tagging", icon: Tags },
  { to: "/sets", label: "Χτίσιμο set", icon: ListMusic },
  { to: "/flow", label: "Flow Finder", icon: Workflow },
  { to: "/energy-maps", label: "Energy Maps", icon: BarChart3 },
  { to: "/key-harmony", label: "Key & Harmony", icon: KeyRound },
  { to: "/tag-cloud", label: "Tag Cloud", icon: Hash },
  { to: "/duplicates", label: "Διπλότυπα", icon: Boxes },
  { to: "/settings", label: "Ρυθμίσεις", icon: SettingsIcon },
];

const PRESETS = [
  { q: "weapons", label: "Όπλα", icon: Crosshair },
  { q: "approved", label: "Εγκεκριμένα", icon: CheckCircle2 },
  { q: "untagged", label: "Χωρίς tags", icon: Flame },
  { q: "role:bridge", label: "Γέφυρες", icon: GitBranch },
];

/** Global ⌘K / Ctrl+K command palette: jump to a screen or a Library crate. */
export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

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
      <CommandInput placeholder="Πήγαινε σε… ή ψάξε crate" />
      <CommandList>
        <CommandEmpty>Κανένα αποτέλεσμα.</CommandEmpty>
        <CommandGroup heading="Πλοήγηση">
          {NAV.map((n) => (
            <CommandItem key={n.to} value={n.label} onSelect={() => go(n.to)}>
              <n.icon className="h-4 w-4" />
              <span>{n.label}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Γρήγορα crates">
          {PRESETS.map((p) => (
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
      </CommandList>
    </CommandDialog>
  );
}
