/**
 * Edge state for the `scroll-fade`, `scroll-fade-y` and `scroll-fade-b` utilities (index.css). The desktop WebView
 * does not run the scroll-driven CSS animations these used, so one capture-phase scroll listener marks any scrolled
 * fade element with `data-at-top` / `data-at-bottom`, and a frame-batched MutationObserver re-checks them all when
 * content changes (lists load, rows appear) or the window resizes. The CSS shows a fade only on the "false" side.
 */
const SELECTOR = ".scroll-fade, .scroll-fade-y, .scroll-fade-b";

export function scrollEdges(scrollTop: number, clientHeight: number, scrollHeight: number): { atTop: boolean; atBottom: boolean } {
  return { atTop: scrollTop <= 1, atBottom: scrollTop + clientHeight >= scrollHeight - 2 };
}

function update(el: HTMLElement) {
  const { atTop, atBottom } = scrollEdges(el.scrollTop, el.clientHeight, el.scrollHeight);
  const top = String(atTop), bottom = String(atBottom);
  if (el.dataset.atTop !== top) el.dataset.atTop = top;
  if (el.dataset.atBottom !== bottom) el.dataset.atBottom = bottom;
}

export function installScrollFades(doc: Document = document): () => void {
  let frame = 0;
  const checkAll = () => {
    frame = 0;
    doc.querySelectorAll<HTMLElement>(SELECTOR).forEach(update);
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(checkAll); };
  const onScroll = (event: Event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.matches(SELECTOR)) update(target);
  };
  doc.addEventListener("scroll", onScroll, { capture: true, passive: true });
  window.addEventListener("resize", schedule);
  // childList only: our own data-* writes are attribute changes and never retrigger this.
  const observer = new MutationObserver(schedule);
  observer.observe(doc.body, { childList: true, subtree: true });
  schedule();
  return () => {
    doc.removeEventListener("scroll", onScroll, { capture: true });
    window.removeEventListener("resize", schedule);
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
  };
}
