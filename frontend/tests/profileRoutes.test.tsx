import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import {
  canAccessRoute,
  filterRoutes,
  THERAPY_HIDDEN_ROUTES,
  visibleNavGroups,
} from "../src/lib/capabilities";
import { NAV } from "../src/components/CommandPalette";
import { ProfileChooser } from "../src/components/ProfileChooser";
import { libraryPlaceholder, quickPresets, toolsHeading } from "../src/lib/profileCopy";
import { resolveProfilePrefs } from "../src/lib/prefs";

const desktop = { identity: false, analysis: false, artist_enrichment: false, backup_import: true, complete_backup: false };
const python = { ...desktop, identity: true, analysis: true, artist_enrichment: true, backup_import: false, complete_backup: true };
const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

describe("therapy route policy", () => {
  test("therapy hides the DJ-only routes and their subpaths, keeps the rest", () => {
    expect(THERAPY_HIDDEN_ROUTES).toEqual(["/flow", "/key-harmony", "/phrase-finder", "/smart-folders"]);
    for (const route of THERAPY_HIDDEN_ROUTES) {
      expect(canAccessRoute(python, route, "therapy")).toBe(false);
      expect(canAccessRoute(python, `${route}/x?y=1`, "therapy")).toBe(false);
      expect(canAccessRoute(python, route, "dj")).toBe(true);
      expect(canAccessRoute(python, route)).toBe(true);
    }
    const kept = NAV.map(n => n.to).filter(to => !THERAPY_HIDDEN_ROUTES.includes(to));
    for (const route of [...kept, "/settings", "/tag", "/tag-cloud"]) {
      expect(canAccessRoute(python, route, "therapy")).toBe(true);
    }
  });

  test("identity routes stay capability-gated in both profiles", () => {
    for (const profile of ["dj", "therapy"] as const) {
      expect(canAccessRoute(desktop, "/collections", profile)).toBe(false);
      expect(canAccessRoute(python, "/collections", profile)).toBe(true);
    }
  });

  test("filterRoutes drops exactly the hidden NAV entries in therapy", () => {
    expect(filterRoutes(NAV, python, "dj")).toEqual(NAV);
    const therapy = filterRoutes(NAV, python, "therapy");
    expect(NAV.filter(n => !therapy.includes(n)).map(n => n.to)).toEqual(["/flow", "/key-harmony"]);
  });

  test("visibleNavGroups filters items and sub-items and drops empty groups in order", () => {
    const groups = [
      { heading: "a", items: [{ to: "/library", subItems: [{ to: "/crates" }, { to: "/smart-folders" }] }, { to: "/flow" }] },
      { heading: "b", items: [{ to: "/key-harmony" }, { to: "/phrase-finder" }] },
      { heading: "c", items: [{ to: "/settings" }] },
    ];
    expect(visibleNavGroups(groups, python, "dj")).toEqual(groups);
    expect(visibleNavGroups(groups, python, "therapy")).toEqual([
      { heading: "a", items: [{ to: "/library", subItems: [{ to: "/crates" }] }] },
      { heading: "c", items: [{ to: "/settings" }] },
    ]);
  });
});

describe("profile prefs", () => {
  test("fresh installs show the chooser, existing installs stay DJ", () => {
    expect(resolveProfilePrefs(null)).toEqual({ libraryProfile: "dj", profileChosen: false });
    expect(resolveProfilePrefs({})).toEqual({ libraryProfile: "dj", profileChosen: false });
    expect(resolveProfilePrefs({ density: "compact" })).toEqual({ libraryProfile: "dj", profileChosen: true });
    expect(resolveProfilePrefs({ libraryProfile: "therapy", profileChosen: true }))
      .toEqual({ libraryProfile: "therapy", profileChosen: true });
  });
});

describe("profile wiring", () => {
  test("Sidebar, App and CommandPalette filter routes with the profile", () => {
    expect(source("components/layout/Sidebar.tsx")).toContain("visibleNavGroups(");
    expect(source("app/App.tsx")).toMatch(/canAccessRoute\([^)]*,[^)]*,\s*profile\)/);
    expect(source("components/CommandPalette.tsx")).toMatch(/filterRoutes\([^)]*,\s*profile\)/);
  });
});

describe("profile copy", () => {
  test("therapy copy has no DJ syntax", () => {
    expect(libraryPlaceholder("therapy")).toBe("Αναζήτηση τίτλου, καλλιτέχνη ή σκοπού — π.χ. χαλάρωση Χατζιδάκις");
    expect(quickPresets("therapy")).toEqual([
      { q: "approved", label: "Εγκεκριμένα" },
      { q: "untagged", label: "Αταξινόμητα" },
      { q: "never_played", label: "Δεν παίχτηκαν ακόμη" },
      { q: "not_recent:30", label: "Χωρίς play 30η" },
    ]);
    for (const p of quickPresets("therapy")) expect(p.q).not.toMatch(/weapons|role:bridge/);
    expect(quickPresets("dj")).toEqual([
      { q: "weapons", label: "Όπλα" },
      { q: "approved", label: "Εγκεκριμένα" },
      { q: "untagged", label: "Χωρίς tags" },
      { q: "role:bridge", label: "Γέφυρες" },
    ]);
    expect(toolsHeading("dj")).toBe("Εργαλεία DJ");
    expect(toolsHeading("therapy")).toBe("Εργαλεία");
  });

  test("the first-launch chooser asks informally and offers both profiles", () => {
    const html = renderToString(<ProfileChooser />);
    expect(html).toContain("Πώς θα χρησιμοποιήσεις το CrateMind;");
    expect(html).toContain("DJ");
    expect(html).toContain("Μουσικοθεραπεία");
  });
});
