import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";
import CollectionPicker from "../components/CollectionPicker";
import {
  Choice,
  identityRequest,
  availabilityLabels,
  fileCauseLabels,
  ProviderCounts,
  type Recording,
} from "../components/CompletenessControls";
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
    <div className="scroll-fade-y h-full overflow-y-auto space-y-5 p-6 text-cm-text">
      <header>
        <h1 className="text-2xl font-semibold">Πληρότητα & ανάκτηση</h1>
        <p className="mt-2 text-sm text-cm-muted">
          Remote-only σημαίνει χωρίς αποδεκτή τοπική σύνδεση, όχι επιβεβαιωμένη απουσία audio ή επιθυμία απόκτησης. Η ουρά περιλαμβάνει μόνο
          ρητά wanted· τα άλλα σύνολα είναι προτάσεις ή επιλεγμένη εξερεύνηση.
        </p>
      </header>
      <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
        {Object.entries(metrics).map(([key, [label, value]]) => (
          <Button
            key={key}
            variant="outline"
            className="h-auto whitespace-normal py-3"
            title={metricHints[key]}
            onClick={() => metric(value)}
          >
            <span>
              <strong className="block text-xl">{data?.metrics[key]?.toLocaleString() ?? "—"}</strong>
              {label}
            </span>
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
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
          <label className="text-xs">
            Ελάχιστες οικογένειες
            <Input type="number" min="0" value={familyMinimum} onChange={(e) => setFamilyMinimum(e.target.value)} />
          </label>
        )}
      </div>
      <Input
        aria-label="Αναζήτηση ηχογραφήσεων"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Καλλιτέχνης, τίτλος · soundcloud_like · spotify_like · collections:5+"
      />
      <div className="flex flex-wrap gap-2">
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
        <label className="flex items-center gap-2 text-xs">
          Ελάχιστες συλλογές
          <Input className="w-20" type="number" min="0" value={minimum} onChange={(e) => setMinimum(e.target.value)} />
        </label>
      </div>
      <p className="text-xs text-cm-muted">
        Η ταξινόμηση δημοτικότητας χρησιμοποιεί το ελάχιστο παρατηρημένο plays/likes μεταξύ συνδεδεμένων SoundCloud uploads, όχι μέτρο
        αφάνειας ηχογράφησης. Το άγνωστο παραμένει άγνωστο και ταξινομείται μετά το μηδέν. Οικογένειες = ρίζες αποδεκτής προέλευσης, όχι
        αποδεδειγμένες ανεξάρτητες προτιμήσεις. Οι ανεπίλυτες σχέσεις μετρώνται χωριστά. Η ακατέργαστη συχνότητα δεν ισούται με προσωπική
        σημασία. Η ένδειξη «Αποκτήθηκε» είναι προσωπική σημείωση· η αναπαραγωγή απαιτεί αρχείο στο catalog.
      </p>
      <div className="flex gap-2">
        <Input
          aria-label="Όνομα συλλογής από ερώτημα"
          value={saveName}
          onChange={(e) => setSaveName(e.target.value)}
          placeholder="Αποθήκευση αποτελεσμάτων σε νέα συλλογή…"
          maxLength={200}
        />
        <Button disabled={!saveName.trim() || loading || !!busy} onClick={save}>
          Αποθήκευση στιγμιότυπου
        </Button>
      </div>
      <p className="text-xs text-cm-muted">Η αποθήκευση δεν θέτει αυτόματα wanted και δεν αποκτά αρχεία.</p>
      {error && (
        <p role="alert" className="text-rose-300">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between">
        <span>{loading ? "Φόρτωση…" : `${data?.total ?? 0} ηχογραφήσεις`}</span>
        <div>
          <Button variant="ghost" disabled={!offset || loading} onClick={() => setOffset((v) => Math.max(0, v - 50))}>
            Προηγούμενα
          </Button>
          <Button variant="ghost" disabled={loading || offset + 50 >= (data?.total || 0)} onClick={() => setOffset((v) => v + 50)}>
            Επόμενα
          </Button>
        </div>
      </div>
      <ul className="divide-y divide-white/10">
        {data?.items.map((r) => (
          <li key={r.recording_id} className="space-y-2 py-4">
            <div className="flex flex-wrap justify-between gap-2">
              <a href={`/canonical?id=${encodeURIComponent(r.recording_id)}`} className="hover:text-cyan-300">
                {r.artist || "Άγνωστος καλλιτέχνης"} — {r.title || "Χωρίς τίτλο"}
              </a>
              <fieldset disabled={busy === r.recording_id}>
                <Choice
                  label={`Ανάκτηση ${r.title}`}
                  value={r.recovery_state || ""}
                  onChange={(v) => decide(r, v)}
                  options={{ ...states, "": "Ορισμός κατάστασης…" }}
                />
              </fieldset>
            </div>
            <p className="text-xs text-cm-muted">
              {availabilityLabels[r.availability.state]} · {r.collection_count} πηγές / {r.collection_family_count} οικογένειες ·{" "}
              {r.raw_collection_occurrences} θέσεις
            </p>
            {r.local_candidate_evidence && (
              <div className="space-y-1 rounded border border-amber-500/20 p-2 text-xs">
                <p title="Μετρά μόνο τις αποθηκευμένες υποψήφιες συνδέσεις· οι πιο αδύναμες δεν διατηρούνται.">
                  Χωρίς αποδεκτή τοπική σύνδεση · {r.local_candidate_evidence.plausible_local_files} πιθανά τοπικά αρχεία
                  (HIGH_CONFIDENCE/PROBABLE) · τουλάχιστον {r.local_candidate_evidence.ambiguous_local_files} αμφίβολα · τουλάχιστον{" "}
                  {r.local_candidate_evidence.guarded_pairs} ζεύγη με περιορισμούς
                </p>
                <p className="text-cm-muted">
                  Οι υποψήφιες συνδέσεις δεν είναι αποδεκτές ταυτότητες ή διαθέσιμα αρχεία.
                  {r.local_candidate_evidence.candidate_pairs === 0
                    ? " Δεν υπάρχει αποθηκευμένη υποψηφιότητα· αυτό δεν αποδεικνύει απουσία audio."
                    : ""}
                </p>
                {r.local_candidate_evidence.items.map((c, i) => (
                  <a key={`${c.local_entity_id}:${i}`} className="block text-cyan-300 underline" href={c.review_url}>
                    Έλεγχος: {c.artist} — {c.title} · {c.class} · {c.score}/100{c.guarded ? " · περιορισμός" : ""}
                    {c.block_reason ? ` · ${c.block_reason}` : ""}
                  </a>
                ))}
              </div>
            )}
            {r.local_assets
              ?.filter((a) => a.file_evidence.state !== "present" || a.catalog_missing_flag)
              .map((a) => (
                <p key={a.local_track_id} className="text-xs text-amber-200">
                  Αρχείο #{a.local_track_id}: {fileCauseLabels[a.file_evidence.state] || a.file_evidence.state}
                  {a.catalog_missing_flag ? " · αποθηκευμένη ένδειξη missing" : ""}. Η απουσία αφορά τη διαδρομή, όχι αποδεδειγμένη απώλεια
                  του audio.
                </p>
              ))}
            <p className="text-xs text-pink-300">{r.likes.map((c) => `♥ ${c.service} ${c.provenance.account || ""}`).join(" · ")}</p>
            <ProviderCounts providers={r.providers} />
            <p className="text-xs">{r.dj_personal_statuses?.length ? `DJ status: ${r.dj_personal_statuses.join(", ")}` : ""}</p>
            <a href={`/provenance?recording=${encodeURIComponent(r.recording_id)}`} className="text-xs text-cyan-300 underline">
              Γνωστές παρατηρήσεις και προέλευση
            </a>
          </li>
        ))}
      </ul>
      {data?.total === 0 && !loading && <p>Δεν βρέθηκαν ηχογραφήσεις με αυτά τα φίλτρα.</p>}
    </div>
  );
}
