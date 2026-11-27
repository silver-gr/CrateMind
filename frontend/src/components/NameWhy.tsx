/** «Γιατί αυτό το όνομα»: why a track shows the name it shows. Mounted in the inspector's «Στοιχεία αρχείου»
 *  (ProfileEditor); loaded from `GET /api/names/tracks/{id}` when that section opens (at once anywhere else).
 *  `onChanged` tells the host that a correction, an undo or an «Εντάξει» changed the track's shown name, so it
 *  can load the track again. With «Καθαρά ονόματα» off the block shows nothing. Pure logic: lib/nameWhy.ts. */
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { apiMessage } from "../lib/facets";
import {
  correctionProblem,
  correctionStart,
  groupSteps,
  nameLine,
  noRowText,
  rawLines,
  ruleLabel,
  shownArtist,
  statusLine,
  undoLabel,
  UNREADABLE_TEXT,
  whyActions,
} from "../lib/nameWhy";
import type { NameStatus, NameWhy as NameWhyData } from "../lib/types";
import type { ChipTone } from "../lib/queryChips";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SmartChip } from "./ui/SmartChip";

const STATUS_TONE: Record<NameStatus, ChipTone> = { sure: "muted", look: "amber", open: "rose", none: "muted", hand: "cyan" };

export type Draft = { artist: string; title: string };

export interface NameWhyViewProps {
  why: NameWhyData;
  busy?: boolean;
  /** The open correction form, or null. */
  draft?: Draft | null;
  onDraft?: (draft: Draft | null) => void;
  onSave?: (draft: Draft) => void;
  onUndo?: () => void;
  onAccept?: () => void;
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-cm-faint">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** The block itself, without loading (tests render it with a hand-made payload). */
export function NameWhyView({ why, busy = false, draft = null, onDraft, onSave, onUndo, onAccept }: NameWhyViewProps) {
  if (!why.on) return null;
  const actions = whyActions(why);
  const status = statusLine(why);
  const problem = draft ? correctionProblem(why, draft.artist, draft.title) : null;
  return (
    <section aria-label="Γιατί αυτό το όνομα" className="mt-3 space-y-2 border-t border-cm-border pt-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <h4 className="text-xs font-medium text-cm-text">Γιατί αυτό το όνομα</h4>
        {status && why.status && <SmartChip tone={STATUS_TONE[why.status]}>{status}</SmartChip>}
        {why.accepted && <SmartChip tone="chartreuse">Εντάξει</SmartChip>}
      </div>
      {!why.has_row ? (
        <p>{noRowText(why)}</p>
      ) : (
        <dl className="space-y-1 wrap-anywhere">
          <Line label="Όνομα">{nameLine(shownArtist(why), why.title)}</Line>
          {why.open_question && <Line label="Ερώτηση">{why.open_question}</Line>}
          {groupSteps(why.steps).map((group, i) => (
            <div key={group.label ?? `rest-${i}`}>
              {group.label && <dt className="text-cm-faint">{group.label}</dt>}
              {group.steps.map((step, j) => (
                <dd key={`${step.rule}-${j}`}>
                  {step.text} <span className="text-[10px] text-cm-faint">{ruleLabel(step.rule)}</span>
                </dd>
              ))}
            </div>
          ))}
          {why.facts.map((fact, i) => <Line key={`${fact.label}-${i}`} label={fact.label}>{fact.value}</Line>)}
          {why.folder && <Line label="Φάκελος">{why.folder}</Line>}
        </dl>
      )}
      {why.raw.state !== null && (
        <dl className="space-y-1 wrap-anywhere">
          {rawLines(why.raw).map(line => <Line key={line.label} label={line.label}>{line.value}</Line>)}
        </dl>
      )}
      {why.raw.state === "unreadable" && <p>{UNREADABLE_TEXT}</p>}
      {why.has_row && <p>Με κλειστά τα καθαρά ονόματα: {nameLine(why.off_artist, why.off_title)}</p>}
      {why.change && (
        <p>
          Πριν την τελευταία αλλαγή: {nameLine(why.change.prev_artist, why.change.prev_title)}
          {why.change.cause_text && <> ({why.change.cause_text})</>}
        </p>
      )}
      {why.note && <p>{why.note}</p>}
      {(actions.accept || actions.correct || actions.undo) && !draft && (
        <div className="flex flex-wrap gap-1.5">
          {actions.accept && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onAccept}>Εντάξει</Button>}
          {actions.correct && (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onDraft?.(correctionStart(why))}>Διόρθωση</Button>
          )}
          {actions.undo && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onUndo}>{undoLabel(why)}</Button>}
        </div>
      )}
      {draft && (
        <form
          className="space-y-1.5"
          onSubmit={e => {
            e.preventDefault();
            if (!problem) onSave?.(draft);
          }}
        >
          <Input aria-label="Καλλιτέχνης" placeholder="Καλλιτέχνης" value={draft.artist} disabled={busy}
            onChange={e => onDraft?.({ ...draft, artist: e.target.value })} onClear={() => onDraft?.({ ...draft, artist: "" })} />
          <Input aria-label="Τίτλος" placeholder="Τίτλος" value={draft.title} disabled={busy}
            onChange={e => onDraft?.({ ...draft, title: e.target.value })} onClear={() => onDraft?.({ ...draft, title: "" })} />
          {problem && <p className="text-cm-faint">{problem}</p>}
          <div className="flex gap-1.5">
            <Button type="submit" size="sm" disabled={busy || problem !== null}>Αποθήκευση</Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => onDraft?.(null)}>Άκυρο</Button>
          </div>
        </form>
      )}
    </section>
  );
}

/** Opens with its `<details>` parent; true when there is none. */
function useOpenWithDetails(ref: RefObject<HTMLElement | null>): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const details = ref.current?.closest("details");
    if (!details) {
      setOpen(true);
      return;
    }
    const sync = () => setOpen(details.open);
    sync();
    details.addEventListener("toggle", sync);
    return () => details.removeEventListener("toggle", sync);
  }, [ref]);
  return open;
}

export function NameWhy({ trackId, onChanged }: { trackId: number; onChanged?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const open = useOpenWithDetails(ref);
  const [why, setWhy] = useState<NameWhyData | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setWhy(await api.nameWhy(trackId));
      setFailed(null);
    } catch (error) {
      setFailed(apiMessage(error));
    }
  }, [trackId]);

  useEffect(() => {
    setWhy(null);
    setDraft(null);
    setFailed(null);
  }, [trackId]);

  useEffect(() => {
    if (open && why === null && failed === null) void load();
  }, [open, why, failed, load]);

  const act = async (write: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await write();
      toast.success(done);
      setDraft(null);
      await load();
      onChanged?.();
    } catch (error) {
      toast.error(apiMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={ref}>
      {failed && <p className="mt-3 text-cm-faint">Η εξήγηση του ονόματος δεν φορτώθηκε: {failed}</p>}
      {why && (
        <NameWhyView
          why={why}
          busy={busy}
          draft={draft}
          onDraft={setDraft}
          onSave={d => void act(() => api.correctTrackName(trackId, d.artist.trim(), d.title.trim()), "Η διόρθωση αποθηκεύτηκε.")}
          onUndo={() => {
            const id = why.decision?.id;
            if (id !== undefined) void act(() => api.undoNameAnswer(id), "Αναιρέθηκε.");
          }}
          onAccept={() => void act(() => api.acceptNames({ track_ids: [trackId], dry_run: false }), "Σημειώθηκε ως εντάξει.")}
        />
      )}
    </div>
  );
}
