import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "../../lib/cn";
import { answeredLetter, offLine, trackLine, tracksText } from "../../lib/names";
import type { NameQuestion } from "../../lib/types";
import { Loader2, RotateCcw } from "../../lib/icons";

/** One question of the engine («Για απόφαση») or a pattern question («Ερωτήσεις προτιμήσεων»): how many tracks
 *  the answer settles, examples, the lettered options and, where allowed, «Άλλο…» for a typed value. Answering
 *  again replaces the active answer. */
export function QuestionCard({ question, busy, onAnswer, onUndo }: {
  question: NameQuestion;
  busy: boolean;
  onAnswer: (choice: { letter: string } | { text: string }) => void;
  onUndo: (decisionId: number) => void;
}) {
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState("");
  const headingId = useId();
  const chosen = answeredLetter(question);
  const more = question.track_count - question.examples.length;

  return (
    <article aria-labelledby={headingId} data-question-id={question.id}
      className="rounded-xl border border-cm-contrast/8 bg-cm-contrast/[0.02] p-4">
      <h3 id={headingId} className="text-sm leading-relaxed font-medium text-pretty text-cm-text">{question.question}</h3>
      <p className="mt-1 text-xs text-cm-muted">Αφορά {tracksText(question.track_count)}</p>

      {question.examples.length > 0 && (
        <ul aria-label="Παραδείγματα" className="mt-2 space-y-0.5">
          {question.examples.map(example => {
            const off = offLine(example);
            return (
              <li key={example.track_id} className="truncate text-xs text-cm-text">
                {trackLine(example.artist, example.title)}
                {off && <span className="text-cm-faint"> · με κλειστά τα καθαρά ονόματα: {off}</span>}
              </li>
            );
          })}
          {more > 0 && <li className="text-xs text-cm-faint">και {tracksText(more)} ακόμη</li>}
        </ul>
      )}

      {question.why && <p className="mt-2 text-xs text-pretty text-cm-muted">Γιατί προτείνεται: {question.why}</p>}

      {question.answer && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-cm-chartreuse/20 bg-cm-chartreuse/8 px-3 py-1.5 text-xs">
          <span className="text-cm-chartreuse">Η απάντησή σου: {question.answer.text}</span>
          {question.answer.undoable && (
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => onUndo(question.answer!.id)}>
              <RotateCcw />
              Αναίρεση
            </Button>
          )}
        </div>
      )}

      <div role="group" aria-label={question.answer ? "Άλλαξε την απάντηση" : "Απάντηση"} className="mt-3 flex flex-col gap-1.5">
        {question.options.map(option => (
          <Button
            key={option.letter}
            variant="outline"
            size="sm"
            disabled={busy}
            aria-pressed={chosen === option.letter}
            onClick={() => onAnswer({ letter: option.letter })}
            className={cn(
              "h-auto justify-start py-1.5 text-left whitespace-normal",
              chosen === option.letter && "border-cm-chartreuse/40 bg-cm-chartreuse/10 text-cm-chartreuse",
            )}
          >
            <span className="font-mono text-xs text-cm-faint">{option.letter}</span>
            <span className="min-w-0 flex-1 text-xs leading-relaxed">{option.text}</span>
            {question.recommended === option.letter && (
              <span className="shrink-0 rounded-full border border-cm-cyan/25 bg-cm-cyan/10 px-2 py-0.5 text-[11px] text-cm-cyan">
                Προτείνεται
              </span>
            )}
          </Button>
        ))}
        {question.allows_text && !typing && (
          <Button variant="ghost" size="sm" disabled={busy} className="self-start text-xs" onClick={() => setTyping(true)}>
            Άλλο…
          </Button>
        )}
        {question.allows_text && typing && (
          <form
            className="flex gap-1.5"
            onSubmit={event => {
              event.preventDefault();
              if (text.trim() && !busy) onAnswer({ text });
            }}
            onKeyDown={event => {
              if (event.key === "Escape") {
                event.preventDefault();
                setTyping(false);
              }
            }}
          >
            <Input autoFocus value={text} onChange={e => setText(e.target.value)} maxLength={500}
              placeholder={question.text_hint ?? "Γράψε την απάντησή σου"} aria-label="Άλλη απάντηση" className="h-8" />
            <Button type="submit" size="sm" variant="soft" disabled={!text.trim() || busy}>
              {busy && <Loader2 className="animate-spin" />}
              Απάντηση
            </Button>
          </form>
        )}
      </div>
    </article>
  );
}
