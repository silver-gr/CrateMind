import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../lib/api";
import {
  answerInput, clampOffset, defaultTab, isNamesTab, NAMES_SETTINGS_HREF, NAMES_TABS, namesErrorText, noticeLines,
  QUESTIONS_PAGE_SIZE, questionsInOrder, runBusy, tabCounts, type NamesTab,
} from "../lib/names";
import type { NameAnswer, NameQuestion, NameQuestions, NamesStatus } from "../lib/types";
import { PageHeader } from "../components/ui/PageHeader";
import { EmptyState } from "../components/ui/EmptyState";
import { GlassPanel } from "../components/ui/GlassPanel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { QuestionCard } from "../components/names/QuestionCard";
import { ReviewList } from "../components/names/ReviewList";
import { AnswersList } from "../components/names/AnswersList";
import { NamesPager } from "../components/names/NamesPager";
import { Info, Loader2, Pencil, TriangleAlert } from "../lib/icons";

const POLL_MS = 1500;

/** «Καθαρισμός ονομάτων» (`/names`): the engine's questions, the pattern questions, «Για ματιά», «Χωρίς
 *  καλλιτέχνη», «Άλλαξαν» and «Οι απαντήσεις σου». Every answer is written to the catalog only (never to a
 *  file) and asks for a names run; while that run is queued or running the page polls the status and reloads
 *  when it is done, so «άλλαξε N κομμάτια» and the lists follow. The tab lives in `?section=`. */
export default function Names() {
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState<NamesStatus | null>(null);
  const [questions, setQuestions] = useState<NameQuestions | null>(null);
  const [answers, setAnswers] = useState<NameAnswer[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [busyQuestion, setBusyQuestion] = useState<string | null>(null);
  const [busyUndo, setBusyUndo] = useState<number | null>(null);
  const wasBusy = useRef(false);

  const loadStatus = useCallback(() => api.namesStatus().then(setStatus, e => setLoadError(namesErrorText(e))), []);
  const loadQuestions = useCallback(() => api.nameQuestions().then(setQuestions, e => setLoadError(namesErrorText(e))), []);
  const loadAnswers = useCallback(() => api.nameAnswers().then(r => setAnswers(r.items), e => setLoadError(namesErrorText(e))), []);
  const refresh = useCallback(() => {
    void loadStatus();
    void loadQuestions();
    void loadAnswers();
  }, [loadStatus, loadQuestions, loadAnswers]);

  useEffect(refresh, [refresh]);

  // While a names run is queued or running, poll; when it ends, reload every list (reach, questions, rows).
  const busy = runBusy(status?.run);
  useEffect(() => {
    if (busy) {
      wasBusy.current = true;
      const timer = setTimeout(() => void loadStatus(), POLL_MS);
      return () => clearTimeout(timer);
    }
    if (wasBusy.current) {
      wasBusy.current = false;
      void loadQuestions();
      void loadAnswers();
      setReloadKey(k => k + 1);
    }
  }, [busy, status, loadStatus, loadQuestions, loadAnswers]);

  const counts = tabCounts(status, questions, answers);
  const asked = params.get("section");
  const loaded = status !== null && questions !== null;
  const tab: NamesTab = isNamesTab(asked) ? asked : defaultTab(counts);
  // Once loaded, the default tab is written into the address, so answering the last question (which changes
  // the default) never moves the page away from that answer and its «Αναίρεση».
  useEffect(() => {
    if (loaded && answers !== null && !isNamesTab(asked)) {
      setParams(previous => {
        const out = new URLSearchParams(previous);
        out.set("section", tab);
        return out;
      }, { replace: true });
    }
  }, [loaded, answers, asked, tab, setParams]);

  function selectTab(next: string) {
    setParams(previous => {
      const out = new URLSearchParams(previous);
      out.set("section", next);
      return out;
    }, { replace: true });
  }

  async function answer(question: NameQuestion, choice: { letter: string } | { text: string }) {
    const body = answerInput(question, choice);
    if (!body) return;
    setBusyQuestion(question.id);
    try {
      await api.answerNameQuestion(body);
      toast.success(status?.on ? "Η απάντηση γράφτηκε· τα ονόματα ενημερώνονται" : "Η απάντηση γράφτηκε");
      refresh();
    } catch (e) {
      toast.error(namesErrorText(e));
    } finally {
      setBusyQuestion(null);
    }
  }

  async function undo(id: number) {
    setBusyUndo(id);
    try {
      await api.undoNameAnswer(id);
      toast.success("Η απάντηση αναιρέθηκε");
      refresh();
    } catch (e) {
      toast.error(namesErrorText(e));
    } finally {
      setBusyUndo(null);
    }
  }

  const onListChanged = useCallback(() => {
    void loadStatus();
    void loadAnswers();
  }, [loadStatus, loadAnswers]);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={Pencil}
        title="Καθαρισμός ονομάτων"
        subtitle="Οι ερωτήσεις και οι λίστες των καθαρών ονομάτων. Οι απαντήσεις σου γράφονται μόνο στη βιβλιοθήκη του CrateMind· τα αρχεία μουσικής δεν αλλάζουν."
        actions={busy ? (
          <span role="status" className="inline-flex items-center gap-1.5 text-xs text-cm-amber">
            <Loader2 className="size-3.5 animate-spin" />
            {status?.run.state === "running" ? "Τα ονόματα ενημερώνονται…" : "Η ενημέρωση ονομάτων περιμένει…"}
          </span>
        ) : undefined}
      />
      <div className="min-h-0 flex-1 overflow-auto p-5 scroll-fade-y">
        <div className="mx-auto max-w-4xl">
          <Notices status={status} />
          {loadError && <p role="alert" className="mb-3 text-xs text-cm-rose">{loadError}</p>}
          {!loaded && !loadError ? (
            <p className="text-xs text-cm-muted"><Loader2 className="mr-1.5 inline size-3.5 animate-spin" />Φόρτωση…</p>
          ) : (
            <GlassPanel className="p-4">
            <Tabs value={tab} onValueChange={selectTab}>
              <TabsList aria-label="Ενότητες" className="h-auto w-full flex-wrap justify-start">
                {NAMES_TABS.map(item => (
                  <TabsTrigger key={item.id} value={item.id} className="flex-none">
                    {item.label}
                    {counts[item.id] != null && (
                      <span className="font-mono text-xs tabular-nums text-cm-faint">{counts[item.id]!.toLocaleString("el-GR")}</span>
                    )}
                  </TabsTrigger>
                ))}
              </TabsList>
              <TabsContent value="questions" className="pt-3">
                <QuestionsSection
                  list={questions?.open ?? []}
                  hasRun={questions?.has_run ?? false}
                  intro="Όπου οι πηγές διαφωνούν, το CrateMind δεν μαντεύει: ρωτά. Μία απάντηση ισχύει για όλα τα κομμάτια της ερώτησης, και για όσα έρθουν αργότερα."
                  empty="Δεν υπάρχει ερώτηση για απόφαση"
                  busyQuestion={busyQuestion}
                  busyUndo={busyUndo}
                  onAnswer={answer}
                  onUndo={undo}
                />
              </TabsContent>
              <TabsContent value="patterns" className="pt-3">
                <QuestionsSection
                  list={questions?.patterns ?? []}
                  hasRun={questions?.has_run ?? false}
                  intro="Ερωτήσεις για ένα μοτίβο που εμφανίζεται σε πολλά κομμάτια. Η απάντηση ισχύει για κάθε κομμάτι με το ίδιο μοτίβο· την αλλάζεις όποτε θες."
                  empty="Δεν υπάρχει ερώτηση προτίμησης"
                  busyQuestion={busyQuestion}
                  busyUndo={busyUndo}
                  onAnswer={answer}
                  onUndo={undo}
                />
              </TabsContent>
              {(["look", "none", "changed"] as const).map(id => (
                <TabsContent key={id} value={id} className="pt-3">
                  {tab === id && <ReviewList section={id} reloadKey={reloadKey} onChanged={onListChanged} />}
                </TabsContent>
              ))}
              <TabsContent value="answers" className="pt-3">
                <AnswersList answers={answers ?? []} busyId={busyUndo} onUndo={id => void undo(id)} />
              </TabsContent>
            </Tabs>
            </GlassPanel>
          )}
        </div>
      </div>
    </div>
  );
}

const SETTINGS_WORD = "Ρυθμίσεις";

/** The switch off, a refused run or unread tracks: said once, above the tabs, with the way to Settings. */
function Notices({ status }: { status: NamesStatus | null }) {
  const lines = noticeLines(status);
  if (lines.length === 0) return null;
  return (
    <div className="mb-4 space-y-1.5">
      {lines.map(line => (
        <p key={line.text} role={line.tone === "warn" ? "alert" : undefined}
          className={line.tone === "warn"
            ? "flex items-start gap-2 rounded-lg border border-cm-amber/25 bg-cm-amber/8 px-3 py-2 text-xs text-cm-amber"
            : "flex items-start gap-2 rounded-lg border border-cm-contrast/10 bg-cm-contrast/[0.03] px-3 py-2 text-xs text-cm-muted"}>
          {line.tone === "warn" ? <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> : <Info className="mt-0.5 size-3.5 shrink-0" />}
          <span>
            {/* A sentence that already names «Ρυθμίσεις» links that word instead of repeating it. */}
            {line.text.endsWith(SETTINGS_WORD + ".") ? (
              <>
                {line.text.slice(0, -(SETTINGS_WORD.length + 1))}
                <Link to={NAMES_SETTINGS_HREF} className="text-cm-cyan underline-offset-4 hover:underline">{SETTINGS_WORD}</Link>.
              </>
            ) : (
              <>
                {line.text}{" "}
                <Link to={NAMES_SETTINGS_HREF} className="text-cm-cyan underline-offset-4 hover:underline">{SETTINGS_WORD}</Link>
              </>
            )}
          </span>
        </p>
      ))}
    </div>
  );
}

function QuestionsSection({ list, hasRun, intro, empty, busyQuestion, busyUndo, onAnswer, onUndo }: {
  list: NameQuestion[];
  hasRun: boolean;
  intro: string;
  empty: string;
  busyQuestion: string | null;
  busyUndo: number | null;
  onAnswer: (question: NameQuestion, choice: { letter: string } | { text: string }) => void;
  onUndo: (id: number) => void;
}) {
  const [offset, setOffset] = useState(0);
  const ordered = questionsInOrder(list);
  const start = clampOffset(offset, ordered.length, QUESTIONS_PAGE_SIZE);
  const page = ordered.slice(start, start + QUESTIONS_PAGE_SIZE);

  if (!hasRun) {
    return (
      <EmptyState icon={Info} title="Δεν έχει γίνει ακόμη ενημέρωση ονομάτων">
        Οι ερωτήσεις βγαίνουν από την ενημέρωση ονομάτων. Τρέξε την από τις{" "}
        <Link to={NAMES_SETTINGS_HREF} className="text-cm-cyan underline-offset-4 hover:underline">Ρυθμίσεις</Link>.
      </EmptyState>
    );
  }
  return (
    <div>
      <p className="mb-3 max-w-3xl text-xs leading-relaxed text-pretty text-cm-muted">{intro}</p>
      {ordered.length === 0 ? (
        <EmptyState icon={Info} title={empty} />
      ) : (
        <div className="space-y-3">
          {page.map(question => (
            <QuestionCard
              key={question.id}
              question={question}
              busy={busyQuestion === question.id || (question.answer != null && busyUndo === question.answer.id)}
              onAnswer={choice => onAnswer(question, choice)}
              onUndo={onUndo}
            />
          ))}
        </div>
      )}
      <NamesPager offset={start} limit={QUESTIONS_PAGE_SIZE} shown={page.length} total={ordered.length}
        onOffset={setOffset} label="Σελίδες ερωτήσεων" />
    </div>
  );
}
