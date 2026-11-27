import { Layers, Plus } from "../lib/icons";
import { SEPARATOR, type MenuEntry } from "../lib/menus/entries";
import { DropdownMenu, DropdownMenuContent, DropdownMenuEntries, DropdownMenuTrigger } from "./ui/dropdown-menu";

interface Props {
  onNew: () => void;
  /** Opens «Διαχείριση sets»: every set at once. */
  onManage: () => void;
  /** The open set's menu (`setMenuEntries`): the same list as a right-click on the set. */
  entries: MenuEntry[];
}

/** The Set Builder's «…»: «Νέο set» and «Διαχείριση sets…», then the open set's menu. */
export default function SetActions({ onNew, onManage, entries }: Props) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Ενέργειες set" title="Ενέργειες set"
        className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg border surface-field text-cm-muted transition hover:bg-cm-cyan/10 hover:text-cm-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-cyan data-[state=open]:bg-cm-cyan/10 data-[state=open]:text-cm-cyan">
        <span aria-hidden="true" className="mb-1 text-xl leading-none">…</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuEntries entries={[
          { type: "item", icon: Plus, label: "Νέο set", onSelect: onNew },
          { type: "item", icon: Layers, label: "Διαχείριση sets…", onSelect: onManage },
          SEPARATOR, ...entries,
        ]} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
