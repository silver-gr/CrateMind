// «Λεξικό όρων»'s contents panel (pages/Glossary.tsx): when it fits beside the cards, and which term is in view.

/** The contents panel's width in the shell's right rail. */
export const GLOSSARY_RAIL_WIDTH = 248;
/** The page and the panel together need this much, so the cards keep a comfortable column beside the panel. */
export const GLOSSARY_RAIL_MIN_TOTAL = 1000;

/**
 * Whether the contents sit in the right rail. The page's own width leaves out a railed panel, so the switch point is the
 * same both ways (as `librarySideBySide` does for the Library's inspector) and the panel never flickers in and out.
 */
export function glossaryRailed(pageWidth: number, railed: boolean): boolean {
  return (railed ? pageWidth + GLOSSARY_RAIL_WIDTH : pageWidth) >= GLOSSARY_RAIL_MIN_TOTAL;
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
