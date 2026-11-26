import { useState } from "react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { ArrowUpRight, Plus } from "../lib/icons";
import { api } from "../lib/api";
import { orderSetTargets, rememberSetTarget, SET_TARGET_FILTER_FROM } from "../lib/setTargets";
import type { DJSet, Track } from "../lib/types";

interface Props {
  track: Track;
  sets: DJSet[];
  currentSetId: number | null;
  disabled?: boolean;
  /** `useSetTrackAddition`'s addToSet, so the duplicate question applies. */
  addToSet: (setId: number, trackId: number) => Promise<boolean>;
  /** A set was created from the menu: refresh the set list. */
  onSetCreated: () => void;
  onOpenSet: (setId: number) => void;
}

/** «Προσθήκη σε άλλο set» on a Set Builder row: appends the track to another set and stays on this one. */
export default function AddToOtherSetMenu({ track, sets, currentSetId, disabled, addToSet, onSetCreated, onOpenSet }: Props) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const others = orderSetTargets(sets, currentSetId);
  const shown = orderSetTargets(sets, currentSetId, filter);
  const trackName = track.title || track.file_name;

  function openChange(next: boolean) {
    setOpen(next);
    if (!next) { setFilter(""); setNaming(false); setName(""); }
  }

  function added(target: DJSet) {
    rememberSetTarget(target.id);
    toast.success(`Προστέθηκε στο «${target.title}»`, {
      action: { label: "Άνοιγμα", onClick: () => onOpenSet(target.id) },
    });
  }

  async function addTo(target: DJSet) {
    openChange(false);
    if (await addToSet(target.id, track.id)) added(target);
  }

  async function createAndAdd(event: React.FormEvent) {
    event.preventDefault();
    const title = name.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      const created = await api.createSet(title);
      openChange(false);
      onSetCreated();
      if (await addToSet(created.id, track.id)) added(created);
    } catch {
      toast.error("Δεν ήταν δυνατή η δημιουργία του set");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={openChange}>
      <PopoverTrigger asChild>
        <button type="button" disabled={disabled}
          aria-label={`Προσθήκη σε άλλο set: ${trackName}`} title="Προσθήκη σε άλλο set"
          className="flex w-4 shrink-0 cursor-pointer justify-center text-cm-faint transition hover:text-cm-cyan disabled:cursor-default disabled:opacity-30">
          <ArrowUpRight className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-1.5" onPointerDown={event => event.stopPropagation()}>
        <div className="px-2 pb-1.5 pt-1 text-[11px] text-cm-faint">Προσθήκη σε άλλο set</div>
        {naming ? (
          <form onSubmit={createAndAdd} className="space-y-2 p-1">
            <Input autoFocus required aria-label="Όνομα νέου set" placeholder="Όνομα νέου set"
              value={name} onChange={event => setName(event.target.value)} className="h-8 text-sm" />
            <div className="flex justify-end gap-1.5">
              <Button type="button" variant="outline" size="xs" disabled={busy} onClick={() => setNaming(false)}>Πίσω</Button>
              <Button type="submit" size="xs" disabled={busy || !name.trim()}>{busy ? "Δημιουργία…" : "Δημιουργία"}</Button>
            </div>
          </form>
        ) : <>
          {others.length > SET_TARGET_FILTER_FROM && (
            <Input autoFocus aria-label="Φίλτρο sets" placeholder="φίλτρο sets…" value={filter}
              onChange={event => setFilter(event.target.value)} className="mb-1 h-8 text-sm" />
          )}
          <div className="max-h-64 overflow-y-auto">
            {shown.map(set => (
              <button key={set.id} type="button" onClick={() => void addTo(set)}
                className="flex w-full cursor-pointer items-center rounded-md px-3 py-2 text-left text-xs text-cm-muted transition menu-item focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-cyan">
                <span className="truncate">{set.title}</span>
              </button>
            ))}
            {shown.length === 0 && (
              <div className="px-3 py-2 text-xs text-cm-faint">{others.length ? "Κανένα set δεν ταιριάζει." : "Δεν υπάρχουν άλλα sets."}</div>
            )}
          </div>
          <div className="my-1 border-t border-cm-line/20" />
          <button type="button" onClick={() => setNaming(true)}
            className="flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-left text-xs text-cm-muted transition menu-item focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-cyan">
            <Plus className="h-3.5 w-3.5" />Νέο set…
          </button>
        </>}
      </PopoverContent>
    </Popover>
  );
}
