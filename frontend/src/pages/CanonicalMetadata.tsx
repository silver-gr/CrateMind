import { hasProviderWorkflows, useCapabilities } from "../lib/capabilities";
import { IdentityLinker, UndoIdentity } from "../components/IdentityLinker";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { SectionHeader } from "../components/ui/SectionHeader";
import { LINK, PAGE, PANEL, PANEL_BAR, PageHeader, Pager, Pill, fmt, serviceLabel } from "../components/collections/kit";
import { SlidersHorizontal } from "../lib/icons";
import { cn } from "../lib/cn";

type Credit = { name: string; role: string };
type Proposal = { title: string; artist: string; version: string; release: string; credits: Credit[] };
type Observation = { id: string; service: string; artist: string; title: string };
type Row = {
  recording_id: string;
  title: string;
  artist: string;
  state: string;
  proposal: Proposal;
  evidence: { observations: Observation[]; patterns: string[]; validated_patterns: string[] };
};
type Provider = {
  id: string;
  service: string;
  url: string;
  release: string;
  popularity: unknown;
  liked_in: { name: string; provenance: Record<string, unknown> }[];
  collections: { id: string; name: string; position: number }[];
};
type Detail = Row & {
  local_assets: { playable: boolean; retired?: boolean }[];
  credits: Credit[];
  providers: Provider[];
  acceptances: {
    left_id: string;
    right_id: string;
    confidence: number;
    method: string;
    acceptance_mode: string;
    revoked_at: string | null;
  }[];
};
type Pattern = { pattern: string; occurrences: number; corroborated: number; tested: number; measured_precision: number | null };
// Links undo-identity reverses: manual confirmations and the cleanup's automatic SoundCloud links.
const undoableMethods = new Set(["manual_identity_confirmation", "cleanup_policy_high_confidence", "cleanup_download_provenance"]);
const roles: Record<string, string> = {
  primary: "Κύριος καλλιτέχνης",
  collaborator: "Συνεργάτης / συντελεστής",
  featured: "Συμμετοχή",
  remixer: "Remixer",
};
const patternNames: Record<string, string> = {
  artist_inside_title: "Καλλιτέχνης μέσα στον τίτλο",
  label_as_artist: "Δισκογραφική ως καλλιτέχνης",
  duplicated_artist_in_title: "Διπλός καλλιτέχνης στον τίτλο",
  promotional_noise: "Προωθητικό κείμενο",
  bpm_annotation: "BPM στον τίτλο",
  leading_track_number: "Αριθμός πριν τον τίτλο",
  catalogue_annotation: "Κωδικός καταλόγου",
  collaboration_credit: "Συνεργασίες",
  remixer_credit: "Συμμετοχή remixer",
};
async function request<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(
    `/api/identity/canonical/${path}`,
    body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined,
  );
  if (!r.ok) {
    const e = await r.json();
    throw Error(e.detail || "Αποτυχία φόρτωσης");
  }
  return r.json();
}
function Filter({
  label,
  value,
  onChange,
  items,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  items: [string, string][];
}) {
  return (
    <Select value={value || "all"} onValueChange={(v) => onChange(v === "all" ? "" : v)}>
      <SelectTrigger aria-label={label}>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent position="popper">
        <SelectItem value="all">{label}</SelectItem>
        {items.map(([id, name]) => (
          <SelectItem key={id} value={id}>
            {name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
export default function CanonicalMetadata() {
  const providerWorkflows = hasProviderWorkflows(useCapabilities());
  const [params] = useSearchParams();
  const [q, setQ] = useState(""),
    [state, setState] = useState(""),
    [pattern, setPattern] = useState(""),
    [offset, setOffset] = useState(0);
  const [view, setView] = useState("needs_review");
  const [rows, setRows] = useState<{ items: Row[]; total: number }>({ items: [], total: 0 });
  const [patterns, setPatterns] = useState<Pattern[]>([]),
    [selected, setSelected] = useState(params.get("id") || ""),
    [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Proposal | null>(null);
  const [artistQuery, setArtistQuery] = useState(""),
    [artists, setArtists] = useState<{ id: string; name: string; recordings: number }[]>([]),
    [artist, setArtist] = useState(""),
    [role, setRole] = useState("");
  useEffect(() => {
    request<Pattern[]>("patterns")
      .then(setPatterns)
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(
      () =>
        request<{ items: Row[]; total: number }>(
          `items?${new URLSearchParams({ q, state, pattern, offset: String(offset), artist_id: artist, role, view })}`,
        )
          .then((r) => {
            if (active) setRows(r);
          })
          .catch((e) => {
            if (active) setError(e.message);
          }),
      180,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [q, state, pattern, offset, revision, artist, role, view]);
  useEffect(() => {
    let active = true;
    setDetail(null);
    setEditing(null);
    if (selected)
      request<Detail>(`item?id=${encodeURIComponent(selected)}`)
        .then((r) => {
          if (active) setDetail(r);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [selected, revision]);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(
      () =>
        request<typeof artists>(`artists?q=${encodeURIComponent(artistQuery)}`)
          .then((r) => {
            if (active) setArtists(r);
          })
          .catch((e) => {
            if (active) setError(e.message);
          }),
      180,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [artistQuery]);
  async function decide(action: string) {
    if (!detail) return;
    setBusy(true);
    setError("");
    try {
      await request("decision", { recording_id: detail.recording_id, action, payload: action === "edit" ? editing : null });
      setRevision((v) => v + 1);
      setMessage("Αποθηκεύτηκε μόνο στη βάση CrateMind.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function bulk() {
    setBusy(true);
    setError("");
    try {
      const r = await request<{ applied: number }>("pattern-accept", { pattern });
      setMessage(`Εφαρμόστηκε σε ${r.applied} εγγραφές.`);
      setRevision((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const selectedPattern = patterns.find((p) => p.pattern === pattern);
  return (
    <div className={PAGE}>
      <PageHeader
        icon={SlidersHorizontal}
        title="Κανονικά μεταδεδομένα"
        actions={
          <a href="/library" className={cn("text-sm", LINK)}>
            Βιβλιοθήκη
          </a>
        }
      >
        Η προτιμώμενη ταυτότητα της μουσικής σου. Τα αρχικά στοιχεία διατηρούνται· τα αρχεία ήχου δεν αλλάζουν.
      </PageHeader>
      {error && (
        <p role="alert" className="rounded-xl border border-cm-rose/30 bg-cm-rose/10 p-3 text-sm text-cm-rose">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="rounded-xl border border-cm-chartreuse/30 bg-cm-chartreuse/10 p-3 text-sm text-cm-chartreuse">
          {message}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Input
          aria-label="Αναζήτηση κανονικών μεταδεδομένων"
          placeholder="Καλλιτέχνης ή τίτλος…"
          wrapperClassName="min-w-52 flex-1"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOffset(0);
          }}
        />
        <Filter
          label="Όλες οι εγγραφές"
          value={view === "all" ? "" : view}
          onChange={(v) => {
            setView(v || "all");
            setState("");
            setOffset(0);
          }}
          items={[
            ["needs_review", "Χρειάζεται έλεγχο"],
            ["auto_applied", "Αυτόματα εφαρμοσμένα"],
            ["conflicts", "Συγκρούσεις"],
            ["provider_only", "Μόνο σε πηγές"],
            ["local_only", "Μόνο τοπικά"],
            ["complete", "Πλήρη κανονικά στοιχεία"],
            ["unknown", "Άγνωστα μεταδεδομένα"],
          ]}
        />
        <Filter
          label="Όλες οι καταστάσεις"
          value={state}
          onChange={(v) => {
            setState(v);
            setOffset(0);
          }}
          items={[
            ["review", "Για έλεγχο"],
            ["derived", "Αυτόματα"],
            ["human", "Επιβεβαιωμένα"],
            ["kept_local", "Διατήρηση τοπικών"],
            ["rejected", "Απορριφθέντα"],
          ]}
        />
        <Filter
          label="Όλα τα μοτίβα"
          value={pattern}
          onChange={(v) => {
            setPattern(v);
            setOffset(0);
          }}
          items={patterns.map((p) => [p.pattern, `${patternNames[p.pattern] || "Άλλο μοτίβο"} (${fmt(p.occurrences)})`])}
        />
      </div>
      {selectedPattern && (
        <section className={cn(PANEL, "space-y-2 p-4")}>
          <p className="text-sm">
            <span className="tabular-nums">{fmt(selectedPattern.occurrences)}</span> εμφανίσεις ·{" "}
            <span className="tabular-nums">
              {fmt(selectedPattern.corroborated)}/{fmt(selectedPattern.tested)}
            </span>{" "}
            συμφωνούν με αποδεκτή ταυτότητα Spotify{" "}
            {selectedPattern.measured_precision !== null ? `(${(selectedPattern.measured_precision * 100).toFixed(1)}%)` : ""}
          </p>
          <p className="text-xs text-cm-muted">
            Αυτή είναι συμφωνία πηγών, όχι εκτίμηση πιθανότητας. Ελέγξτε και αποδεχτείτε 10 παραδείγματα πριν τη μαζική εφαρμογή. Τυχόν
            απόρριψη ή διατήρηση τοπικών σταματά τη μαζική εφαρμογή.
          </p>
          <Button variant="outline" size="sm" disabled={busy} onClick={bulk}>
            Εφαρμογή μοτίβου μετά τον έλεγχο
          </Button>
        </section>
      )}
      <details className={cn(PANEL, "p-4")}>
        <summary className="text-sm font-medium">Καλλιτέχνες και ρόλοι</summary>
        <div className="mt-3 flex flex-wrap gap-3">
          <Input
            aria-label="Αναζήτηση καλλιτέχνη"
            wrapperClassName="w-64"
            value={artistQuery}
            placeholder="Αναζήτηση καλλιτέχνη…"
            onChange={(e) => setArtistQuery(e.target.value)}
          />
          <Filter
            label="Όλοι οι καλλιτέχνες"
            value={artist}
            onChange={(v) => {
              setArtist(v);
              setOffset(0);
            }}
            items={artists.map((a) => [a.id, `${a.name} (${fmt(a.recordings)})`])}
          />
          <Filter
            label="Όλοι οι ρόλοι"
            value={role}
            onChange={(v) => {
              setRole(v);
              setOffset(0);
            }}
            items={Object.entries(roles)}
          />
        </div>
      </details>
      <div className="grid items-start gap-5 xl:grid-cols-2">
        <section className={cn(PANEL, "min-w-0 overflow-hidden")}>
          <div className={PANEL_BAR}>
            <span>
              <span className="font-medium tabular-nums text-cm-text">{fmt(rows.total)}</span> εγγραφές
            </span>
            <Pager offset={offset} limit={50} total={rows.total} onChange={setOffset} />
          </div>
          <ul className="divide-y divide-cm-border">
            {rows.items.map((r) => (
              <li key={r.recording_id}>
                <button
                  type="button"
                  aria-current={selected === r.recording_id || undefined}
                  className={cn(
                    "flex w-full items-start gap-3 border-l-2 border-transparent px-4 py-2.5 text-left transition-colors hover:bg-cm-line/5",
                    selected === r.recording_id && "border-cm-cyan bg-cm-cyan/10",
                  )}
                  onClick={() => setSelected(r.recording_id)}
                >
                  <span className="min-w-0 flex-1 text-sm break-words">
                    {r.artist || "Άγνωστος καλλιτέχνης"} — {r.title}
                  </span>
                  <Pill tone={r.state === "review" ? "amber" : r.state === "derived" ? "cyan" : "chartreuse"}>
                    {r.state === "review" ? "Για έλεγχο" : r.state === "derived" ? "Αυτόματα" : "Απόφαση χρήστη"}
                  </Pill>
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section className={cn(PANEL, "min-w-0 space-y-5 p-4")}>
          {!detail ? (
            <p className="text-sm text-cm-muted">Επιλέξτε εγγραφή για πρόταση και στοιχεία.</p>
          ) : (
            <>
              <div className="rounded-xl border border-cm-cyan/20 bg-cm-cyan/5 p-3">
                <SectionHeader className="mb-1">
                  Κανονικά τώρα
                  {detail.state === "human" ? " · Χειροκίνητη απόφαση" : detail.state === "kept_local" ? " · Διατήρηση τοπικών" : ""}
                </SectionHeader>
                <p className="text-sm">
                  {detail.artist || "Άγνωστος καλλιτέχνης"} — {detail.title || "Χωρίς τίτλο"}
                </p>
                <p className="text-xs text-cm-muted">Αυτά τα στοιχεία χρησιμοποιεί η Βιβλιοθήκη.</p>
              </div>
              <div>
                <SectionHeader className="mb-2">Πρόταση κανονικών μεταδεδομένων</SectionHeader>
                <p className="text-lg font-semibold leading-snug">{detail.proposal.artist || "Άγνωστος καλλιτέχνης"}</p>
                <p className="text-sm">{detail.proposal.title}</p>
                {(detail.proposal.version || detail.proposal.release) && (
                  <p className="text-xs text-cm-muted">{[detail.proposal.version, detail.proposal.release].filter(Boolean).join(" · ")}</p>
                )}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {detail.proposal.credits.map((c, i) => (
                    <span key={i} className="rounded-md border border-cm-border bg-cm-line/5 px-2 py-0.5 text-xs">
                      {c.name} <span className="text-cm-muted">· {roles[c.role] ?? "Συντελεστής"}</span>
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={busy} onClick={() => decide("accept")}>
                  Αποδοχή μεταδεδομένων
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(structuredClone(detail.proposal))}>
                  Επεξεργασία
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => decide("reject")}>
                  Απόρριψη πρότασης
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => decide("keep_local")}
                  disabled={busy || !detail.local_assets.some((a) => !a.retired)}
                >
                  Διατήρηση τοπικών
                </Button>
              </div>
              {editing && (
                <section className="space-y-3 border-t border-cm-border pt-3">
                  <Input
                    aria-label="Νέος τίτλος"
                    placeholder="Τίτλος"
                    value={editing.title}
                    onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                  />
                  <Input
                    aria-label="Έκδοση"
                    placeholder="Έκδοση"
                    value={editing.version || ""}
                    onChange={(e) => setEditing({ ...editing, version: e.target.value })}
                  />
                  <Input
                    aria-label="Κυκλοφορία"
                    placeholder="Κυκλοφορία"
                    value={editing.release || ""}
                    onChange={(e) => setEditing({ ...editing, release: e.target.value })}
                  />
                  {editing.credits.map((c, i) => (
                    <div key={i} className="flex gap-2">
                      <Input
                        aria-label={`Καλλιτέχνης ${i + 1}`}
                        value={c.name}
                        onChange={(e) =>
                          setEditing({ ...editing, credits: editing.credits.map((v, j) => (i === j ? { ...v, name: e.target.value } : v)) })
                        }
                      />
                      <Filter
                        label="Ρόλος"
                        value={c.role}
                        onChange={(v) =>
                          setEditing({ ...editing, credits: editing.credits.map((r, j) => (i === j ? { ...r, role: v } : r)) })
                        }
                        items={Object.entries(roles)}
                      />
                      <Button
                        variant="ghost"
                        aria-label={`Αφαίρεση συμμετοχής ${i + 1}`}
                        onClick={() => setEditing({ ...editing, credits: editing.credits.filter((_, j) => j !== i) })}
                      >
                        ×
                      </Button>
                    </div>
                  ))}
                  <Button
                    variant="outline"
                    onClick={() => setEditing({ ...editing, credits: [...editing.credits, { name: "", role: "collaborator" }] })}
                  >
                    Προσθήκη συμμετοχής
                  </Button>
                  <Button disabled={busy} onClick={() => decide("edit")}>
                    Αποθήκευση
                  </Button>
                </section>
              )}
              <section>
                <SectionHeader className="mb-1">Στοιχεία πηγών — διαφορές με την πρόταση</SectionHeader>
                {detail.evidence.observations.map((o) => (
                  <div key={o.id} className="border-t border-cm-border py-3 text-sm">
                    <span className="text-xs text-cm-muted">
                      {{ local: "Τοπική πηγή", soundcloud: "Πηγή SoundCloud", spotify: "Πηγή Spotify" }[o.service] || "Πηγή"} · {o.id}
                    </span>
                    <p className={o.artist !== detail.proposal.artist ? "text-cm-amber" : ""}>
                      Καλλιτέχνης: {o.artist || "—"}
                      {o.artist !== detail.proposal.artist && ` → ${detail.proposal.artist || "—"}`}
                    </p>
                    <p className={o.title !== detail.proposal.title ? "text-cm-amber" : ""}>
                      Τίτλος: {o.title}
                      {o.title !== detail.proposal.title && ` → ${detail.proposal.title}`}
                    </p>
                  </div>
                ))}
              </section>
              <p className="text-sm text-cm-muted">
                Η αποδοχή μεταδεδομένων αλλάζει το εμφανιζόμενο κείμενο, όχι την ταυτότητα ηχογράφησης.
              </p>
              <IdentityLinker
                entityId={
                  (providerWorkflows ? detail.providers[0] : detail.providers.find((p) => p.service === "local"))?.id || detail.recording_id
                }
                entityService={(providerWorkflows ? detail.providers[0] : detail.providers.find((p) => p.service === "local"))?.service}
                onChanged={() => setRevision((v) => v + 1)}
              />
              <section>
                <SectionHeader className="mb-1">Αποδεκτές συνδέσεις ταυτότητας</SectionHeader>
                {detail.acceptances
                  .filter((a) => !a.revoked_at)
                  .map((a, i) => (
                    <p key={i} className="mt-2 break-all text-xs text-cm-muted">
                      {undoableMethods.has(a.method) && (
                        <UndoIdentity
                          leftId={a.left_id}
                          rightId={a.right_id}
                          leftService={detail.providers.find((p) => p.id === a.left_id)?.service}
                          rightService={detail.providers.find((p) => p.id === a.right_id)?.service}
                          onChanged={() => setRevision((v) => v + 1)}
                        />
                      )}{" "}
                      {a.left_id} ↔ {a.right_id} · {a.confidence}/100 ·{" "}
                      {a.acceptance_mode === "human"
                        ? "Ανθρώπινη απόφαση"
                        : a.method === "cleanup_download_provenance"
                          ? "Αυτόματη σύνδεση: λήψη από τα SoundCloud Likes"
                          : a.acceptance_mode === "deterministic"
                            ? "Σταθερό αναγνωριστικό / υπάρχουσα απόφαση"
                            : "Αυτόματη υψηλή εμπιστοσύνη"}
                    </p>
                  ))}
              </section>
              <section>
                <SectionHeader className="mb-1">Πηγές, δημοτικότητα και συλλογές</SectionHeader>
                {detail.providers.map((p) => (
                  <details key={p.id} className="border-t border-cm-border py-2.5 text-sm">
                    <summary>
                      <span className="font-medium">{serviceLabel(p.service)}</span>
                      <span className="text-xs text-cm-muted">
                        {p.liked_in.length ? "Στα αγαπημένα" : "Δεν υπάρχει εγγραφή Likes"} · {fmt(p.collections.length)} συμμετοχές σε
                        συλλογές
                      </span>
                    </summary>
                    <div className="mt-2 space-y-1 pl-5">
                      {p.url && (
                        <a href={p.url} target="_blank" rel="noreferrer" className={cn("text-xs", LINK)}>
                          Άνοιγμα πηγής ↗
                        </a>
                      )}
                      {p.release && <p className="text-xs text-cm-muted">{p.release}</p>}
                      <div className="text-xs text-cm-muted">
                        {p.popularity && typeof p.popularity === "object" && !Array.isArray(p.popularity) ? (
                          Object.entries(p.popularity).map(([key, value]) => (
                            <p key={key}>
                              {{
                                playback_count: "Αναπαραγωγές",
                                likes_count: "Likes",
                                reposts_count: "Reposts",
                                comment_count: "Σχόλια",
                                download_count: "Λήψεις",
                              }[key] || key}
                              :{" "}
                              <span className="tabular-nums text-cm-text">
                                {typeof value === "number" ? fmt(value) : String(value ?? "—")}
                              </span>
                            </p>
                          ))
                        ) : Array.isArray(p.popularity) ? (
                          <p>
                            Δημοτικότητα Spotify (εξαγωγή):{" "}
                            {Array.from(new Set(p.popularity.map((v: { value: string | null }) => v.value).filter((v) => v != null))).join(
                              " · ",
                            ) || "Δεν υπάρχει τιμή"}
                          </p>
                        ) : (
                          <p>Δεν υπάρχουν μετρητές.</p>
                        )}
                      </div>
                      {p.liked_in.map((l, i) => (
                        <p key={i} className="text-xs text-cm-magenta">
                          ♥ {l.name} · {String(l.provenance.account || "")}
                        </p>
                      ))}
                      <ul className="text-xs text-cm-muted">
                        {p.collections.map((c, i) => (
                          <li key={i}>
                            {c.name} <span className="text-cm-faint">· θέση {c.position + 1}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </details>
                ))}
              </section>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
