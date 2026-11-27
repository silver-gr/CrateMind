/**
 * Marks whatever is scrolling with `data-scrolling`, so its scrollbar can light up (index.css: the app's cyan with a soft
 * halo) and go quiet again `SCROLL_GLOW_MS` after the last scroll event. One capture-phase listener covers every scroll
 * container, present and future; a page scroll marks the root element. Only the element that scrolls is marked.
 */
export const SCROLL_GLOW_MS = 700;

export function installScrollGlow(doc: Document = document): () => void {
  const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  const onScroll = (event: Event) => {
    const target = event.target;
    // A scroll's target is the document (the page) or the element; anything without a dataset (an SVG part) is left alone.
    const el = target === doc ? doc.documentElement : (target as Partial<HTMLElement> | null)?.dataset ? (target as HTMLElement) : null;
    if (!el) return;
    const pending = timers.get(el);
    if (pending === undefined) el.dataset.scrolling = "";
    else clearTimeout(pending);
    timers.set(el, setTimeout(() => {
      timers.delete(el);
      delete el.dataset.scrolling;
    }, SCROLL_GLOW_MS));
  };
  doc.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => {
    doc.removeEventListener("scroll", onScroll, { capture: true });
    for (const [el, timer] of timers) {
      clearTimeout(timer);
      delete el.dataset.scrolling;
    }
    timers.clear();
  };
}
