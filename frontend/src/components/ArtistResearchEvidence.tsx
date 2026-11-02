import type { ArtistProfile, ArtistResearch } from "../lib/types";

export function safeArtistSourceUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    // Research links must point to public websites, never local services or IP literals.
    if (!hostname.includes(".") || hostname.includes(":") || hostname.includes("[") || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return null;
    if (["localhost", "local", "internal", "home", "lan"].some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`))) return null;
    return url;
  } catch {
    return null;
  }
}

export function canAcceptArtistCandidate(candidate: Partial<ArtistProfile> | null | undefined, reviewState?: string): boolean {
  if (!candidate) return false;
  // Historical profile comparisons predate genre research and keep their review path.
  return !candidate.research || ((!reviewState || reviewState === "ready") && candidate.research.status === "classified" && !!candidate.primary_subgenre?.trim());
}

export function ArtistResearchEvidence({ research, needsReview = false }: { research: ArtistResearch; needsReview?: boolean }) {
  const status = research.status === "classified"
    ? "Πρόταση είδους από πηγές"
    : research.status === "outside_list"
      ? "Είδος εκτός της διαθέσιμης λίστας"
      : "Δεν προέκυψε ασφαλής ταξινόμηση";
  const sources = research.sources.flatMap(source => {
    const url = safeArtistSourceUrl(source.url);
    return url ? [{ ...source, url }] : [];
  });

  return (
    <div className="space-y-2 text-xs">
      {research.manual_genre && <p className="font-medium text-cm-cyan">Χειροκίνητα επιβεβαιωμένο είδος: {research.manual_genre}</p>}
      <p className={research.status === "classified" ? "font-medium text-cm-text" : "font-medium text-cm-amber"}>
        {research.manual_genre ? `Αρχικό εύρημα έρευνας: ${status}` : status}
      </p>
      {research.outside_genre && <p className="text-cm-muted">Είδος που βρέθηκε: {research.outside_genre}</p>}
      <p className="whitespace-pre-line break-words text-cm-muted">{research.manual_genre ? `Αρχικό σκεπτικό έρευνας: ${research.reason}` : research.reason}</p>
      {needsReview && research.status !== "classified" && <p className="text-cm-faint">Έλεγξε τις πηγές και όρισε το είδος χειροκίνητα για επιβεβαίωση.</p>}
      {sources.length > 0 ? (
        <ul aria-label="Πηγές για το μουσικό είδος" className="space-y-2">
          {sources.map((source, index) => (
            <li key={`${source.url.href}-${index}`} className="min-w-0">
              <a href={source.url.href} target="_blank" rel="noopener noreferrer" className="break-words text-cm-cyan underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
                {source.url.hostname}
              </a>
              {source.evidence && <p className="mt-0.5 whitespace-pre-line break-words text-cm-muted">{source.evidence}</p>}
            </li>
          ))}
        </ul>
      ) : <p className="text-cm-faint">Δεν υπάρχουν διαθέσιμοι σύνδεσμοι πηγών.</p>}
    </div>
  );
}
