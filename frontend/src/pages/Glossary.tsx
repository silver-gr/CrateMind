import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { EmptyState } from "../components/ui/EmptyState";
import { GlassPanel } from "../components/ui/GlassPanel";
import { Input } from "../components/ui/input";
import { PageHeader } from "../components/ui/PageHeader";
import { cn } from "../lib/cn";
import { MAXIMIZER_BUILT } from "../lib/audio/maximizer";
import { filterGlossary, glossaryFor } from "../lib/glossary";
import { BookOpen, Search } from "../lib/icons";

// Without the Maximizer (every CI and release build) its entry and every mention of «MAX» are left out.
const GLOSSARY = glossaryFor(MAXIMIZER_BUILT);

const PARTS = [
  { key: "what", label: "Τι είναι" },
  { key: "hear", label: "Τι ακούς ή βλέπεις" },
  { key: "act", label: "Τι κάνεις στο CrateMind" },
] as const;

/** Text with `search syntax` between backticks shown as code. */
function Prose({ text }: { text: string }) {
  return <>{text.split("`").map((part, i) => i % 2 ? <code key={i} className="rounded bg-cm-contrast/8 px-1 font-mono text-[0.92em] text-cm-text">{part}</code> : part)}</>;
}

export default function Glossary() {
  const location = useLocation();
  const [query, setQuery] = useState("");
  const target = decodeURIComponent(location.hash.slice(1));
  const terms = filterGlossary(GLOSSARY, query);
  const termName = (id: string) => GLOSSARY.find(t => t.id === id)?.term ?? id;

  // A link to /glossary#term (from another page or a «Δες επίσης») shows the whole list and scrolls to that entry.
  useEffect(() => {
    if (!target) return;
    setQuery("");
    const frame = requestAnimationFrame(() => document.getElementById(target)?.scrollIntoView({ block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, [target, location.key]);

  return (
    <div className="scroll-fade-b h-full overflow-y-auto">
      <PageHeader sticky icon={BookOpen} title="Λεξικό όρων" count={query ? `${terms.length} από ${GLOSSARY.length}` : GLOSSARY.length}
        subtitle="Οι όροι που χρησιμοποιεί η εφαρμογή, με απλά λόγια: τι είναι, τι ακούς και τι κάνεις γι' αυτό εδώ."
        className="px-4 sm:px-6" />
      <div className="mx-auto max-w-4xl space-y-4 px-4 pt-5 pb-28 sm:px-6">
        <label className="relative block">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-cm-muted" />
          <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="Αναζήτηση όρου (π.χ. LUFS, μπάσα, Sync)"
            aria-label="Αναζήτηση όρου" className="pl-9" />
        </label>
        {terms.length > 0 && (
          <nav aria-label="Όροι" className="flex flex-wrap gap-1.5">
            {terms.map(t => (
              <Link key={t.id} to={`#${t.id}`} className="rounded-full border border-cm-border bg-cm-contrast/5 px-2.5 py-0.5 text-xs text-cm-muted hover:border-cm-cyan/40 hover:text-cm-text">
                {t.term}
              </Link>
            ))}
          </nav>
        )}
        {terms.length === 0 ? (
          <EmptyState icon={Search} title="Κανένας όρος δεν ταιριάζει">Δοκίμασε μια άλλη λέξη ή σβήσε την αναζήτηση.</EmptyState>
        ) : terms.map(t => (
          <GlassPanel key={t.id} id={t.id} aria-labelledby={`${t.id}-title`}
            className={cn("scroll-mt-24 p-4 sm:p-5", t.id === target && "ring-1 ring-cm-cyan/50")}>
            <h2 id={`${t.id}-title`} className="text-base font-semibold text-cm-text">{t.term}</h2>
            <dl className="mt-3 space-y-3 text-sm leading-relaxed">
              {PARTS.map(p => (
                <div key={p.key}>
                  <dt className="text-xs font-medium text-cm-cyan">{p.label}</dt>
                  <dd className="mt-0.5 text-pretty text-cm-text/90"><Prose text={t[p.key]} /></dd>
                </div>
              ))}
            </dl>
            {t.see && t.see.length > 0 && (
              <p className="mt-3 text-xs text-cm-muted">
                Δες επίσης:{" "}
                {t.see.map((id, i) => (
                  <span key={id}>{i > 0 && " · "}<Link to={`#${id}`} className="text-cm-cyan underline-offset-2 hover:underline">{termName(id)}</Link></span>
                ))}
              </p>
            )}
          </GlassPanel>
        ))}
      </div>
    </div>
  );
}
