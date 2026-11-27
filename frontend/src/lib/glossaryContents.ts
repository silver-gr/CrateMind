// «Λεξικό όρων»'s contents panel (pages/Glossary.tsx): when it fits beside the cards, and which term is in view.

/** The contents panel's width: a left column inside the page, under the page header (never in the shell's rails). */
export const GLOSSARY_RAIL_WIDTH = 248;
/** The page needs this much for the panel and the cards together, so the cards keep a comfortable column beside it. */
export const GLOSSARY_RAIL_MIN_TOTAL = 1000;

/** Whether the contents panel shows beside the cards; narrower, the term chips above the cards stand in for it. */
export function glossaryRailed(pageWidth: number): boolean {
  return pageWidth >= GLOSSARY_RAIL_MIN_TOTAL;
}

/**
 * The term in view: the last card whose top has reached `line` (just under the sticky header), the first card before
 * any has. At the page's end the last cards can never reach the line: there it is the term the address points at
 * (`pinned`, the one just opened from the contents) while its card shows, else the last card.
 * `cards` are in page order with their tops in the same coordinates as `line` (0 is the scroller's top edge).
 */
export function termInView(cards: readonly { id: string; top: number }[], line: number, atEnd: boolean, pinned?: string | null): string | null {
  if (cards.length === 0) return null;
  if (atEnd) return cards.find(card => card.id === pinned && card.top >= 0)?.id ?? cards[cards.length - 1].id;
  let current = cards[0].id;
  for (const card of cards) {
    if (card.top > line) break;
    current = card.id;
  }
  return current;
}
