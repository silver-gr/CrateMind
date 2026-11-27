import { useEffect, useId, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent } from "react";
import { fxPickerPeek, setFxPickerPeek, subscribeFxPickerPeek } from "../lib/fxPickerPeek";
import { ChevronDown, Star } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./ui/command";
import { Switch } from "./ui/switch";
import { cn } from "@/lib/cn";
import { selectPreset, setPhraseRelease, toggleFavourite, useFxRackStore } from "../lib/fxRack";
import { FX_FAMILIES, needsBpm, presetById, presetsOfFamily } from "../lib/fxRack/presets";
import type { FxPreset } from "../lib/fxRack/types";
import type { DeckId } from "../lib/player";

const FAV = "fav:";
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase().replace(/ς/g, "σ");

/** cmdk filter: every typed word must appear in the item's keywords, ignoring accents, case and final sigma («ηχω» finds «Ηχώ»). */
export function fxPresetFilter(value: string, search: string, keywords?: string[]): number {
  const text = fold(keywords?.join(" ") || value);
  return fold(search).trim().split(/\s+/).every(word => text.includes(word)) ? 1 : 0;
}

const familyLabel = (p: FxPreset) => FX_FAMILIES.find(f => f.id === p.family)?.label ?? "";

/**
 * The picker's contents: a search over every preset, «Αγαπημένα» first (hidden while searching), then the families,
 * and the deck's phrase-release switch. cmdk keeps focus in the search field, so Ctrl+D stars the highlighted item.
 */
export function FxRackPanel({ deck, presetId, noBpm, onPick }: { deck: DeckId; presetId: string; noBpm: boolean; onPick: () => void }) {
  const { favourites, phraseRelease } = useFxRackStore();
  const [search, setSearch] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const switchId = useId();
  const showFavourites = !search.trim() && favourites.length > 0;

  // Open on the current preset, centred in the list. Wait one frame: until floating-ui places the popover, the list has
  // no max-height, and cmdk marks the item selected only after its first layout effect.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const list = listRef.current;
      const item = list?.querySelector<HTMLElement>('[cmdk-item][data-selected="true"]');
      if (!list || !item) return;
      // Layout offsets, not client rects: on this frame the popover is still scaled by its zoom-in-95 open animation.
      list.scrollTop = item.offsetTop - list.offsetTop - (list.clientHeight - item.offsetHeight) / 2;
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // Latin layouts match the letter D; others (Greek: «δ») the physical D key.
    const isD = /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() === "d" : e.code === "KeyD";
    if (!e.ctrlKey || e.altKey || e.metaKey || !isD) return;
    const value = e.currentTarget.querySelector<HTMLElement>('[cmdk-item][data-selected="true"]')?.dataset.value;
    if (!value) return;
    e.preventDefault();
    toggleFavourite(value.startsWith(FAV) ? value.slice(FAV.length) : value);
  }

  const item = (p: FxPreset, value: string) => {
    const blocked = noBpm && needsBpm(p);
    const fav = favourites.includes(p.id);
    const current = p.id === presetId;
    return (
      <CommandItem key={value} value={value} keywords={[p.name, familyLabel(p), p.line]} disabled={blocked}
        title="Ctrl+D: αγαπημένο" onSelect={() => { selectPreset(deck, p.id); onPick(); }} className="group/fx items-center gap-2 py-1.5 pr-1">
        {/* The deck's current preset: a dot in the deck colour; the slot stays for every row so the names line up. */}
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", current ? "bg-[var(--deck)]" : "bg-transparent")} />
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate text-[13px] font-medium leading-5", current && "text-[var(--deck)]")}>
            {p.name}{current && <span className="sr-only"> (επιλεγμένο)</span>}{fav && <span className="sr-only"> (αγαπημένο)</span>}
          </span>
          <span className="block truncate text-xs leading-4 text-cm-muted">{p.line}</span>
        </span>
        {blocked && <span className="shrink-0 rounded border border-cm-line/30 px-1 font-mono text-[10px] leading-4 text-cm-muted">Χρειάζεται BPM</span>}
        {/* Pointer only (cmdk keeps focus in the field): the keyboard uses Ctrl+D, and the option's text carries the state,
            so the button is hidden from screen readers. Clickable even on a disabled item. */}
        <button type="button" tabIndex={-1} aria-hidden aria-pressed={fav} aria-label={fav ? "Αφαίρεση από τα αγαπημένα" : "Στα αγαπημένα"}
          title={fav ? "Αφαίρεση από τα αγαπημένα" : "Στα αγαπημένα"}
          onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); toggleFavourite(p.id); }}
          className={cn("pointer-events-auto flex size-7 shrink-0 items-center justify-center rounded-md outline-none transition-[color,opacity,scale] duration-150 ease-out hover:bg-cm-contrast/10 motion-safe:active:scale-[0.9]",
            fav ? "text-cm-amber" : "text-cm-faint opacity-0 group-hover/fx:opacity-100 group-data-[selected=true]/fx:opacity-100 [@media(hover:none)]:opacity-100")}>
          <Star className={cn("size-3.5", fav ? "fill-current text-cm-amber" : "text-cm-faint")} />
        </button>
      </CommandItem>
    );
  };

  const isFav = favourites.includes(presetId);
  return (
    <Command filter={fxPresetFilter} defaultValue={isFav ? FAV + presetId : presetId} loop onKeyDown={onKeyDown}>
      <CommandInput value={search} onValueChange={setSearch} aria-label="Αναζήτηση εφέ" placeholder="Αναζήτηση εφέ…" />
      <CommandList ref={listRef} className="max-h-[min(420px,calc(var(--radix-popover-content-available-height)-104px))]">
        <CommandEmpty>Δεν βρέθηκε εφέ.</CommandEmpty>
        {showFavourites && (
          <CommandGroup heading="Αγαπημένα">
            {favourites.map(id => presetById(id)).filter((p): p is FxPreset => !!p).map(p => item(p, FAV + p.id))}
          </CommandGroup>
        )}
        {FX_FAMILIES.map(f => (
          <CommandGroup key={f.id} heading={f.label}>
            {presetsOfFamily(f.id).map(p => item(p, p.id))}
          </CommandGroup>
        ))}
      </CommandList>
      <div className="flex items-center gap-3 border-t border-cm-border px-3 py-2.5">
        <label htmlFor={switchId} className="min-w-0 flex-1 cursor-pointer">
          <span className="block text-xs font-medium text-cm-text">Σταμάτημα στη φράση</span>
          <span className="block text-[11px] leading-4 text-cm-muted">Όταν το κλείνεις, σβήνει στην επόμενη γραμμή φράσης.</span>
        </label>
        <Switch id={switchId} size="sm" checked={phraseRelease[deck]} onCheckedChange={on => setPhraseRelease(deck, on)} />
      </div>
    </Command>
  );
}

/** The row's preset button and its popover (above the row; deck A's opens from the start edge, B's from the end). */
export function FxRackPicker({ deck, mirrored, presetId, noBpm, disabled }: { deck: DeckId; mirrored: boolean; presetId: string; noBpm: boolean; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  // A Shift + BEATS step on the controller shows the list while Shift is held (lib/fxPickerPeek). It takes no focus, and
  // the panel is mounted again on every step, so the list is centred on the effect just chosen.
  const peek = useSyncExternalStore(subscribeFxPickerPeek, fxPickerPeek, () => false) && !disabled && !open;
  const peeked = useRef(false);
  if (peek) peeked.current = true; else if (!open) peeked.current = false;
  const name = presetById(presetId)?.name ?? "";
  return (
    <Popover open={open || peek} onOpenChange={next => { setOpen(next && !peek); if (!next) setFxPickerPeek(false); }}>
      <PopoverTrigger asChild>
        <button type="button" disabled={disabled} aria-label={`Επιλογή εφέ, Deck ${deck}: ${name}`} title={name}
          className="group/fxp flex h-8 min-w-0 flex-1 items-center gap-1 rounded-lg border border-cm-line/30 bg-cm-contrast/8 pl-2.5 pr-1.5 text-left text-xs font-medium text-cm-text/90 outline-none select-none focus-visible:ring-2 focus-visible:ring-cm-cyan disabled:opacity-40 motion-safe:transition-[color,background-color,border-color,scale] motion-safe:duration-150 ease-out enabled:hover:border-cm-line/50 enabled:hover:text-cm-text motion-safe:enabled:active:scale-[0.98] data-[state=open]:border-[color-mix(in_oklch,var(--deck)_60%,transparent)] data-[state=open]:text-cm-text">
          <span className="min-w-0 flex-1 truncate">{name}</span>
          <ChevronDown aria-hidden className="size-3.5 shrink-0 text-cm-muted group-data-[state=open]/fxp:text-[var(--deck)]" />
        </button>
      </PopoverTrigger>
      {/* Portalled outside the deck, so it sets the deck colour itself. */}
      <PopoverContent side="top" align={mirrored ? "end" : "start"} collisionPadding={12} className="w-80 overflow-hidden p-0"
        onOpenAutoFocus={e => { if (peek) e.preventDefault(); }} onCloseAutoFocus={e => { if (peeked.current) e.preventDefault(); }}
        style={{ "--deck": deck === "A" ? "var(--cm-deck-a)" : "var(--cm-deck-b)" } as CSSProperties}>
        <FxRackPanel key={peek ? presetId : "own"} deck={deck} presetId={presetId} noBpm={noBpm} onPick={() => { setOpen(false); setFxPickerPeek(false); }} />
      </PopoverContent>
    </Popover>
  );
}
