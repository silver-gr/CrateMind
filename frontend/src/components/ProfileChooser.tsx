import { setPref, type LibraryProfile } from "../lib/prefs";
import { GlassPanel } from "./ui/GlassPanel";

const OPTIONS: { profile: LibraryProfile; title: string; text: string }[] = [
  { profile: "dj", title: "DJ", text: "Ενέργεια, ρόλοι στο set, key, flow και cue pads για χτίσιμο set." },
  {
    profile: "therapy",
    title: "Μουσικοθεραπεία",
    text: "Διέγερση και συναισθηματικό σθένος, λεξιλόγια όπως «Θεραπευτικός στόχος» και ταξινόμηση της βιβλιοθήκης.",
  },
];

/** First-launch question. The answer can be changed later in Ρυθμίσεις > «Προφίλ χρήσης». */
export function ProfileChooser() {
  function choose(profile: LibraryProfile) {
    setPref("libraryProfile", profile);
    setPref("profileChosen", true);
  }

  return (
    <div className="flex h-full items-center justify-center overflow-auto p-6">
      <GlassPanel strong className="w-full max-w-2xl space-y-5 p-6">
        <div>
          <h1 className="text-xl font-semibold text-cm-text">Πώς θα χρησιμοποιήσεις το CrateMind;</h1>
          <p className="mt-1 text-sm text-cm-muted">Μπορείς να το αλλάξεις όποτε θέλεις από τις Ρυθμίσεις.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {OPTIONS.map(option => (
            <button
              key={option.profile}
              type="button"
              onClick={() => choose(option.profile)}
              className="cursor-pointer rounded-xl border border-cm-contrast/10 bg-cm-contrast/5 p-4 text-left transition hover:border-cm-cyan/40 hover:bg-cm-cyan/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-cyan/50"
            >
              <div className="text-base font-semibold text-cm-text">{option.title}</div>
              <p className="mt-1 text-xs leading-relaxed text-cm-muted">{option.text}</p>
            </button>
          ))}
        </div>
      </GlassPanel>
    </div>
  );
}
