import { useId, useState } from "react";
import type { ArtistProfile } from "../lib/types";
import { ARTIST_GENRES, type ArtistGenreResult } from "../lib/artistGenreResults";
import { ArtistResearchEvidence, safeArtistSourceUrl } from "./ArtistResearchEvidence";
import { GlassPanel } from "./ui/GlassPanel";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

interface ArtistGenreResultCardProps {
  artist: ArtistProfile;
  result: ArtistGenreResult;
  disabled?: boolean;
  onLibrary: () => void;
  onConfirm: (choice: "candidate" | "current" | "manual", genre?: string) => void | Promise<void>;
}

const confidenceGreek: Record<string, string> = { high: "υψηλή", medium: "μέτρια", low: "χαμηλή" };

export function ArtistGenreResultCard({ artist, result, disabled, onLibrary, onConfirm }: ArtistGenreResultCardProps) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [genre, setGenre] = useState<string>(ARTIST_GENRES.some(value => value === result.primaryGenre) ? result.primaryGenre! : "other");
  const [customGenre, setCustomGenre] = useState(result.primaryGenre || result.research.outside_genre || "");
  const editorId = useId();
  const locked = disabled || saving;
  const selectedGenre = genre === "other" ? customGenre.trim() : genre;
  const sourceCount = result.research.sources.filter(source => safeArtistSourceUrl(source.url)).length;
  const canConfirm = result.research.status === "classified" && !!result.primaryGenre;

  async function confirm(choice: "candidate" | "current" | "manual", manualGenre?: string) {
    setSaving(true);
    setError("");
    try {
      await onConfirm(choice, manualGenre);
      setEditing(false);
    } catch {
      setError("Η επιβεβαίωση δεν ολοκληρώθηκε. Δοκίμασε ξανά.");
    } finally { setSaving(false); }
  }

  return (
    <GlassPanel strong data-artist-result={artist.id} data-result-model="gpt-6-luna" className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-sm font-semibold text-cm-text">{artist.canonical_name}</h2>
          <p className="mt-1 text-xs text-cm-faint">{artist.track_count.toLocaleString("el-GR")} κομμάτια</p>
        </div>
        <Button variant="outline" size="sm" onClick={onLibrary}>Βιβλιοθήκη</Button>
      </div>

      <div className="mt-4 space-y-1.5">
        {result.primaryGenre ? <p className="break-words text-lg font-semibold text-cm-text">{result.primaryGenre}</p>
          : <p className="font-medium text-cm-amber">{result.research.status === "outside_list" ? "Είδος εκτός της διαθέσιμης λίστας" : "Δεν προέκυψε ασφαλής ταξινόμηση"}</p>}
        {!result.primaryGenre && result.research.status === "outside_list" && result.research.outside_genre && <p className="text-sm text-cm-muted">Είδος που βρέθηκε: {result.research.outside_genre}</p>}
        {result.secondaryGenres.length > 0 && <p className="break-words text-xs text-cm-muted">Συγγενικά είδη: {result.secondaryGenres.join(" · ")}</p>}
        {!result.confirmed && result.choice === "candidate" && result.confidence && <p className="text-xs text-cm-faint">Βεβαιότητα έρευνας: {confidenceGreek[result.confidence]}</p>}
      </div>

      {result.confirmed ? <p className="mt-4 text-xs text-cm-cyan">Επιβεβαιωμένο · προστατεύεται από enrichment</p> : !artist.review ? <p className="mt-4 text-xs text-cm-muted">Αποτέλεσμα έρευνας Luna</p> : <div className="mt-4">
        {!editing ? <div className="flex flex-wrap gap-2">
          {canConfirm ? <>
            <Button size="sm" disabled={locked} onClick={() => confirm(result.choice)}>Επιβεβαίωση είδους</Button>
            <Button variant="outline" size="sm" disabled={locked} aria-expanded={false} aria-controls={editorId} onClick={() => setEditing(true)}>Διόρθωση</Button>
          </> : <Button size="sm" disabled={locked} aria-expanded={false} aria-controls={editorId} onClick={() => setEditing(true)}>Ορισμός είδους</Button>}
        </div> : <form id={editorId} className="space-y-2" onSubmit={event => { event.preventDefault(); if (selectedGenre && !locked) void confirm("manual", selectedGenre); }}>
          <label htmlFor={`${editorId}-genre`} className="block text-xs text-cm-muted">Μουσικό είδος</label>
          <Select value={genre} onValueChange={setGenre} disabled={locked}>
            <SelectTrigger id={`${editorId}-genre`} className="w-full"><SelectValue placeholder="Επίλεξε είδος" /></SelectTrigger>
            <SelectContent>{ARTIST_GENRES.map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}<SelectItem value="other">Άλλο είδος</SelectItem></SelectContent>
          </Select>
          {genre === "other" && <Input aria-label="Άλλο μουσικό είδος" placeholder="Γράψε το μουσικό είδος…" value={customGenre} disabled={locked} maxLength={200} onChange={event => setCustomGenre(event.target.value)} autoFocus />}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={locked || !selectedGenre}>Επιβεβαίωση είδους</Button>
            <Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => setEditing(false)}>Ακύρωση</Button>
          </div>
        </form>}
        {error && <p role="alert" className="mt-2 text-xs text-cm-amber">{error}</p>}
      </div>}

      <details className="mt-4 border-t border-cm-line/20 pt-3">
        <summary className="cursor-pointer text-xs text-cm-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">Αιτιολόγηση και πηγές ({sourceCount})</summary>
        <div className="mt-3"><ArtistResearchEvidence research={result.research} /></div>
      </details>
    </GlassPanel>
  );
}
