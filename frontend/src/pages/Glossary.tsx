import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { EmptyState } from "../components/ui/EmptyState";
import { GlassPanel } from "../components/ui/GlassPanel";
import { Input } from "../components/ui/input";
import { PageHeader } from "../components/ui/PageHeader";
import { cn } from "../lib/cn";
import { MAXIMIZER_BUILT } from "../lib/audio/maximizer";
import { filterGlossary, glossaryFor } from "../lib/glossary";
import { GLOSSARY_RAIL_WIDTH, glossaryRailed, termInView } from "../lib/glossaryContents";
import { PageRail, PageRailContext } from "../lib/pageRail";
import { BookOpen, Search } from "../lib/icons";

// Without the Maximizer (every CI and release build) its entry and every mention of «MAX» are left out.
const GLOSSARY = glossaryFor(MAXIMIZER_BUILT);

const PARTS = [
  { key: "what", label: "Τι είναι" },
  { key: "hear", label: "Τι ακούς ή βλέπεις" },
  { key: "act", label: "Τι κάνεις στο CrateMind" },
] as const;

/** Air between the sticky header and a card scrolled to, and how far under the header a card counts as the one in view. */
const LANDING_GAP = 12;
const IN_VIEW_SLACK = 24;

/** Text with `search syntax` between backticks shown as code. */
function Prose({ text }: { text: string }) {
  return <>{text.split("`").map((part, i) => i % 2 ? <code key={i} className="rounded bg-cm-contrast/8 px-1 font-mono text-[0.92em] text-cm-text">{part}</code> : part)}</>;
}

function SearchField({ query, onChange, compact }: { query: string; onChange: (value: string) => void; compact?: boolean }) {
  return (
    <label className="relative block">
      <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-cm-muted" />
      <Input value={query} onChange={e => onChange(e.target.value)} placeholder={compact ? "Φίλτρο όρων" : "Αναζήτηση όρου (π.χ. LUFS, μπάσα, Sync)"}
        aria-label="Αναζήτηση όρου" className={cn("pl-9", compact && "h-8 text-sm")} />
    </label>
  );
}

export default function Glossary() {
  const location = useLocation();
  const [query, setQuery] = useState("");
  const queryRef = useRef(query);
  queryRef.current = query;
  const target = decodeURIComponent(location.hash.slice(1));
  const terms = filterGlossary(GLOSSARY, query);
  const termName = (id: string) => GLOSSARY.find(t => t.id === id)?.term ?? id;
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentsRef = useRef<HTMLElement>(null);
  const [active, setActive] = useState<string | null>(null);

  // Wide enough, the contents sit in the shell's right rail (beside a dock in the page column they run to the window's
  // bottom); narrower, the term chips above the cards stand in for them.
  const railAvailable = useContext(PageRailContext) !== null;
  const [railed, setRailed] = useState(true);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !railAvailable) { setRailed(false); return; }
    const update = () => setRailed(now => glossaryRailed(el.getBoundingClientRect().width, now));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [railAvailable]);

  /** The sticky header's height: the scroller's top edge to the header's bottom. */
  const headerBottom = useCallback(() => scrollRef.current?.querySelector("header")?.getBoundingClientRect().height ?? 0, []);

  const updateActive = useCallback(() => {
    const box = scrollRef.current;
    if (!box) return;
    const boxTop = box.getBoundingClientRect().top;
    const cards = Array.from(box.querySelectorAll<HTMLElement>("[data-term-card]"), el => ({ id: el.id, top: el.getBoundingClientRect().top - boxTop }));
    const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 2;
    setActive(termInView(cards, headerBottom() + LANDING_GAP + IN_VIEW_SLACK, atEnd, decodeURIComponent(window.location.hash.slice(1))));
  }, [headerBottom]);

  // A link to /glossary#term (another page, a «Δες επίσης», the contents) scrolls that card to just under the sticky header.
  // A filter that hides the card is cleared first; one that shows it stays.
  useEffect(() => {
    if (!target) return;
    if (!filterGlossary(GLOSSARY, queryRef.current).some(t => t.id === target)) setQuery("");
    const frame = requestAnimationFrame(() => {
      const box = scrollRef.current;
      const card = document.getElementById(target);
      if (!box || !card) return;
      box.scrollTop += card.getBoundingClientRect().top - box.getBoundingClientRect().top - headerBottom() - LANDING_GAP;
      updateActive();
    });
    return () => cancelAnimationFrame(frame);
  }, [target, location.key, headerBottom, updateActive]);

  // The term in view, re-read once per frame while the page scrolls and whenever the list changes.
  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    let frame = 0;
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; updateActive(); }); };
    updateActive();
    box.addEventListener("scroll", onScroll, { passive: true });
    return () => { box.removeEventListener("scroll", onScroll); cancelAnimationFrame(frame); };
  }, [updateActive, query, railed]);

  // Keep the highlighted entry visible in a long contents list (the list scrolls itself, never the page).
  useEffect(() => {
    const list = contentsRef.current;
    const item = active ? list?.querySelector<HTMLElement>(`[data-term="${active}"]`) : null;
    if (!list || !item) return;
    const top = item.offsetTop;
    if (top < list.scrollTop + 8) list.scrollTop = top - 8;
    else if (top + item.offsetHeight > list.scrollTop + list.clientHeight - 8) list.scrollTop = top + item.offsetHeight - list.clientHeight + 8;
  }, [active]);

  return (
    <div ref={scrollRef} className="@container/glossary scroll-fade-b h-full overflow-y-auto">
      <PageHeader sticky icon={BookOpen} title="Λεξικό όρων" count={query ? `${terms.length} από ${GLOSSARY.length}` : GLOSSARY.length}
        subtitle="Οι όροι που χρησιμοποιεί η εφαρμογή, με απλά λόγια: τι είναι, τι ακούς και τι κάνεις γι' αυτό εδώ."
        className="px-4 sm:px-6" />
      {/* On a wide page the name and «Δες επίσης» sit beside the text, whose lines stay under about 85 characters. */}
      <div className="mx-auto max-w-4xl space-y-4 px-4 pt-5 pb-28 sm:px-6 @4xl/glossary:max-w-[60rem]">
        {!railed && (
          <>
            <SearchField query={query} onChange={setQuery} />
            {terms.length > 0 && (
              <nav aria-label="Περιεχόμενα λεξικού" className="flex flex-wrap gap-1.5">
                {terms.map(t => (
                  <Link key={t.id} to={`#${t.id}`} className="rounded-full border border-cm-border bg-cm-contrast/5 px-2.5 py-0.5 text-xs text-cm-muted hover:border-cm-cyan/40 hover:text-cm-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cm-cyan">
                    {t.term}
                  </Link>
                ))}
              </nav>
            )}
          </>
        )}
        {terms.length === 0 ? (
          <EmptyState icon={Search} title="Κανένας όρος δεν ταιριάζει">Δοκίμασε μια άλλη λέξη ή σβήσε την αναζήτηση.</EmptyState>
        ) : terms.map(t => (
          <GlassPanel key={t.id} id={t.id} data-term-card aria-labelledby={`${t.id}-title`}
            className={cn("p-4 sm:p-5 @4xl/glossary:grid @4xl/glossary:grid-cols-[11rem_minmax(0,1fr)] @4xl/glossary:grid-rows-[auto_1fr] @4xl/glossary:gap-x-6",
              t.id === target && "ring-1 ring-cm-cyan/50")}>
            <h2 id={`${t.id}-title`} className="text-base font-semibold text-balance text-cm-text @4xl/glossary:col-start-1 @4xl/glossary:row-start-1">{t.term}</h2>
            <dl className="mt-3 max-w-[78ch] space-y-3 text-sm leading-relaxed @4xl/glossary:col-start-2 @4xl/glossary:row-span-2 @4xl/glossary:row-start-1 @4xl/glossary:mt-0">
              {PARTS.map(p => (
                <div key={p.key}>
                  <dt className="text-xs font-medium text-cm-cyan">{p.label}</dt>
                  <dd className="mt-0.5 text-pretty text-cm-text/90"><Prose text={t[p.key]} /></dd>
                </div>
              ))}
            </dl>
            {t.see && t.see.length > 0 && (
              <p className="mt-3 text-xs text-cm-muted @4xl/glossary:col-start-1 @4xl/glossary:row-start-2 @4xl/glossary:mt-2 @4xl/glossary:self-start">
                Δες επίσης:{" "}
                {t.see.map((id, i) => (
                  <span key={id}>{i > 0 && " · "}<Link to={`#${id}`} className="text-cm-cyan underline-offset-2 hover:underline">{termName(id)}</Link></span>
                ))}
              </p>
            )}
          </GlassPanel>
        ))}
      </div>
      {railed && (
        <PageRail>
          <aside aria-label="Περιεχόμενα" style={{ width: `${GLOSSARY_RAIL_WIDTH}px` }}
            className="flex h-full min-h-0 shrink-0 flex-col border-l border-cm-contrast/10 bg-cm-bg-2/40">
            <div className="shrink-0 border-b border-cm-contrast/8 p-3">
              <SearchField query={query} onChange={setQuery} compact />
            </div>
            <nav ref={contentsRef} aria-label="Περιεχόμενα λεξικού" className="scroll-fade-y relative min-h-0 flex-1 overflow-y-auto p-2">
              {terms.length === 0 ? (
                <p className="px-2 py-3 text-xs text-cm-muted">Κανένας όρος δεν ταιριάζει.</p>
              ) : (
                <ol className="space-y-px">
                  {terms.map(t => (
                    <li key={t.id}>
                      <Link to={`#${t.id}`} data-term={t.id} aria-current={t.id === active ? "location" : undefined}
                        className={cn("block truncate rounded-md px-2 py-1 text-[13px] transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-cm-cyan",
                          t.id === active ? "bg-cm-cyan/10 font-medium text-cm-cyan" : "text-cm-muted hover:bg-cm-contrast/5 hover:text-cm-text")}>
                        {t.term}
                      </Link>
                    </li>
                  ))}
                </ol>
              )}
            </nav>
          </aside>
        </PageRail>
      )}
    </div>
  );
}
