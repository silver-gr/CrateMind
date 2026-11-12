import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { Choice, identityRequest, availabilityLabels } from "../components/CompletenessControls";
import { LINK, PAGE, PAGE_SHELL, PANEL, PANEL_BAR, PageHeader, Pager, Pill, fmt, fmtDate, serviceLabel } from "../components/collections/kit";
import { GitBranch } from "../lib/icons";
import { cn } from "../lib/cn";
import type { ChipTone } from "../lib/queryChips";
export const relations: Record<string, string> = {
  exact_copy_of: "Ίδιο διατεταγμένο αντίγραφο",
  migrated_from: "Τεκμηριωμένη μεταφορά",
  likely_migrated_from: "Πιθανή μεταφορά",
  merged_from: "Συνένωση πηγών",
  descendant_of: "Παράγωγο / επέκταση",
  possible_version_of: "Πιθανή κοινή προέλευση",
  unrelated: "Σύγκρουση ονόματος / άσχετες",
};
type Collection = { id: string; name: string; service: string };
type Relationship = {
  id: string;
  relation: string;
  status: string;
  confidence: number;
  decision_mode: string;
  evidence: Record<string, unknown>;
  source: Collection;
  destination: Collection;
};
type Position = { position: number; recording_id: string; title: string; artist: string; added_at: string | null };
type Detail = Relationship & {
  correspondence: { classification: string; source: Position[]; destination: Position[] }[];
  comparison: { shared_positions: number; missing_positions: number; destination_only_positions: number; exact_ordered: boolean };
  correspondence_counts: Record<string, number>;
};
const PAGE_SIZE = 50;
const statusText: Record<string, [string, ChipTone]> = {
  accepted: ["Αποδεκτή", "chartreuse"],
  rejected: ["Απορριφθείσα", "rose"],
};
function RelationStatus({ status }: { status: string }) {
  const [text, tone] = statusText[status] ?? ["Πρόταση", "amber"];
  return <Pill tone={tone}>{text}</Pill>;
}
const labels: Record<string, string> = {
  destination_only_later_addition: "Μεταγενέστερη προσθήκη στον προορισμό (χρονολογημένες θέσεις)",
  correct_transfer: "Ίδια ηχογράφηση στην αποδεκτή μεταφορά",
  shared_recording: "Κοινή κανονική ηχογράφηση",
  missing_destination: "Χωρίς αντίστοιχη θέση προορισμού",
  destination_only_addition: "Μόνο στον προορισμό — χρόνος προσθήκης μη τεκμηριωμένος",
  likely_wrong_substitution: "Πιθανή λανθασμένη αντικατάσταση",
  ambiguous: "Αμφίβολη αντιστοιχία θέσεων",
  reordered_or_repeated: "Αλλαγή σειράς / επανάληψη",
};
export function CollectionLineagePanel({
  id,
  embedded = false,
  onCount,
}: {
  id: string;
  embedded?: boolean;
  onCount?: (count: number) => void;
}) {
  const [data, setData] = useState<{ items: Relationship[]; total: number } | null>(null);
  useEffect(() => {
    let active = true;
    setData(null);
    identityRequest<{ items: Relationship[]; total: number }>(`lineage?collection=${encodeURIComponent(id)}`)
      .then((v) => {
        if (active) {
          setData(v);
          onCount?.(v.total);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [id, onCount]);
  const Container = embedded ? "div" : "details";
  return (
    <Container className={embedded ? "space-y-1" : "rounded-xl border border-cm-border p-3"}>
      {!embedded && <summary>Προέλευση συλλογής ({data?.total ?? "…"})</summary>}
      <p className="mb-2 text-xs text-cm-muted">Αμετάβλητες πηγές· αποδεκτές σχέσεις και προτάσεις εμφανίζονται χωριστά.</p>
      <ul className="divide-y divide-cm-border">
        {data?.items.slice(0, 6).map((r) => (
          <li key={r.id}>
            <a href={`/provenance?id=${r.id}`} className="flex items-center gap-2 py-1.5 text-xs transition-colors hover:text-cm-cyan">
              <span className="min-w-0 flex-1">
                {r.source.name} <span className="text-cm-faint">{r.relation === "exact_copy_of" ? "≡" : "→"}</span> {r.destination.name}
                <span className="text-cm-muted"> · {relations[r.relation]}</span>
              </span>
              <RelationStatus status={r.status} />
            </a>
          </li>
        ))}
      </ul>
      <a href={`/provenance?collection=${encodeURIComponent(id)}`} className={cn("inline-block pt-1 text-xs", LINK)}>
        Όλες οι σχέσεις και στοιχεία
      </a>
    </Container>
  );
}
export default function CollectionProvenance() {
  const [params, setParams] = useSearchParams(),
    [q, setQ] = useState(""),
    [category, setCategory] = useState(""),
    [offset, setOffset] = useState(0),
    [rev, setRev] = useState(0);
  const selected = params.get("id"),
    collection = params.get("collection") || "",
    recording = params.get("recording") || "";
  const [data, setData] = useState<{ items: Relationship[]; total: number; summary: Record<string, unknown> } | null>(null),
    [detail, setDetail] = useState<Detail | null>(null),
    [history, setHistory] = useState<{
      raw_collection_occurrences: number;
      source_collection_count: number;
      collection_family_count: number;
      observations: (Collection & { position: number; kind: string; added_at: string | null })[];
      accepted_relationships: { id: string; relation: string; source_id: string; destination_id: string }[];
      availability: { state: string };
    } | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [kind, setKind] = useState(""),
    [showShared, setShowShared] = useState(false);
  useEffect(() => {
    let active = true;
    identityRequest<typeof data>(`lineage?${new URLSearchParams({ q, category, collection, offset: String(offset) })}`)
      .then((v) => {
        if (active) setData(v);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [q, category, collection, offset, rev]);
  useEffect(() => {
    let active = true;
    setDetail(null);
    if (selected)
      identityRequest<Detail>(`lineage/detail?id=${selected}`)
        .then((v) => {
          if (active) {
            setDetail(v);
            setKind(v.relation);
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [selected, rev]);
  useEffect(() => {
    let active = true;
    setHistory(null);
    if (recording)
      identityRequest<typeof history>(`lineage/history?recording_id=${encodeURIComponent(recording)}`)
        .then((v) => {
          if (active) setHistory(v);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [recording, rev]);
  async function decide(action: string) {
    if (!detail) return;
    setBusy(true);
    try {
      await identityRequest("lineage/decision", { id: detail.id, action, relation: kind });
      setRev((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const pos = (rows: Position[]) =>
    rows.length ? (
      rows.map((p) => (
        <div key={p.position} className="flex gap-2">
          <span className="w-7 shrink-0 text-right font-mono text-[11px] tabular-nums text-cm-faint">{p.position + 1}</span>
          <div className="min-w-0">
            <a href={`/canonical?id=${encodeURIComponent(p.recording_id)}`} className="transition-colors hover:text-cm-cyan">
              {p.artist} — {p.title}
            </a>
            <p className="text-xs text-cm-faint">{p.added_at ? fmtDate(p.added_at) : "Ημερομηνία μη διαθέσιμη"}</p>
          </div>
        </div>
      ))
    ) : (
      <span className="text-cm-faint">—</span>
    );
  return (
    <div className={PAGE_SHELL}>
      <PageHeader icon={GitBranch} title="Προέλευση συλλογών">
        Οι μεταφορές εξηγούν παρατηρήσεις· δεν αλλάζουν ταυτότητες ή πηγές. Οι ημερομηνίες δεν αποδεικνύουν από μόνες τους προέλευση.
      </PageHeader>
      <div className={PAGE}>
        {error && (
          <p role="alert" className="rounded-xl border border-cm-rose/30 bg-cm-rose/10 p-3 text-sm text-cm-rose">
            {error}
          </p>
        )}
        {history && (
          <section className={cn(PANEL, "space-y-2 p-4")}>
            <h2 className="text-sm font-medium">Ιστορικό γνωστών παρατηρήσεων</h2>
            <p className="text-sm">
              {availabilityLabels[history.availability.state]} ·{" "}
              <span className="tabular-nums">
                {fmt(history.raw_collection_occurrences)} θέσεις / {fmt(history.source_collection_count)} πηγές /{" "}
                {fmt(history.collection_family_count)} οικογένειες
              </span>
            </p>
            <p className="text-xs text-cm-muted">
              Χωρίς επινοημένη χρονολογική σειρά. Οι ημερομηνίες αφορούν συμμετοχή στην πηγή, όχι απόκτηση αρχείου.
            </p>
            <ul className="divide-y divide-cm-border">
              {history.observations.map((o) => (
                <li key={`${o.id}:${o.position}`} className="flex flex-wrap items-baseline gap-x-2 py-1.5 text-sm">
                  <a className="transition-colors hover:text-cm-cyan" href={`/collections?id=${encodeURIComponent(o.id)}`}>
                    {o.kind === "likes" ? "♥ " : ""}
                    {serviceLabel(o.service)} · {o.name}
                  </a>
                  <span className="text-xs text-cm-muted">
                    θέση {o.position + 1} · {o.added_at ? fmtDate(o.added_at) : "άγνωστη ημερομηνία"}
                  </span>
                </li>
              ))}
            </ul>
            {history.accepted_relationships.map((r) => (
              <a className={cn("block text-xs", LINK)} key={r.id} href={`/provenance?id=${r.id}`}>
                {history.observations.find((o) => o.id === r.source_id)?.name} {r.relation === "exact_copy_of" ? "≡" : "→"}{" "}
                {history.observations.find((o) => o.id === r.destination_id)?.name} · {relations[r.relation]}
              </a>
            ))}
          </section>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Input
            aria-label="Αναζήτηση ονόματος"
            placeholder="Αναζήτηση ονόματος…"
            wrapperClassName="min-w-60 flex-1"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOffset(0);
            }}
          />
          <Choice
            label="Είδος προέλευσης"
            value={category}
            onChange={(v) => {
              setCategory(v);
              setOffset(0);
            }}
            options={{ "": "Όλες οι σχέσεις", ...relations, imperfect: "Ατελείς μεταφορές", unresolved: "Ανεπίλυτες προτάσεις" }}
          />
        </div>
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(300px,2fr)_minmax(0,3fr)]">
          <section className={cn(PANEL, "min-w-0 overflow-hidden")}>
            <div className={PANEL_BAR}>
              <span>
                <span className="font-medium tabular-nums text-cm-text">{fmt(data?.total)}</span> σχέσεις
              </span>
              <Pager offset={offset} limit={PAGE_SIZE} total={data?.total || 0} onChange={setOffset} />
            </div>
            <ul className="divide-y divide-cm-border">
              {data?.items.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    aria-current={selected === r.id || undefined}
                    className={cn(
                      "w-full border-l-2 border-transparent px-4 py-2.5 text-left transition-colors hover:bg-cm-line/5",
                      selected === r.id && "border-cm-cyan bg-cm-cyan/10",
                    )}
                    onClick={() => setParams({ id: r.id, ...(collection ? { collection } : {}) })}
                  >
                    <span className="block text-sm break-words">
                      {r.source.name} <span className="text-cm-faint">{r.relation === "exact_copy_of" ? "≡" : "→"}</span> {r.destination.name}
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-cm-muted">
                      <RelationStatus status={r.status} />
                      {relations[r.relation]} · {serviceLabel(r.source.service)}
                      {r.destination.service !== r.source.service && ` → ${serviceLabel(r.destination.service)}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="border-t border-cm-border px-4 py-2 text-[11px] text-cm-faint">
              Μόνο αποδεκτές σχέσεις επηρεάζουν τον αριθμό οικογενειών.
            </p>
          </section>
          <section className={cn(PANEL, "min-w-0 space-y-4 p-4")}>
            {detail ? (
              <>
                <div className="space-y-1">
                  <h2 className="text-lg font-semibold leading-snug break-words">
                    {detail.source.name} <span className="text-cm-faint">{detail.relation === "exact_copy_of" ? "≡" : "→"}</span>{" "}
                    {detail.destination.name}
                  </h2>
                  <p className="flex flex-wrap items-center gap-2 text-xs text-cm-muted">
                    <RelationStatus status={detail.status} />
                    {detail.decision_mode === "human" ? "Ανθρώπινη απόφαση" : "Παράγωγη ανάλυση"} · βαθμός στοιχείων{" "}
                    <span className="font-mono tabular-nums">{detail.confidence.toFixed(2)}</span> (όχι πιθανότητα)
                  </p>
                </div>
                <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-cm-muted">
                  <span>
                    <span className="font-semibold tabular-nums text-cm-text">{fmt(detail.comparison.shared_positions)}</span> κοινές θέσεις
                  </span>
                  <span>
                    <span className="font-semibold tabular-nums text-cm-text">{fmt(detail.comparison.missing_positions)}</span> χωρίς
                    προορισμό
                  </span>
                  <span>
                    <span className="font-semibold tabular-nums text-cm-text">{fmt(detail.comparison.destination_only_positions)}</span> μόνο
                    στον προορισμό
                  </span>
                </p>
                <fieldset disabled={busy} className="flex flex-wrap items-center gap-2">
                  <Choice label="Σχέση προς αποδοχή" value={kind} onChange={setKind} options={relations} />
                  <Button size="sm" onClick={() => decide("accept")}>
                    Αποδοχή σχέσης
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => decide("reject")}>
                    Απόρριψη
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => decide("reset")}>
                    Επαναφορά σε πρόταση
                  </Button>
                </fieldset>
                <p className="text-xs text-cm-muted">
                  Η αποδοχή αλλάζει μόνο την ερμηνεία προέλευσης και την ομαδοποίηση μετρήσεων. Καμία συγχώνευση ηχογραφήσεων.
                </p>
                <details className="text-xs text-cm-muted">
                  <summary>Στοιχεία και χρονικές ομάδες</summary>
                  <pre className="mt-2 overflow-x-auto rounded-lg bg-cm-line/5 p-3 font-mono text-[11px] whitespace-pre-wrap">
                    {JSON.stringify(detail.evidence, null, 2)}
                  </pre>
                </details>
                <div className="space-y-2 border-t border-cm-border pt-4">
                  <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-cm-muted">
                    <Switch size="sm" checked={showShared} onCheckedChange={setShowShared} />
                    Εμφάνιση και κοινών θέσεων
                  </label>
                  <p className="text-xs text-cm-faint">
                    Αντιστοιχία θέσεων, όχι πρόταση ταυτότητας. Πιθανή λανθασμένη αντικατάσταση μόνο σε αποδεκτή σχέση και ανάμεσα σε κοινές
                    γειτονικές ηχογραφήσεις.
                  </p>
                </div>
                {detail.correspondence
                  .filter((r) => showShared || !["correct_transfer", "shared_recording"].includes(r.classification))
                  .map((r, i) => (
                    <div key={i} className="rounded-xl border border-cm-border p-3">
                      <p className="mb-2 text-xs font-medium text-cm-amber">{labels[r.classification] ?? "Αντιστοιχία θέσεων"}</p>
                      <div className="grid gap-3 text-sm md:grid-cols-2">
                        <div className="space-y-1">{pos(r.source)}</div>
                        <div className="space-y-1">{pos(r.destination)}</div>
                      </div>
                    </div>
                  ))}
              </>
            ) : (
              <p className="text-sm text-cm-muted">Επιλέξτε σχέση για τεκμήρια, διαφορές και αντιστοιχία θέσεων.</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
