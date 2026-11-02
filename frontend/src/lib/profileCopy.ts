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
      { q: "approved", label: "Εγκεκριμένα" },
      { q: "untagged", label: "Αταξινόμητα" },
      { q: "never_played", label: "Δεν παίχτηκαν ακόμη" },
      { q: "not_recent:30", label: "Χωρίς play 30η" },
    ]
    : [
      { q: "weapons", label: "Όπλα" },
      { q: "approved", label: "Εγκεκριμένα" },
      { q: "untagged", label: "Χωρίς tags" },
      { q: "role:bridge", label: "Γέφυρες" },
    ];
}

export function toolsHeading(profile: LibraryProfile = getPref("libraryProfile")): string {
  return profile === "therapy" ? "Εργαλεία" : "Εργαλεία DJ";
}
