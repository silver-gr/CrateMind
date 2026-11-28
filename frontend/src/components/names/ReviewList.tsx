import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import {
  acceptBody, acknowledgeBody, answerDate, bulkConfirm, clampOffset, doneText, focusIndexAfter, groupsTotal, namesErrorText, offLine,
  REVIEW_PAGE_SIZE, trackLine, type BulkAction,
} from "../../lib/names";
import type { NameReview, NameReviewRow, NameReviewSection } from "../../lib/types";
import { NameWhy } from "../NameWhy";
import { EmptyState } from "../ui/EmptyState";
import { BulkConfirmDialog } from "./BulkConfirmDialog";
import { NameCorrection } from "./NameCorrection";
import { NamesPager } from "./NamesPager";
import { CheckCircle2, Info, Loader2, Pencil, RotateCcw } from "../../lib/icons";

type ListSection = Exclude<NameReviewSection, "open">;

const HEADING: Record<ListSection, string> = {
  look: "Για ματιά",
  none: "Χωρίς καλλιτέχνη",
  changed: "Άλλαξαν",
};

const INTRO: Record<ListSection, string> = {
  look: "Ονόματα που βγήκαν από μία μόνο πηγή ή με κάποια αμφιβολία. Αν το όνομα είναι σωστό, πάτα «Εντάξει»· αλλιώς «Διόρθωση».",
  none: "Κομμάτια χωρίς καλλιτέχνη σε καμία πηγή. Γράψε τον καλλιτέχνη όπου τον ξέρεις· τα υπόλοιπα μένουν «Άγνωστος καλλιτέχνης».",
  changed: "Ονόματα που άλλαξαν σε μια ενημέρωση, με το προηγούμενο δίπλα. «Εντάξει» κρατά το νέο, «Κράτα το προηγούμενο» το παλιό.",
};

const EMPTY: Record<ListSection, string> = {
  look: "Δεν υπάρχει κομμάτι για ματιά",
  none: "Όλα τα κομμάτια έχουν καλλιτέχνη",
  changed: "Δεν άλλαξε κανένα όνομα",
};

/** One review list of /names («Για ματιά», «Χωρίς καλλιτέχνη», «Άλλαξαν»): its groups as filters, one page of
 *  rows at a time (thousands of rows stay paged on the server), an action per row and, for the filter shown,
 *  a bulk action that counts first (dry run) and asks before it writes. `reloadKey` reloads the page after a
 *  run finished; `onChanged` tells the page that counts moved. */
export function ReviewList({ section, reloadKey, onChanged }: {
  section: ListSection;
  reloadKey: number;
  onChanged: () => void;
}) {
  const [group, setGroup] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<NameReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyRow, setBusyRow] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [whyOpen, setWhyOpen] = useState<number | null>(null);
  const [bulk, setBulk] = useState<{ action: BulkAction; count: number } | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusAfterLoad = useRef<number | null>(null);

  const load = useCallback(() => {
    api.nameReview(section, { group: group ?? undefined, offset, limit: REVIEW_PAGE_SIZE }).then(page => {
      setError(null);
      // Rows left the last page (accepted, acknowledged): step back to the page that still has rows.
      if (page.items.length === 0 && page.total > 0 && offset > 0) {
        setOffset(clampOffset(offset, page.total, REVIEW_PAGE_SIZE));
        return;
      }
      setData(page);
    }, e => setError(namesErrorText(e)));
  }, [section, group, offset]);

  useEffect(load, [load, reloadKey]);

  // After a row left the list, the row now in its place takes the focus (else the heading).
  useLayoutEffect(() => {
    if (focusAfterLoad.current == null || !data) return;
    const rows = listRef.current?.querySelectorAll<HTMLElement>("[data-name-row]") ?? [];
    const index = focusIndexAfter(focusAfterLoad.current, rows.length);
    focusAfterLoad.current = null;
    const target = index < 0 ? headingRef.current : rows[index]?.querySelector<HTMLElement>("button");
    target?.focus();
  }, [data]);

  function changed(index: number) {
    focusAfterLoad.current = index;
    load();
    onChanged();
  }

  async function rowAction(row: NameReviewRow, index: number, action: BulkAction) {
    setBusyRow(row.track_id);
    try {
      if (action === "accept") await api.acceptNames({ track_ids: [row.track_id] });
      else await api.acknowledgeNames({ track_ids: [row.track_id], action });
      toast.success(doneText(action, 1));
      changed(index);
    } catch (e) {
      toast.error(namesErrorText(e));
    } finally {
      setBusyRow(null);
    }
  }

  async function correct(row: NameReviewRow, index: number, artist: string, title: string) {
    setBusyRow(row.track_id);
    try {
      await api.correctTrackName(row.track_id, artist, title);
      toast.success("Η διόρθωση γράφτηκε");
      setEditing(null);
      changed(index);
    } catch (e) {
      toast.error(namesErrorText(e));
    } finally {
      setBusyRow(null);
    }
  }

  async function startBulk(action: BulkAction) {
    setBulkBusy(true);
    try {
      const counted = action === "accept"
        ? await api.acceptNames(acceptBody(group, true))
        : await api.acknowledgeNames(acknowledgeBody(action, group, true));
      if (counted.count === 0) toast.info("Δεν υπάρχει κομμάτι για αυτή την ενέργεια");
      else setBulk({ action, count: counted.count });
    } catch (e) {
      toast.error(namesErrorText(e));
    } finally {
      setBulkBusy(false);
    }
  }

  async function confirmBulk() {
    if (!bulk) return;
    setBulkBusy(true);
    try {
      const done = bulk.action === "accept"
        ? await api.acceptNames(acceptBody(group, false))
        : await api.acknowledgeNames(acknowledgeBody(bulk.action, group, false));
      toast.success(doneText(bulk.action, done.count));
      setBulk(null);
      focusAfterLoad.current = 0;
      load();
      onChanged();
    } catch (e) {
      toast.error(namesErrorText(e));
    } finally {
      setBulkBusy(false);
    }
  }

  function pickGroup(key: string | null) {
    setGroup(key);
    setOffset(0);
  }

  function turnPage(next: number) {
    setOffset(next);
    headingRef.current?.focus();
  }

  const groups = data?.groups ?? [];
  const groupLabel = group ? groups.find(g => g.key === group)?.label ?? null : null;
  const items = data?.items ?? [];

  return (
    <section aria-labelledby={`names-${section}-heading`}>
      <BulkConfirmDialog
        confirm={bulk ? bulkConfirm(bulk.action, bulk.count, groupLabel) : null}
        busy={bulkBusy}
        onCancel={() => setBulk(null)}
        onConfirm={() => void confirmBulk()}
      />
      <h2 id={`names-${section}-heading`} ref={headingRef} tabIndex={-1} className="sr-only">{HEADING[section]}</h2>
      <p className="mb-3 max-w-3xl text-xs leading-relaxed text-pretty text-cm-muted">{INTRO[section]}</p>

      {error && <p role="alert" className="mb-3 text-xs text-cm-rose">{error}</p>}

      {groups.length > 0 && (
        <div role="group" aria-label="Ομάδες" className="mb-3 flex flex-wrap gap-1.5">
          <GroupChip active={group === null} label="Όλα" count={groupsTotal(groups, data?.total ?? 0)} onClick={() => pickGroup(null)} />
          {groups.map(g => (
            <GroupChip key={g.key} active={group === g.key} label={g.label} count={g.count} onClick={() => pickGroup(g.key)} />
          ))}
        </div>
      )}

      {data && data.total > 0 && section !== "none" && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {section === "look" ? (
            <Button size="sm" variant="soft" disabled={bulkBusy} onClick={() => void startBulk("accept")}>
              {bulkBusy ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
              {groupLabel ? "Εντάξει σε όλη την ομάδα…" : "Εντάξει σε όλα…"}
            </Button>
          ) : (
            <>
              <Button size="sm" variant="soft" disabled={bulkBusy} onClick={() => void startBulk("ok")}>
                {bulkBusy ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
                {groupLabel ? "Εντάξει σε όλη την ομάδα…" : "Εντάξει σε όλα…"}
              </Button>
              <Button size="sm" variant="outline" disabled={bulkBusy} onClick={() => void startBulk("keep_previous")}>
                <RotateCcw />
                Κράτα τα προηγούμενα…
              </Button>
            </>
          )}
          <span className="text-xs text-cm-muted">για {groupLabel ? `την ομάδα «${groupLabel}»` : "όλη τη λίστα"}, όχι μόνο τη σελίδα</span>
        </div>
      )}

      {!data && !error && <p className="text-xs text-cm-muted"><Loader2 className="mr-1.5 inline size-3.5 animate-spin" />Φόρτωση…</p>}
      {data && data.total === 0 && <EmptyState icon={CheckCircle2} title={EMPTY[section]} />}

      {items.length > 0 && (
        <ul ref={listRef} aria-label={HEADING[section]} className="space-y-1.5">
          {items.map((row, index) => (
            <li key={row.track_id} data-name-row={row.track_id}
              className="rounded-xl border border-cm-contrast/8 bg-cm-contrast/[0.02] px-3 py-2">
              <ReviewRowBody row={row} section={section} />
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {section === "look" && !row.accepted && (
                  <Button size="xs" variant="soft" disabled={busyRow === row.track_id} onClick={() => void rowAction(row, index, "accept")}>
                    <CheckCircle2 />
                    Εντάξει
                  </Button>
                )}
                {section === "changed" && (
                  <>
                    <Button size="xs" variant="soft" disabled={busyRow === row.track_id} onClick={() => void rowAction(row, index, "ok")}>
                      <CheckCircle2 />
                      Εντάξει
                    </Button>
                    <Button size="xs" variant="outline" disabled={busyRow === row.track_id} onClick={() => void rowAction(row, index, "keep_previous")}>
                      <RotateCcw />
                      Κράτα το προηγούμενο
                    </Button>
                  </>
                )}
                {section !== "changed" && (
                  <Button size="xs" variant="outline" data-correct-for={row.track_id} disabled={busyRow === row.track_id}
                    aria-expanded={editing === row.track_id}
                    onClick={() => setEditing(editing === row.track_id ? null : row.track_id)}>
                    <Pencil />
                    {section === "none" ? "Γράψε καλλιτέχνη" : "Διόρθωση"}
                  </Button>
                )}
                <Button size="xs" variant="ghost" aria-expanded={whyOpen === row.track_id}
                  onClick={() => setWhyOpen(whyOpen === row.track_id ? null : row.track_id)}>
                  <Info />
                  Γιατί;
                </Button>
              </div>
              {editing === row.track_id && (
                <NameCorrection
                  artist={row.artist}
                  title={row.title}
                  busy={busyRow === row.track_id}
                  onSave={(artist, title) => void correct(row, index, artist, title)}
                  onCancel={() => {
                    setEditing(null);
                    listRef.current?.querySelector<HTMLElement>(`[data-correct-for="${row.track_id}"]`)?.focus();
                  }}
                />
              )}
              {whyOpen === row.track_id && (
                <div className="mt-2 border-t border-cm-contrast/8 pt-2">
                  <NameWhy trackId={row.track_id} onChanged={() => changed(index)} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {data && (
        <NamesPager offset={data.offset} limit={REVIEW_PAGE_SIZE} shown={items.length} total={data.total}
          onOffset={turnPage} label={`Σελίδες: ${HEADING[section]}`} />
      )}
    </section>
  );
}

function GroupChip({ active, label, count, onClick }: { active: boolean; label: string; count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-cyan/60",
        active ? "border-cm-cyan/35 bg-cm-cyan/12 text-cm-cyan" : "border-cm-contrast/10 bg-cm-contrast/[0.03] text-cm-muted hover:text-cm-text",
      )}
    >
      {label}
      <span className="font-mono tabular-nums text-cm-faint">{count.toLocaleString("el-GR")}</span>
    </button>
  );
}

export function ReviewRowBody({ row, section }: { row: NameReviewRow; section: ListSection }) {
  const off = offLine(row);
  if (section === "changed") {
    const before = trackLine(row.prev_artist ?? row.artist, row.prev_title ?? row.title);
    const folderMoved = row.prev_folder != null && row.prev_folder !== row.folder;
    return (
      <div className="min-w-0 space-y-0.5 text-xs">
        <div className="truncate text-sm text-cm-text">{trackLine(row.artist, row.title)}</div>
        <div className="truncate text-cm-muted">Πριν: {before}</div>
        {folderMoved && <div className="truncate text-cm-faint">Προτεινόμενος φάκελος: {row.prev_folder} → {row.folder}</div>}
        <div className="text-cm-faint">
          {row.cause_text}
          {row.changed_at && <> · {answerDate(row.changed_at)}</>}
        </div>
      </div>
    );
  }
  return (
    <div className="min-w-0 space-y-0.5 text-xs">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="truncate text-sm text-cm-text">{trackLine(row.artist, row.title)}</span>
        {row.accepted && (
          <span className="rounded-full border border-cm-chartreuse/25 bg-cm-chartreuse/10 px-2 py-0.5 text-[11px] text-cm-chartreuse">Εντάξει</span>
        )}
      </div>
      {off && <div className="truncate text-cm-faint">Με κλειστά τα καθαρά ονόματα: {off}</div>}
      {row.folder && <div className="truncate text-cm-faint">Προτεινόμενος φάκελος: {row.folder}</div>}
      {row.reason && <div className="text-pretty text-cm-muted">{row.reason}</div>}
    </div>
  );
}
