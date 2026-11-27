import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs";
import { LINK, PANEL, PANEL_BAR, Pager, Pill, fmt, fmtDate, serviceLabel } from "./kit";
import { batchSummary, deltaText, isTitleOnlyRule, ruleHint, ruleLabel, ruleOptions, sideLines } from "../../lib/automaticLinks";
import { cn } from "../../lib/cn";
import { API_UNREACHABLE, translateApiError } from "../../lib/labels";
import type { AutomaticLinkRow, AutomaticLinks as Listing } from "../../lib/types";

const PAGE_SIZE = 50;
const EMPTY: Listing = { total: 0, items: [], rules: { link: {}, fold: {} }, batches: [] };

async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/identity/${path}`, {
      signal,
      ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
  } catch (cause) {
    // The browser's own English ("Failed to fetch"); aborts pass through.
    if (cause instanceof TypeError) throw new Error(API_UNREACHABLE);
    throw cause;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(translateApiError(response.status, typeof data.detail === "string" ? data.detail : ""));
  return data;
}

function Side({ row, side }: { row: AutomaticLinkRow; side: "left" | "right" }) {
  const lines = sideLines(row, side);
  const link = row[`${side}_permalink`];
  const service = row[`${side}_service`];
  return (
    <div className="min-w-0 flex-1">
      <div className="truncate text-sm" title={lines.main}>
        {lines.main}
      </div>
      <div className="truncate text-xs text-cm-muted" title={lines.sub}>
        {lines.sub}
        {service !== "local" && (
          <>
            {" · "}
            {link && /^https:\/\/(soundcloud\.com|open\.spotify\.com)\//.test(link) ? (
              <a href={link} target="_blank" rel="noreferrer" className={LINK}>
                {serviceLabel(service)} ↗
              </a>
            ) : (
              serviceLabel(service)
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** The «Αυτόματες συνδέσεις» tab: what the rules linked or folded on their own, with an undo on every row. */
export function AutomaticLinks({ onChanged }: { onChanged: () => void }) {
  const [kind, setKind] = useState<"link" | "fold">("link");
  const [rule, setRule] = useState("");
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<Listing>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    request<Listing>(`automatic-links?${new URLSearchParams({ kind, rule, offset: String(offset) })}`, undefined, abort.signal)
      .then((listing) => {
        setData(listing);
        setError("");
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [kind, rule, offset, revision]);

  const done = (text: string) => {
    setMessage(text);
    setError("");
    // The last row of a page may be gone: step back rather than show an empty page.
    setOffset((value) => (data.items.length <= 1 ? Math.max(0, value - PAGE_SIZE) : value));
    setRevision((value) => value + 1);
    onChanged();
  };
  const act = async (key: string, run: () => Promise<string>) => {
    setBusy(key);
    setMessage("");
    try {
      done(await run());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const undo = (row: AutomaticLinkRow) =>
    act(`${row.left_id}|${row.right_id}`, async () => {
      const result = await request<{ still_connected?: boolean }>("automatic-links/undo", { left_id: row.left_id, right_id: row.right_id });
      return result.still_connected ? "Αναιρέθηκε. Μια άλλη σύνδεση κρατά ακόμη τις δύο πλευρές μαζί." : "Αναιρέθηκε. Το ζευγάρι δεν θα συνδεθεί ξανά αυτόματα.";
    });
  const options = ruleOptions(data.rules[kind]);
  const count = (view: "link" | "fold") => Object.values(data.rules[view]).reduce((sum, n) => sum + n, 0);

  return (
    <section className={cn(PANEL, "overflow-hidden")}>
      <div className="space-y-3 border-b border-cm-border p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Tabs
            value={kind}
            onValueChange={(value) => {
              setKind(value as "link" | "fold");
              setRule("");
              setOffset(0);
            }}
          >
            <TabsList aria-label="Είδος αυτόματης απόφασης">
              <TabsTrigger value="link">Σύνδεση με αρχείο · {fmt(count("link"))}</TabsTrigger>
              <TabsTrigger value="fold">Ένωση διπλότυπων · {fmt(count("fold"))}</TabsTrigger>
            </TabsList>
          </Tabs>
          <Select
            value={rule || "all"}
            onValueChange={(value) => {
              setRule(value === "all" ? "" : value);
              setOffset(0);
            }}
          >
            <SelectTrigger aria-label="Κανόνας">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="all">Όλοι οι κανόνες</SelectItem>
              {options.map((option) => (
                <SelectItem key={option.rule} value={option.rule}>
                  {option.label} · {fmt(option.count)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-xs text-cm-muted">
          {kind === "link"
            ? "Τοπικά αρχεία που το CrateMind συνέδεσε μόνο του με την εγγραφή τους στο Spotify ή στο SoundCloud. Πρώτα εμφανίζονται όσες συνδέσεις βασίστηκαν μόνο στον τίτλο. Αν μια σύνδεση είναι λάθος, πατήστε «Αναίρεση»."
            : "Εγγραφές του Spotify και του SoundCloud που είναι το ίδιο κομμάτι και μετρούν πλέον ως μία ηχογράφηση. Αν δύο εγγραφές δεν είναι το ίδιο κομμάτι, πατήστε «Αναίρεση»."}
        </p>
        {/* A whole batch is undone only by reconciliation/auto_link.py --undo-batch, with the app closed and a verified backup. */}
        {data.batches.map((batch) => (
          <p key={batch.id ?? "none"} className="text-xs text-cm-muted">
            Παρτίδα {fmtDate(batch.accepted_at)} · {batchSummary(batch)}
          </p>
        ))}
        {message && <p className="text-xs text-cm-chartreuse">{message}</p>}
        {error && (
          <p role="alert" className="text-xs text-cm-rose">
            {error}
          </p>
        )}
      </div>
      <div className={PANEL_BAR}>
        <span>
          {loading ? (
            "Φόρτωση…"
          ) : (
            <>
              <span className="font-medium tabular-nums text-cm-text">{fmt(data.total)}</span> {kind === "link" ? "συνδέσεις" : "ενώσεις"}
            </>
          )}
        </span>
        <Pager offset={offset} limit={PAGE_SIZE} total={data.total} onChange={setOffset} disabled={loading} />
      </div>
      <ul className="divide-y divide-cm-border">
        {data.items.map((row) => {
          const key = `${row.left_id}|${row.right_id}`;
          return (
            <li key={key} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
              <div className="flex min-w-64 flex-[3] items-center gap-3">
                <Side row={row} side="left" />
                <span className="text-cm-faint" aria-hidden="true">
                  ↔
                </span>
                <Side row={row} side="right" />
              </div>
              <div className="flex min-w-48 flex-1 flex-col items-start gap-1">
                <Pill tone={isTitleOnlyRule(row.rule) ? "amber" : "cyan"} className="max-w-full whitespace-normal">
                  <span title={ruleHint(row.rule)}>{ruleLabel(row.rule)}</span>
                </Pill>
                <span className="text-[11px] text-cm-faint">
                  {[fmtDate(row.accepted_at), deltaText(row.delta_seconds)].filter(Boolean).join(" · ")}
                </span>
              </div>
              <Button variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => undo(row)}>
                {busy === key ? "Αναίρεση…" : "Αναίρεση"}
              </Button>
            </li>
          );
        })}
      </ul>
      {!loading && !error && !data.items.length && (
        <p className="p-6 text-sm text-cm-muted">
          {count("link") + count("fold")
            ? "Καμία αυτόματη απόφαση με αυτά τα φίλτρα."
            : "Δεν υπάρχουν ακόμη αυτόματες συνδέσεις. Θα εμφανιστούν εδώ μόλις γίνει η πρώτη αυτόματη σύνδεση."}
        </p>
      )}
    </section>
  );
}
