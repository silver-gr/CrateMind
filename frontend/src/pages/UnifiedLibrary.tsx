import { hasProviderWorkflows, useCapabilities } from "../lib/capabilities";
import { IdentityLinker } from "../components/IdentityLinker";
import { useSearchParams } from "react-router-dom";
import { useEffect, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "../components/ui/command";
import { SoundCloudCard } from "../components/SoundCloudCard";
import { api } from "../lib/api";
import type { SoundCloudTrackDetail } from "../lib/types";

type Entity = {
  retired?: boolean;
  playable?: boolean;
  lifecycle?: { survivor_id?: string };
  id: string;
  service: string;
  title: string | null;
  artist: string | null;
  status: string;
  local_track_id?: number;
  missing?: boolean;
  permalink?: string;
  recording_id: string;
};
type Candidate = {
  other_id: string;
  other_title: string;
  other_artist: string;
  other_service: string;
  class: string;
  score: number;
  evidence: {
    title_similarity: number;
    artist_similarity: number;
    duration_delta_seconds: number | null;
    conflicts: string[];
    isrc_equal: boolean;
    anchor?: { method: string };
    near_tie_review?: boolean;
    title_basis?: unknown;
    collection_context?: unknown;
  };
};
type Detail = Entity & {
  asset?: { retired: boolean; playable: boolean; local_track_id: number; lifecycle: { survivor_id?: string } };
  representations: Entity[];
  candidates: Candidate[];
  memberships: { id: string; name: string; position: number }[];
  normalized: { title_variants: { text: string; basis: string }[]; versions: string[] };
  metadata: Record<string, unknown>;
};
type Collection = {
  aliases?: string[];
  source_services?: string[];
  source_accounts?: string[];
  id: string;
  name: string;
  service: string;
  kind: string;
  track_count: number;
};
type CollectionDetail = Collection & {
  entries: (Entity & { position: number; local_assets: { local_track_id: number; missing?: boolean }[] })[];
};
type Summary = {
  entities: number;
  candidate_pairs: number;
  classes: Record<string, number>;
  coverage: Record<string, Record<string, number>>;
  proof_collection_id: string;
  unresolved_placeholders?: number;
};
const labels: Record<string, string> = {
  ACCEPTED: "Συνδεδεμένο",
  HIGH_CONFIDENCE: "Υψηλή εμπιστοσύνη",
  PROBABLE: "Πιθανό",
  AMBIGUOUS: "Αμφίβολο",
  CONFLICT: "Αντικρουόμενα στοιχεία",
  NO_CANDIDATE: "Χωρίς υποψήφιο",
};
const sources: Record<string, string> = { local: "Τοπικά αρχεία", spotify: "Spotify", soundcloud: "SoundCloud", cratemind: "CrateMind" };
async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/identity/${path}`, { signal });
  if (!response.ok) throw new Error(`Δεν ήταν δυνατή η φόρτωση (${response.status}).`);
  return response.json();
}
function Status({ value }: { value: string }) {
  const tone =
    value === "ACCEPTED"
      ? "text-emerald-300"
      : value === "CONFLICT"
        ? "text-rose-300"
        : value === "HIGH_CONFIDENCE"
          ? "text-cyan-300"
          : "text-amber-200";
  return <span className={`text-xs ${tone}`}>{labels[value] || value}</span>;
}
function SourceLink({ entity }: { entity: Entity }) {
  return entity.permalink && /^https:\/\/(soundcloud\.com|open\.spotify\.com)\//.test(entity.permalink) ? (
    <a href={entity.permalink} target="_blank" rel="noreferrer" className="text-xs text-cyan-300 underline">
      {sources[entity.service]}
    </a>
  ) : (
    <span className="text-xs text-cm-muted">{sources[entity.service]}</span>
  );
}

export default function UnifiedLibrary() {
  const providerWorkflows = hasProviderWorkflows(useCapabilities());
  const [params] = useSearchParams();
  const requestedCandidate = params.get("candidate") || "";
  const [summary, setSummary] = useState<Summary | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState("recordings");
  const [revision, setRevision] = useState(0);
  const [assetError, setAssetError] = useState("");
  const [service, setService] = useState("");
  const [category, setCategory] = useState("");
  const [offset, setOffset] = useState(0);
  const [list, setList] = useState<{ total: number; items: Entity[] }>({ total: 0, items: [] });
  const [selected, setSelected] = useState(params.get("id") || "");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [localDetail, setLocalDetail] = useState<SoundCloudTrackDetail | null>(null);
  const [collectionId, setCollectionId] = useState("");
  const [collectionOpen, setCollectionOpen] = useState(false);
  const [collection, setCollection] = useState<CollectionDetail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const abort = new AbortController();
    Promise.all([get<Summary>("summary", abort.signal), get<Collection[]>("collections", abort.signal)])
      .then(([s, c]) => {
        setSummary(s);
        setCollections(c);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      get<{ total: number; items: Entity[] }>(
        `items?${new URLSearchParams({ q: query, service, category, mode, offset: String(offset) })}`,
        abort.signal,
      )
        .then((r) => {
          setList(r);
          setError("");
        })
        .catch((e) => {
          if (e.name !== "AbortError") setError(e.message);
        })
        .finally(() => {
          if (!abort.signal.aborted) setLoading(false);
        });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [query, service, category, offset, mode, revision]);
  useEffect(() => {
    setDetail(null);
    setError("");
    setAssetError("");
    if (!selected) return;
    const abort = new AbortController();
    get<Detail>(`item?id=${encodeURIComponent(selected)}&candidate=${encodeURIComponent(requestedCandidate)}`, abort.signal)
      .then(setDetail)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => abort.abort();
  }, [selected, requestedCandidate, revision]);
  useEffect(() => {
    if (detail && requestedCandidate) document.getElementById(`candidate-${requestedCandidate}`)?.scrollIntoView({ block: "center" });
  }, [detail, requestedCandidate]);
  useEffect(() => {
    setLocalDetail(null);
    if (!detail?.asset?.playable) return;
    let active = true;
    api
      .getTrack(detail.asset.local_track_id)
      .then((value) => {
        if (active) setLocalDetail(value);
      })
      .catch((e) => {
        if (active) setAssetError(e.message);
      });
    return () => {
      active = false;
    };
  }, [detail]);
  useEffect(() => {
    setCollection(null);
    if (!collectionId) return;
    const abort = new AbortController();
    get<CollectionDetail>(`collection?id=${encodeURIComponent(collectionId)}`, abort.signal)
      .then(setCollection)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => abort.abort();
  }, [collectionId]);

  return (
    <div className="scroll-fade-y h-full overflow-y-auto space-y-6 p-6 text-cm-text">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Ενοποιημένη βιβλιοθήκη</h1>
        <p className="max-w-3xl text-sm text-cm-muted">
          Τοπικά αρχεία, SoundCloud και Spotify σε μία προσωπική βιβλιοθήκη. Οι επιβεβαιωμένες συνδέσεις και οι προτάσεις εμφανίζονται
          χωριστά.
        </p>
      </header>
      {providerWorkflows && (
        <a href="/api/identity/calibration" className="inline-block text-sm text-cyan-300 underline">
          Έλεγχος αντιστοιχίσεων · δείγμα 90 προτάσεων
        </a>
      )}
      {error && (
        <p role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3">
          {error}
        </p>
      )}
      {summary && (
        <div className="grid gap-3 sm:grid-cols-3">
          {Object.entries(summary.coverage).map(([s, c]) => (
            <div key={s} className="rounded-xl border border-white/10 bg-white/[.03] p-4">
              <div className="text-sm text-cm-muted">{sources[s]} · παρατηρήσεις πηγών</div>
              <div className="mt-1 text-2xl">{c.total.toLocaleString("el-GR")}</div>
              <div className="mt-2 text-xs text-cm-muted">
                {c.status_ACCEPTED || 0} συνδεδεμένα · {c.status_HIGH_CONFIDENCE || 0} υψηλής εμπιστοσύνης · {c.status_PROBABLE || 0} πιθανά
              </div>
            </div>
          ))}
        </div>
      )}
      <section className="space-y-3 rounded-xl border border-white/10 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-medium">Συλλογές με διατηρημένη σειρά</h2>
          <button className="text-sm text-cyan-300 underline" onClick={() => setCollectionId(summary?.proof_collection_id || "")}>
            Άνοιγμα συλλογής CrateMind
          </button>
        </div>
        <Popover open={collectionOpen} onOpenChange={setCollectionOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-label="Συλλογή"
              aria-expanded={collectionOpen}
              className="w-full min-w-0 justify-between"
            >
              <span className="truncate">
                {collectionId
                  ? (() => {
                      const c = collections.find((c) => c.id === collectionId);
                      return c ? `${sources[c.service]} · ${c.name} (${c.track_count})` : "Συλλογή";
                    })()
                  : `Επιλέξτε συλλογή (${collections.length})`}
              </span>
              <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            collisionPadding={12}
            className="w-[var(--radix-popover-trigger-width)] min-w-[min(320px,calc(100vw-24px))] max-w-[calc(100vw-24px)] overflow-hidden p-0"
          >
            <Command
              filter={(value, search, keywords) => {
                const normalize = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
                const text = normalize(keywords?.join(" ") || value);
                return normalize(search)
                  .trim()
                  .split(/\s+/)
                  .every((word) => text.includes(word))
                  ? 1
                  : 0;
              }}
            >
              <CommandInput aria-label="Αναζήτηση συλλογής" placeholder="Αναζήτηση ονόματος ή πηγής…" />
              <CommandList className="max-h-[min(300px,calc(var(--radix-popover-content-available-height)-48px))]">
                <CommandEmpty>Δεν βρέθηκαν συλλογές.</CommandEmpty>
                <CommandItem
                  value="Χωρίς επιλεγμένη συλλογή"
                  onSelect={() => {
                    setCollectionId("");
                    setCollectionOpen(false);
                  }}
                >
                  Χωρίς επιλεγμένη συλλογή
                </CommandItem>
                {collections.map((c) => (
                  <CommandItem
                    key={c.id}
                    value={c.id}
                    keywords={[
                      c.name,
                      sources[c.service],
                      ...(c.aliases || []),
                      ...(c.source_services || []),
                      ...(c.source_accounts || []),
                    ]}
                    onSelect={() => {
                      setCollectionId(c.id);
                      setCollectionOpen(false);
                    }}
                  >
                    <Check className={`size-4 shrink-0 ${collectionId === c.id ? "opacity-100" : "opacity-0"}`} />
                    <span className="min-w-0 break-words">
                      {sources[c.service]} · {c.name} ({c.track_count})
                    </span>
                  </CommandItem>
                ))}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        {collection && (
          <div>
            <p className="mb-3 text-sm text-cm-muted">
              {collection.entries.length} θέσεις ·{" "}
              {["local_copy", "native"].includes(collection.kind)
                ? "Τοπική συλλογή με αναφορές στις αρχικές πηγές"
                : "Αρχικό στιγμιότυπο πηγής"}
            </p>
            <ol className="divide-y divide-white/10">
              {collection.entries.map((e) => (
                <li key={e.position} className="flex flex-wrap items-center gap-3 py-2">
                  <span className="w-7 text-xs text-cm-muted">{e.position + 1}</span>
                  <button className="min-w-40 flex-1 text-left text-sm hover:text-cyan-300" onClick={() => setSelected(e.id)}>
                    {e.title || e.id}
                  </button>
                  <Status value={e.status} />
                  {e.local_assets.length > 0 ? (
                    e.local_assets.map((a) =>
                      a.missing ? (
                        <span key={a.local_track_id} className="text-xs text-rose-300">
                          Αρχείο σημειωμένο ως απόν
                        </span>
                      ) : (
                        <audio
                          key={a.local_track_id}
                          aria-label={`Αναπαραγωγή ${e.title}`}
                          controls
                          preload="none"
                          className="h-8 w-52"
                          src={`/api/tracks/${a.local_track_id}/audio`}
                        />
                      ),
                    )
                  ) : (
                    <span className="text-xs text-cm-muted">Χωρίς συνδεδεμένο τοπικό αρχείο</span>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}
      </section>
      <div className="flex flex-wrap gap-3">
        <Button
          variant="outline"
          onClick={() => {
            setMode(mode === "recordings" ? "sources" : "recordings");
            setOffset(0);
          }}
        >
          {mode === "recordings" ? "Ηχογραφήσεις · Προβολή πηγών/ιστορικού" : "Πηγές/ιστορικό · Προβολή ηχογραφήσεων"}
        </Button>
        <Input
          aria-label="Αναζήτηση ταυτότητας"
          placeholder="Τίτλος, καλλιτέχνης ή ID…"
          wrapperClassName="min-w-60 flex-1"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOffset(0);
          }}
        />
        <Select
          value={service || "all"}
          onValueChange={(value) => {
            setService(value === "all" ? "" : value);
            setOffset(0);
          }}
        >
          <SelectTrigger aria-label="Πηγή">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value="all">Όλες οι πηγές</SelectItem>
            {Object.entries(sources)
              .filter(([s]) => s !== "cratemind")
              .map(([s, label]) => (
                <SelectItem key={s} value={s}>
                  {label}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <Select
          value={category || "all"}
          onValueChange={(value) => {
            setCategory(value === "all" ? "" : value);
            setOffset(0);
          }}
        >
          <SelectTrigger aria-label="Κατάσταση συμφωνίας">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value="all">Όλες οι καταστάσεις</SelectItem>
            {Object.entries(labels).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
            <SelectItem value="unresolved">Ανεπίλυτες αναφορές</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="grid items-start gap-6 xl:grid-cols-2">
        <section className="rounded-xl border border-white/10">
          <div className="flex items-center justify-between border-b border-white/10 p-3 text-xs text-cm-muted">
            <span>
              {loading
                ? "Φόρτωση…"
                : `${list.total.toLocaleString("el-GR")} ${mode === "recordings" ? "ηχογραφήσεις" : "παρατηρήσεις πηγών"}`}
              {!loading && mode === "recordings" && !category && summary?.unresolved_placeholders ? (
                <span title="Αναγνωριστικά χωρίς τίτλο ή άλλα στοιχεία κομματιού. Κρατούν τη θέση τους σε μια λίστα ή στα Likes, αλλά δεν μετρούν ως γνωστές ηχογραφήσεις.">
                  {" "}
                  · {summary.unresolved_placeholders.toLocaleString("el-GR")} ανεπίλυτες αναφορές εκτός λίστας
                </span>
              ) : null}
            </span>
            <div className="flex gap-4">
              <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))} className="disabled:opacity-30">
                Προηγούμενα
              </button>
              <button disabled={offset + 50 >= list.total} onClick={() => setOffset(offset + 50)} className="disabled:opacity-30">
                Επόμενα
              </button>
            </div>
          </div>
          <ul className="divide-y divide-white/10">
            {list.items.map((e) => (
              <li key={e.id}>
                <button
                  onClick={() => setSelected(e.id)}
                  className={`w-full space-y-1 p-3 text-left transition hover:bg-white/5 ${selected === e.id ? "bg-cyan-500/10" : ""}`}
                >
                  <div className="text-sm">{e.title || e.id}</div>
                  <div className="text-xs text-cm-muted">
                    {e.artist || "Άγνωστος καλλιτέχνης"} · {sources[e.service]}
                  </div>
                  <Status value={e.status} />
                </button>
              </li>
            ))}
          </ul>
          {!loading && !list.items.length && <p className="p-6 text-sm text-cm-muted">Δεν βρέθηκαν εγγραφές για αυτά τα φίλτρα.</p>}
        </section>
        <section className="space-y-5 rounded-xl border border-white/10 p-4">
          {!detail ? (
            <p className="text-sm text-cm-muted">Επιλέξτε ένα κομμάτι για αρχεία, πηγές, συλλογές και στοιχεία συμφωνίας.</p>
          ) : (
            <>
              <div>
                <h2 className="text-lg font-medium">{detail.title || detail.id}</h2>
                <p className="text-sm text-cm-muted">{detail.artist}</p>
                <Status value={detail.status} />
                <div className="mt-2">
                  <SourceLink entity={detail} />
                </div>
              </div>
              {assetError && <p className="text-sm text-red-400">{assetError}</p>}
              {!detail.asset?.retired && (
                <IdentityLinker entityId={detail.id} entityService={detail.service} onChanged={() => setRevision((v) => v + 1)} />
              )}{" "}
              {localDetail && (
                <section aria-label="Υπάρχουσα απόφαση SoundCloud">
                  <p className="mb-2 text-xs text-cm-muted">SoundCloud μέσω κανονικής ταυτότητας</p>
                  <SoundCloudCard
                    soundcloud={localDetail.soundcloud}
                    candidates={localDetail.soundcloud_candidates}
                    fallbackSeed={localDetail.track.id}
                  />
                  <a
                    className="mt-2 block text-xs text-cyan-300 underline"
                    href={`/library?q=${encodeURIComponent(localDetail.track.title || localDetail.track.file_name)}`}
                  >
                    Άνοιγμα στην υπάρχουσα βιβλιοθήκη και στον έλεγχο SoundCloud
                  </a>
                </section>
              )}
              <section>
                <h3 className="mb-2 text-sm font-medium">Συνδεδεμένες αναπαραστάσεις</h3>
                <p className="mb-2 text-xs text-cm-muted">Οι προτάσεις δεν έχουν συγχωνευθεί με αυτές τις εγγραφές.</p>
                {detail.representations.map((e) => (
                  <div key={e.id} className="space-y-2 border-t border-white/10 py-3">
                    <button onClick={() => setSelected(e.id)} className="block text-left text-sm hover:text-cyan-300">
                      {e.title || e.id}
                    </button>
                    <SourceLink entity={e} />
                    {e.retired && (
                      <div className="text-xs text-cm-muted">
                        Αφαιρέθηκε κατά την αποδιπλοποίηση.{" "}
                        {e.lifecycle?.survivor_id && (
                          <button className="underline" onClick={() => setSelected(e.lifecycle!.survivor_id!)}>
                            Άνοιγμα αρχείου που διατηρήθηκε
                          </button>
                        )}
                        <button
                          className="ml-2 underline"
                          onClick={async () => {
                            await fetch("/api/identity/retire-asset", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ entity_id: e.id, restore: true }),
                            });
                            setRevision((v) => v + 1);
                          }}
                        >
                          Επαναφορά ορατότητας (όχι αρχείου)
                        </button>
                      </div>
                    )}
                    {Boolean(e.missing) && !e.retired && <p className="text-xs text-rose-300">Αρχείο σημειωμένο ως απόν στον κατάλογο.</p>}
                    {Boolean(e.local_track_id) && e.playable && !e.retired && (
                      <audio
                        aria-label={`Τοπικό αρχείο ${e.local_track_id}`}
                        controls
                        preload="none"
                        className="h-9 w-full"
                        src={`/api/tracks/${e.local_track_id}/audio`}
                      />
                    )}
                  </div>
                ))}
              </section>
              <section>
                <h3 className="mb-2 text-sm font-medium">Υποψήφιες συνδέσεις ({detail.candidates.length})</h3>
                <p className="mb-2 text-xs text-cm-muted">
                  Η βαθμολογία συνοψίζει στοιχεία· δεν είναι πιθανότητα ορθότητας. Η αμφιβολία παραμένει για έλεγχο.
                </p>
                {detail.candidates.map((c) => (
                  <details
                    open={c.other_id === requestedCandidate || undefined}
                    id={`candidate-${c.other_id}`}
                    key={c.other_id}
                    className="border-t border-white/10 py-3"
                  >
                    <summary className="cursor-pointer text-sm">
                      <Status value={c.class} /> <span className="ml-2">{c.other_title || c.other_id}</span>
                      <span className="ml-2 text-xs text-cm-muted">
                        {c.score}/100 · {sources[c.other_service]}
                      </span>
                    </summary>
                    <div className="mt-3 space-y-2 text-xs text-cm-muted">
                      <p>
                        Τίτλος: {Math.round(c.evidence.title_similarity * 100)}/100 · Καλλιτέχνης:{" "}
                        {Math.round(c.evidence.artist_similarity * 100)}/100 · Διαφορά διάρκειας:{" "}
                        {c.evidence.duration_delta_seconds == null ? "άγνωστη" : `${c.evidence.duration_delta_seconds.toFixed(1)} s`}
                      </p>
                      {c.evidence.isrc_equal && <p>Κοινό ISRC</p>}
                      {c.evidence.anchor && <p>Υπάρχον στοιχείο: {c.evidence.anchor.method}</p>}
                      {c.evidence.conflicts.length > 0 && <p className="text-rose-300">{c.evidence.conflicts.join(" · ")}</p>}
                      {c.evidence.near_tie_review && <p>Πολλές κοντινές προτάσεις· χρειάζεται έλεγχος έκδοσης.</p>}
                      <IdentityLinker
                        entityId={detail.id}
                        entityService={detail.service}
                        targetId={c.other_id}
                        targetService={c.other_service}
                        onChanged={() => setRevision((v) => v + 1)}
                      />
                      <button className="text-cyan-300 underline" onClick={() => setSelected(c.other_id)}>
                        Άνοιγμα άλλης εγγραφής
                      </button>
                    </div>
                  </details>
                ))}
              </section>
              <section>
                <h3 className="mb-2 text-sm font-medium">Συλλογές ({detail.memberships.length})</h3>
                {detail.memberships.map((m) => (
                  <button
                    key={`${m.id}:${m.position}`}
                    onClick={() => setCollectionId(m.id)}
                    className="block py-1 text-left text-xs text-cyan-300"
                  >
                    {m.name} · θέση {m.position + 1}
                  </button>
                ))}
              </section>
              <details className="text-xs text-cm-muted">
                <summary className="cursor-pointer">Μεταδεδομένα και κανονικοποίηση</summary>
                <pre className="mt-3 whitespace-pre-wrap break-all">
                  {JSON.stringify(
                    {
                      id: detail.id,
                      versions: detail.normalized.versions,
                      title_variants: detail.normalized.title_variants,
                      metadata: detail.metadata,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
