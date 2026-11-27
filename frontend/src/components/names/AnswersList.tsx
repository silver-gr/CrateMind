import { useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { answerDate, clampOffset, focusIndexAfter, nameKindLabel, nameSourceLabel, reachText, REVIEW_PAGE_SIZE, trackLine } from "../../lib/names";
import type { NameAnswer } from "../../lib/types";
import { EmptyState } from "../ui/EmptyState";
import { NamesPager } from "./NamesPager";
import { BookOpen, RotateCcw } from "../../lib/icons";

/** «Οι απαντήσεις σου»: every active answer, correction and «Εντάξει», newest first, with its date, source and
 *  «άλλαξε N κομμάτια» from the run that followed it, each with «Αναίρεση» (a /canonical edit is undone there).
 *  Undo revokes the row and keeps it; a revoked question can be answered again in its tab. */
export function AnswersList({ answers, busyId, onUndo }: {
  answers: NameAnswer[];
  busyId: number | null;
  onUndo: (id: number) => void;
}) {
  const [offset, setOffset] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusAfter = useRef<number | null>(null);
  const start = clampOffset(offset, answers.length, REVIEW_PAGE_SIZE);
  const page = answers.slice(start, start + REVIEW_PAGE_SIZE);

  useLayoutEffect(() => {
    if (focusAfter.current == null) return;
    const rows = listRef.current?.querySelectorAll<HTMLElement>("[data-answer-id]") ?? [];
    const index = focusIndexAfter(focusAfter.current, rows.length);
    focusAfter.current = null;
    (index < 0 ? headingRef.current : rows[index]?.querySelector<HTMLElement>("button, a"))?.focus();
  }, [answers]);

  return (
    <section aria-labelledby="names-answers-heading">
      <h2 id="names-answers-heading" ref={headingRef} tabIndex={-1} className="sr-only">Οι απαντήσεις σου</h2>
      <p className="mb-3 max-w-3xl text-xs leading-relaxed text-pretty text-cm-muted">
        Ό,τι απάντησες ή διόρθωσες. Η «Αναίρεση» ακυρώνει την απάντηση (η εγγραφή κρατιέται) και τα ονόματα
        ενημερώνονται ξανά· μια ερώτηση που αναιρέθηκε απαντιέται πάλι στη σελίδα της.
      </p>
      {answers.length === 0 ? (
        <EmptyState icon={BookOpen} title="Δεν έχεις δώσει ακόμη απάντηση" />
      ) : (
        <ul ref={listRef} aria-label="Οι απαντήσεις σου" className="space-y-1.5">
          {page.map((answer, i) => (
            <li key={answer.id} data-answer-id={answer.id}
              className="grid grid-cols-[1fr_auto] items-start gap-x-4 rounded-xl border border-cm-contrast/8 bg-cm-contrast/[0.02] px-3 py-2">
              <div className="min-w-0 space-y-0.5 text-xs">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="rounded-full border border-cm-contrast/10 bg-cm-contrast/5 px-2 py-0.5 text-[11px] text-cm-muted">
                    {nameKindLabel(answer.kind)}
                  </span>
                  <span className="text-sm text-pretty text-cm-text">{answer.text}</span>
                </div>
                {answer.track && trackLine(answer.track.artist, answer.track.title) !== answer.text && (
                  <div className="truncate text-cm-muted">{trackLine(answer.track.artist, answer.track.title)}</div>
                )}
                <div className="text-cm-faint">
                  {answerDate(answer.created_at)} · {nameSourceLabel(answer.source)}
                  {answer.provisional && " · προσωρινή"} · <span className="text-cm-muted">{reachText(answer.reach)}</span>
                </div>
              </div>
              {answer.undoable ? (
                <Button size="xs" variant="outline" disabled={busyId === answer.id} onClick={() => {
                  focusAfter.current = i;
                  onUndo(answer.id);
                }}>
                  <RotateCcw />
                  Αναίρεση
                </Button>
              ) : (
                <Link to="/canonical" className="text-xs text-cm-cyan underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-cyan/60">
                  Αναίρεση στη σελίδα ταυτότητας
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
      <NamesPager offset={start} limit={REVIEW_PAGE_SIZE} shown={page.length} total={answers.length}
        onOffset={next => { setOffset(next); headingRef.current?.focus(); }} label="Σελίδες απαντήσεων" />
    </section>
  );
}
