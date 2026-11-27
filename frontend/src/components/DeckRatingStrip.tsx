import { useEffect, useState } from "react";
import { Segmented } from "./ui/Segmented";
import { StatusBadge } from "./ui/StatusBadge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuEntries, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { SHOWN_FIELDS, lacksProfileFields, ratingAction, ratingAxes, ratingTitle, statusAction, statusChoices, writeRating } from "../lib/fastRating";
import { axisLabel, editorStatus, type Axis } from "../lib/labels";
import type { MenuEntry } from "../lib/menus/entries";
import { usePlayer, type DeckId } from "../lib/player";
import { usePref } from "../lib/prefs";
import type { TagKeyAction } from "../lib/tagKeys";
import type { Profile, Track } from "../lib/types";

type Shown = Pick<Profile, "personal_status" | "energy" | "darkness" | "valence">;

/** The loaded track's fields; one that came without them (a set row's track) is read once from the API. */
function useShownProfile(track: Track | null): Shown {
  const [read, setRead] = useState<{ id: number; values: Shown } | null>(null);
  const needsRead = !!track && lacksProfileFields(track);
  const id = track?.id;
  useEffect(() => {
    if (!needsRead || id == null) return;
    let alive = true;
    api.getTrack(id).then(d => { if (alive) setRead({ id, values: d.profile ?? {} }); }, () => {});
    return () => { alive = false; };
  }, [needsRead, id]);
  const out: Shown = {};
  if (!track) return out;
  for (const key of SHOWN_FIELDS) {
    // A written field lands on the loaded track (lib/player.tsx); the fields not yet written come from the read.
    out[key] = (track[key] !== undefined ? track[key] : read?.id === track.id ? read.values[key] : undefined) as never;
  }
  return out;
}

/**
 * «Γρήγορη βαθμολογία» (Prefs.deckRating, off by default): a deck's status, energy and darkness (valence in therapy), set
 * with one click while the track plays. Each meter takes the value from the pointer's x over its whole 12 px row
 * (`Segmented`); an empty field shows a hollow outline. Writes go through `writeTagAction`, the pad banks' path, with
 * «6 → 8» and «Αναίρεση» in the toast, and the loaded track shows the new value without a refetch. `withStatus` adds the
 * status menu (the two-deck dock has no status badge; the single deck keeps its badge and right-click menu instead).
 * Nothing renders with the switch off or on an empty deck.
 */
export function DeckRatingStrip({ deck, mirrored = false, withStatus = true, className }: {
  deck: DeckId;
  mirrored?: boolean;
  withStatus?: boolean;
  className?: string;
}) {
  const [on] = usePref("deckRating");
  const [libraryProfile] = usePref("libraryProfile");
  const track = usePlayer().slots[deck].track;
  const shown = useShownProfile(on ? track : null);
  if (!on || !track) return null;

  const title = track.title || track.file_name;
  const write = (action: TagKeyAction | null) => { void writeRating(action, { id: track.id, title }, shown, libraryProfile); };

  const meter = (axis: Axis) => {
    const value = shown[axis];
    return (
      <Segmented key={axis} value={value} max={10} ramp={axis === "energy" ? "energy" : "darkness"}
        ariaLabel={`${axisLabel(axis, libraryProfile)}, Deck ${deck}`} title={ratingTitle(axis, value, libraryProfile)}
        onChange={v => write(ratingAction(axis, v, libraryProfile))}
        className={cn("h-3 w-full rounded-full", value == null && "px-0.5 outline outline-1 -outline-offset-1 outline-cm-line/40")} />
    );
  };

  const status = editorStatus(shown.personal_status, libraryProfile);
  const entries: MenuEntry[] = statusChoices(libraryProfile).map(choice => ({
    type: "radio",
    label: choice.label,
    checked: (status || "unknown") === choice.status,
    onSelect: () => { if ((status || "unknown") !== choice.status) write(statusAction(choice.status, libraryProfile)); },
  }));

  return (
    <div data-deck-rating={deck} role="group" aria-label={`Γρήγορη βαθμολογία, Deck ${deck}`}
      className={cn("flex h-7 min-w-0 shrink-0 items-center gap-2", mirrored && "flex-row-reverse", className)}>
      {withStatus && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label={`Κατάσταση, Deck ${deck}`} title="Κατάσταση"
              className="flex h-7 max-w-[84px] shrink-0 items-center rounded-md px-0.5 outline-none focus-visible:ring-2 focus-visible:ring-cm-cyan">
              {status && status !== "unknown"
                ? <StatusBadge status={status} className="max-w-full truncate" />
                : <span className="rounded-md border border-dashed border-cm-line/40 px-1.5 text-[10px] font-semibold leading-5 text-cm-faint">Κατάσταση</span>}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align={mirrored ? "end" : "start"}>
            <DropdownMenuEntries entries={entries} />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {ratingAxes(libraryProfile).map(meter)}
      </div>
    </div>
  );
}
