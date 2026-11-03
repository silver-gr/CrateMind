import { getPref, type LibraryProfile } from "./prefs";

/** Profile-dependent copy. The app remounts on a profile switch, so reading the pref per call is enough. */

export function libraryPlaceholder(profile: LibraryProfile = getPref("libraryProfile")): string {
  return profile === "therapy"
    ? "Αναζήτηση τίτλου, καλλιτέχνη ή σκοπού — π.χ. χαλάρωση Χατζιδάκις"
    : "Αναζήτηση — π.χ. energy:7-9 darkness:6-10 role:peak bpm:148-155 status:approved";
}

export function quickPresets(profile: LibraryProfile = getPref("libraryProfile")): { q: string; label: string }[] {
  return profile === "therapy"
    ? [
      { q: "status:approved,weapon", label: "Εγκεκριμένα" },
      { q: "untagged", label: "Αταξινόμητα" },
      { q: "never_played", label: "Δεν παίχτηκαν ακόμη" },
      { q: "not_recent:30", label: "Χωρίς play 30η" },
    ]
    : [
      { q: "weapons", label: "Bangers" },
      { q: "approved", label: "Εγκεκριμένα" },
      { q: "untagged", label: "Χωρίς tags" },
      { q: "role:bridge", label: "Γέφυρες" },
    ];
}

export type LibraryPreset = { label: string; q: string; flagship?: boolean };

/** The quick-search chips under the Library search box. */
export function libraryPresets(profile: LibraryProfile = getPref("libraryProfile")): LibraryPreset[] {
  return profile === "therapy"
    ? [
      { label: "Όλα", q: "" },
      { label: "Αταξινόμητα", q: "untagged" },
      // Therapy shows a DJ weapon as approved, so the preset includes weapons.
      { label: "Εγκεκριμένα", q: "status:approved,weapon" },
      { label: "Χωρίς play 30η", q: "not_recent:30" },
      { label: "Δεν παίχτηκαν ακόμη", q: "never_played" },
    ]
    : [
      { label: "Όλα", q: "" },
      { label: "Χωρίς tags", q: "untagged" },
      { label: "Εγκεκριμένα", q: "approved" },
      { label: "Bangers", q: "weapons" },
      { label: "Γέφυρα", q: "role:bridge" },
      { label: "Κορύφωση", q: "role:peak" },
      { label: "Ρίσκο", q: "weirdness:7+" },
      { label: "Δραματικά", q: "dramatic" },
      { label: "Χωρίς play 30η", q: "not_recent:30" },
      { label: "Ξεχασμένα εγκεκριμένα", q: "status:approved not_recent:90" },
      { label: "Δεν παίχτηκαν ποτέ", q: "never_played" },
      {
        label: "Bangers για γέφυρα κορύφωσης",
        q: "status:approved darkness:7+ energy:8+ bpm:150-160 role:bridge break:long tolerance:huge not_recent:30 dramatic",
        flagship: true,
      },
    ];
}

export function toolsHeading(profile: LibraryProfile = getPref("libraryProfile")): string {
  return profile === "therapy" ? "Εργαλεία" : "Εργαλεία DJ";
}
