import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";
import CollectionPicker from "../components/CollectionPicker";
import { collectionAccountLabel } from "../lib/collectionLabels";
import {
  Choice,
  identityRequest,
  availabilityLabels,
  fileCauseLabels,
  ProviderCounts,
  type Recording,
} from "../components/CompletenessControls";
import { PAGE, PAGE_SHELL, PANEL, PANEL_BAR, PageHeader, Pager, fmt, serviceLabel, LINK } from "../components/collections/kit";
import { ShieldCheck } from "../lib/icons";
import { cn } from "../lib/cn";
import { statusLabel } from "../lib/labels";
const PAGE_SIZE = 50;
const candidateClasses: Record<string, string> = {
  HIGH_CONFIDENCE: "υψηλή εμπιστοσύνη",
  PROBABLE: "πιθανό",
  AMBIGUOUS: "αμφίβολο",
  CONFLICT: "αντικρουόμενα στοιχεία",
};
const blockReasons: Record<string, string> = {
  insufficient_independent_evidence: "ανεπαρκή ανεξάρτητα στοιχεία",
  hard_guard_or_near_tie: "αυστηρός έλεγχος ή κοντινή ισοβαθμία",
};
const states = {
  "": "Χωρίς φίλτρο κατάστασης",
  wanted: "Προς απόκτηση",
  acquired: "Αποκτήθηκε",
  skipped: "Παράλειψη",
  unavailable: "Μη διαθέσιμο",
};
const metrics: Record<string, [string, string]> = {
  known_recordings: ["Γνωστές ηχογραφήσεις", "all"],
  unresolved: ["Ανεπίλυτες αναφορές", "unresolved"],
  locally_playable: ["Διαθέσιμες τοπικά", "playable"],
  local_missing_files: ["Ομάδες με μη διαθέσιμες διαδρομές", "missing_file"],
  remote_only: ["Μόνο σε πηγές", "remote_only"],
  soundcloud_likes_not_local: ["SoundCloud Likes χωρίς τοπικό", "soundcloud_like"],
  spotify_likes_not_local: ["Spotify Likes χωρίς τοπικό", "spotify_like"],
  in_recovery_queue: ["Προς απόκτηση", "wanted"],
};
const metricHints: Record<string, string> = {
  unresolved:
    "Αναγνωριστικά χωρίς τίτλο ή άλλα στοιχεία κομματιού. Κρατούν τη θέση τους σε μια λίστα ή στα Likes, αλλά δεν μετρούν ως γνωστές ηχογραφήσεις.",
};
export default function Recovery() {
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get("q") || ""),
    [availability, setAvailability] = useState(""),
    [scope, setScope] = useState(params.get("collection") ? "missing" : "all"),
    [provider, setProvider] = useState(""),
    [account, setAccount] = useState(""),
    [collection, setCollection] = useState(params.get("collection") || ""),
    [minimum, setMinimum] = useState("0"),
    [state, setState] = useState(""),
    [origin, setOrigin] = useState(""),
    [saved, setSaved] = useState(""),
    [offset, setOffset] = useState(0),
    [revision, setRevision] = useState(0);
  const [preset, setPreset] = useState(params.get("q") || params.get("collection") ? "discovery" : "wanted"),
    [familyMinimum, setFamilyMinimum] = useState("3"),
    [sort, setSort] = useState("families"),
    [saveName, setSaveName] = useState("");
  const [data, setData] = useState<{
      items: Recording[];
      total: number;
      metrics: Record<string, number>;
      spotify_accounts: string[];
    } | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState("");
  useEffect(
    () => setOffset(0),
    [preset, familyMinimum, sort, q, availability, scope, provider, account, collection, minimum, state, origin, saved],
  );
  useEffect(() => {
    let active = true;
    setLoading(true);
    const timer = setTimeout(
      () =>
        identityRequest<typeof data>("recovery-priorities", {
          preset,
          minimum_families: Number(familyMinimum) || 0,
          sort,
          offset,
          filters: {
            q,
            availability,
            scope,
            provider,
            account,
            collection,
            minimum: Number(minimum) || 0,
            state,
            origin,
            saved: saved === "yes",
          },
        })
          .then((v) => {
            if (active) {
              setData(v);
              setError("");
            }
          })
          .catch((e) => {
            if (active) setError(e.message);
          })
          .finally(() => {
            if (active) setLoading(false);
          }),
      250,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [preset, familyMinimum, sort, q, availability, scope, provider, account, collection, minimum, state, origin, saved, offset, revision]);
  async function decide(r: Recording, next: string) {
    if (!next) return;
    setBusy(r.recording_id);
    try {
      await identityRequest("recovery", { recording_id: r.recording_id, state: next });
      setRevision((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  function metric(value: string) {
    setPreset(value === "wanted" ? "wanted" : "discovery");
    setAvailability("");
    setQ("");
    setState("");
    setOrigin("");
    setProvider("");
    setAccount("");
    setCollection("");
    setMinimum("0");
    setSaved("");
    setScope(["all", "playable", "unresolved"].includes(value) ? value : "missing");
    if (value === "wanted") setState(value);
    else if (value === "missing_file") setOrigin(value);
    else if (!["all", "playable", "unresolved"].includes(value)) setQ(value);
  }
  async function save() {
    setBusy("save");
    try {
      const r = await identityRequest<{ saved_collection_id: string }>("recovery-priorities", {
        preset,
        minimum_families: Number(familyMinimum) || 0,
        sort,
        filters: {
          q,
          availability,
          scope,
          provider,
          account,
          collection,
          minimum: Number(minimum) || 0,
          state,
          origin,
          saved: saved === "yes",
        },
        save_name: saveName,
      });
      window.location.assign(`/collections?id=${encodeURIComponent(r.saved_collection_id)}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  return (
    <div className={PAGE_SHELL}>
      <PageHeader icon={ShieldCheck} title="Πληρότητα & ανάκτηση">
        Remote-only σημαίνει χωρίς αποδεκτή τοπική σύνδεση, όχι επιβεβαιωμένη απουσία audio ή επιθυμία απόκτησης. Η ουρά περιλαμβάνει μόνο
        ρητά wanted· τα άλλα σύνολα είναι προτάσεις ή επιλεγμένη εξερεύνηση.
      </PageHeader>
      <div className={PAGE}>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {Object.entries(metrics).map(([key, [label, value]]) => (
            <button
              key={key}
              type="button"
              className={cn(PANEL, "group p-4 text-left transition duration-200 hover:-translate-y-0.5 hover:border-cm-cyan/30")}
              title={metricHints[key]}
              onClick={() => metric(value)}
            >
              <span className="block text-2xl font-semibold tabular-nums leading-none">
                {data ? fmt(data.metrics[key]) : <span className="text-cm-faint">—</span>}
              </span>
              <span className="mt-2 block text-xs text-cm-muted transition-colors group-hover:text-cm-text">{label}</span>
            </button>
          ))}
        </div>
        <section className={cn(PANEL, "space-y-3 p-4")}>
          <div className="flex flex-wrap items-center gap-2">
            <Choice
              label="Σύνολο ανάκτησης"
              value={preset}
              onChange={(v) => {
                setPreset(v);
                setScope("all");
                setState("");
                setQ("");
                setOrigin("");
              }}
              options={{
                wanted: "Η ουρά μου — ρητά wanted",
                favourites: "Πρόταση: αγαπημένα χωρίς τοπικό",
                cross_provider: "Πρόταση: Likes και στις δύο πηγές",
                strong_interest: "Πρόταση: remote-only σε πολλές οικογένειες",
                lost_files: "Μη διαθέσιμες τοπικές διαδρομές",
                discovery: "Εξερεύνηση catalog — χωρίς πρόθεση απόκτησης",
              }}
            />
            <Choice
              label="Ταξινόμηση προτεραιότητας"
              value={sort}
              onChange={setSort}
              options={{
                families: "Οικογένειες συλλογών ↓",
                raw_collections: "Ακατέργαστες συλλογές ↓",
                wanted: "Ρητά wanted πρώτα",
                soundcloud_plays: "Ελάχιστα παρατηρημένα plays στα συνδεδεμένα SoundCloud uploads ↑",
                soundcloud_likes: "Ελάχιστα παρατηρημένα likes στα συνδεδεμένα SoundCloud uploads ↑",
                artist: "Καλλιτέχνης",
              }}
            />
            {preset === "strong_interest" && (
              <label className="flex items-center gap-2 text-xs text-cm-muted">
                Ελάχιστες οικογένειες
                <Input className="w-20" type="number" min="0" value={familyMinimum} onChange={(e) => setFamilyMinimum(e.target.value)} />
              </label>
            )}
          </div>
          <Input
            aria-label="Αναζήτηση ηχογραφήσεων"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Καλλιτέχνης, τίτλος · soundcloud_like · spotify_like · collections:5+"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Choice
              label="Πεδίο"
              value={scope}
              onChange={setScope}
              options={{
                missing: "Χωρίς τοπική αναπαραγωγή",
                all: "Όλες οι ηχογραφήσεις",
                playable: "Διαθέσιμες τοπικά",
                unresolved: "Ανεπίλυτες",
              }}
            />
            <Choice
              label="Κανονική διαθεσιμότητα"
              value={availability}
              onChange={setAvailability}
              options={{ "": "Όλες οι διαθεσιμότητες", ...availabilityLabels }}
            />
            <Choice
              label="Πηγή"
              value={provider}
              onChange={setProvider}
              options={{ "": "Όλες οι πηγές", soundcloud: "SoundCloud", spotify: "Spotify" }}
            />
            <Choice
              label="Spotify Likes λογαριασμού"
              value={account}
              onChange={setAccount}
              options={{
                "": "Όλοι οι λογαριασμοί Spotify",
                ...Object.fromEntries((data?.spotify_accounts || []).map((a) => [a, `♥ Spotify ${a}`])),
              }}
            />
            <Choice
              label="Ιστορικό τοπικού"
              value={origin}
              onChange={setOrigin}
              options={{
                "": "Κάθε τοπικό ιστορικό",
                missing_file: "Τοπική διαδρομή μη διαθέσιμη",
                never_local: "Χωρίς αποδεκτή τοπική σύνδεση",
              }}
            />
            <Choice label="Κατάσταση ανάκτησης" value={state} onChange={setState} options={states} />
            <Choice
              label="Αποθηκευμένες playlists"
              value={saved}
              onChange={setSaved}
              options={{ "": "Όλες οι σχέσεις", yes: "Σε αποθηκευμένη playlist" }}
            />
            <CollectionPicker value={collection} onChange={setCollection} />
            <label className="flex items-center gap-2 text-xs text-cm-muted">
              Ελάχιστες συλλογές
              <Input className="w-20" type="number" min="0" value={minimum} onChange={(e) => setMinimum(e.target.value)} />
            </label>
          </div>
          <details className="text-xs text-cm-muted">
            <summary className="text-cm-faint hover:text-cm-muted">Πώς διαβάζονται οι αριθμοί</summary>
            <p className="mt-2 max-w-3xl leading-relaxed">
              Η ταξινόμηση δημοτικότητας χρησιμοποιεί το ελάχιστο παρατηρημένο plays/likes μεταξύ συνδεδεμένων SoundCloud uploads, όχι μέτρο
              αφάνειας ηχογράφησης. Το άγνωστο παραμένει άγνωστο και ταξινομείται μετά το μηδέν. Οικογένειες = ρίζες αποδεκτής προέλευσης, όχι
              αποδεδειγμένες ανεξάρτητες προτιμήσεις. Οι ανεπίλυτες σχέσεις μετρώνται χωριστά. Η ακατέργαστη συχνότητα δεν ισούται με
              προσωπική σημασία. Η ένδειξη «Αποκτήθηκε» είναι προσωπική σημείωση· η αναπαραγωγή απαιτεί αρχείο στο catalog.
            </p>
          </details>
          <div className="flex flex-wrap items-center gap-2 border-t border-cm-border pt-3">
            <Input
              aria-label="Όνομα συλλογής από ερώτημα"
              wrapperClassName="min-w-60 flex-1"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="Αποθήκευση αποτελεσμάτων σε νέα συλλογή…"
              maxLength={200}
            />
            <Button size="sm" disabled={!saveName.trim() || loading || !!busy} onClick={save}>
              Αποθήκευση στιγμιότυπου
            </Button>
            <p className="w-full text-xs text-cm-faint">Η αποθήκευση δεν θέτει αυτόματα wanted και δεν αποκτά αρχεία.</p>
          </div>
        </section>
        {error && (
          <p role="alert" className="rounded-xl border border-cm-rose/30 bg-cm-rose/10 p-3 text-sm text-cm-rose">
            {error}
          </p>
        )}
        <section className={cn(PANEL, "overflow-hidden")}>
          <div className={PANEL_BAR}>
            <span>
              {loading ? (
                "Φόρτωση…"
              ) : (
                <>
                  <span className="font-medium tabular-nums text-cm-text">{fmt(data?.total)}</span> ηχογραφήσεις
                </>
              )}
            </span>
            <Pager offset={offset} limit={PAGE_SIZE} total={data?.total || 0} onChange={setOffset} disabled={loading} />
          </div>
          <ul className="divide-y divide-cm-border">
            {data?.items.map((r) => (
              <li key={r.recording_id} className="space-y-2 px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <a href={`/canonical?id=${encodeURIComponent(r.recording_id)}`} className="text-sm transition-colors hover:text-cm-cyan">
                      {r.artist || "Άγνωστος καλλιτέχνης"} — {r.title || "Χωρίς τίτλο"}
                    </a>
                    <p className="mt-0.5 text-xs text-cm-muted">
                      {availabilityLabels[r.availability.state]} ·{" "}
                      <span className="tabular-nums">
                        {fmt(r.collection_count)} πηγές / {fmt(r.collection_family_count)} οικογένειες · {fmt(r.raw_collection_occurrences)}{" "}
                        θέσεις
                      </span>
                    </p>
                  </div>
                  <fieldset disabled={busy === r.recording_id}>
                    <Choice
                      label={`Ανάκτηση ${r.title}`}
                      value={r.recovery_state || ""}
                      onChange={(v) => decide(r, v)}
                      options={{ ...states, "": "Ορισμός κατάστασης…" }}
                    />
                  </fieldset>
                </div>
                {r.local_candidate_evidence && (
                  <div className="space-y-1 rounded-lg border border-cm-amber/25 bg-cm-amber/5 p-2.5 text-xs">
                    <p title="Μετρά μόνο τις αποθηκευμένες υποψήφιες συνδέσεις· οι πιο αδύναμες δεν διατηρούνται.">
                      Χωρίς αποδεκτή τοπική σύνδεση · {fmt(r.local_candidate_evidence.plausible_local_files)} πιθανά τοπικά αρχεία (υψηλή
                      εμπιστοσύνη ή πιθανά) · τουλάχιστον {fmt(r.local_candidate_evidence.ambiguous_local_files)} αμφίβολα · τουλάχιστον{" "}
                      {fmt(r.local_candidate_evidence.guarded_pairs)} ζεύγη με περιορισμούς
                    </p>
                    <p className="text-cm-muted">
                      Οι υποψήφιες συνδέσεις δεν είναι αποδεκτές ταυτότητες ή διαθέσιμα αρχεία.
                      {r.local_candidate_evidence.candidate_pairs === 0
                        ? " Δεν υπάρχει αποθηκευμένη υποψηφιότητα· αυτό δεν αποδεικνύει απουσία audio."
                        : ""}
                    </p>
                    {r.local_candidate_evidence.items.map((c, i) => (
                      <a key={`${c.local_entity_id}:${i}`} className={cn("block", LINK)} href={c.review_url}>
                        Έλεγχος: {c.artist} — {c.title} · {candidateClasses[c.class] ?? "υποψήφιο"} · {Math.round(c.score)}/100
                        {c.guarded ? " · περιορισμός" : ""}
                        {c.block_reason ? ` · ${blockReasons[c.block_reason] ?? "άλλος περιορισμός"}` : ""}
                      </a>
                    ))}
                  </div>
                )}
                {r.local_assets
                  ?.filter((a) => a.file_evidence.state !== "present" || a.catalog_missing_flag)
                  .map((a) => (
                    <p key={a.local_track_id} className="text-xs text-cm-amber">
                      Αρχείο #{a.local_track_id}: {fileCauseLabels[a.file_evidence.state] || "Άγνωστη αιτία"}
                      {a.catalog_missing_flag ? " · αποθηκευμένη ένδειξη απόντος" : ""}. Η απουσία αφορά τη διαδρομή, όχι αποδεδειγμένη
                      απώλεια του audio.
                    </p>
                  ))}
                {r.likes.length > 0 && (
                  <p className="text-xs text-cm-magenta">
                    {r.likes.map((c) => `♥ ${serviceLabel(c.service)} ${collectionAccountLabel(c.service, c.provenance.account, "")}`.trim()).join(" · ")}
                  </p>
                )}
                <ProviderCounts providers={r.providers} />
                {Boolean(r.dj_personal_statuses?.length) && (
                  <p className="text-xs text-cm-muted">DJ κατάσταση: {r.dj_personal_statuses!.map((v) => statusLabel(v)).join(", ")}</p>
                )}
                <a href={`/provenance?recording=${encodeURIComponent(r.recording_id)}`} className={cn("inline-block text-xs", LINK)}>
                  Γνωστές παρατηρήσεις και προέλευση
                </a>
              </li>
            ))}
          </ul>
          {data?.total === 0 && !loading && <p className="p-6 text-sm text-cm-muted">Δεν βρέθηκαν ηχογραφήσεις με αυτά τα φίλτρα.</p>}
        </section>
      </div>
    </div>
  );
}
