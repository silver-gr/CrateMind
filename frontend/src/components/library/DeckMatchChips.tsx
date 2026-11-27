import { SmartChip } from "../ui/SmartChip";
import { Link2 } from "../../lib/icons";
import { deckMatchTerms, termsActive, toggleTerms } from "../../lib/libraryExtras";
import { usePlayer, type DeckId } from "../../lib/player";

/**
 * «Ταιριάζει με το Deck A/B»: one chip per loaded deck that adds (or, clicked again, removes) a tempo and key filter.
 * In the Library toolbar's first row; under 42rem of toolbar the words before «Deck A» are left to screen readers.
 */
export function DeckMatchChips({ query, onApply }: { query: string; onApply: (q: string) => void }) {
  const { slots } = usePlayer();
  const decks = (["A", "B"] as DeckId[]).flatMap(deck => {
    const track = slots[deck].track;
    const terms = track ? deckMatchTerms(track) : [];
    return track && terms.length ? [{ deck, track, terms, on: termsActive(query, terms) }] : [];
  });
  if (!decks.length) return null;
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {decks.map(({ deck, track, terms, on }) => (
        <SmartChip
          key={deck}
          tone="cyan"
          icon={Link2}
          active={on}
          pressed={on}
          onClick={() => onApply(toggleTerms(query, terms))}
          title={`Κομμάτια με παρόμοιο BPM και συμβατό κλειδί με το «${track.title || track.file_name}» (${terms.join(" ")})`}
        >
          {/* Two flex items: the chip's own gap spaces them, and the hidden words still end in a space for screen readers. */}
          <span className="sr-only @min-[42rem]/toolbar:not-sr-only @min-[42rem]/toolbar:whitespace-nowrap">Ταιριάζει με το </span>
          <span>Deck {deck}</span>
        </SmartChip>
      ))}
    </div>
  );
}
