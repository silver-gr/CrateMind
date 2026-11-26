import { SmartChip } from "../ui/SmartChip";
import { deckMatchTerms, termsActive, toggleTerms } from "../../lib/libraryExtras";
import { usePlayer, type DeckId } from "../../lib/player";

/** «Ταιριάζει με το Deck A/B»: one chip per loaded deck that adds (or, clicked again, removes) a tempo and key filter. */
export function DeckMatchChips({ query, onApply }: { query: string; onApply: (q: string) => void }) {
  const { slots } = usePlayer();
  const decks = (["A", "B"] as DeckId[]).flatMap(deck => {
    const track = slots[deck].track;
    const terms = track ? deckMatchTerms(track) : [];
    return track && terms.length ? [{ deck, track, terms }] : [];
  });
  if (!decks.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-1.5 py-1">
      {decks.map(({ deck, track, terms }) => (
        <SmartChip
          key={deck}
          tone="cyan"
          active={termsActive(query, terms)}
          onClick={() => onApply(toggleTerms(query, terms))}
          title={`Κομμάτια με παρόμοιο BPM και συμβατό κλειδί με το «${track.title || track.file_name}» (${terms.join(" ")})`}
        >
          Ταιριάζει με το Deck {deck}
        </SmartChip>
      ))}
    </div>
  );
}
