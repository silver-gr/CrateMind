import { describe, expect, test } from "bun:test";
import { eitherMenu, type MenuEntry } from "../src/lib/menus/entries";
import { setMenuEntries, type SetMenuActions } from "../src/lib/menus/setMenu";
import { crateMenuEntries, type CrateMenuContext } from "../src/lib/menus/crateMenu";
import { transitionMenuEntries, type TransitionMenuContext } from "../src/lib/menus/transitionMenu";
import { sessionMenuEntries, type SessionMenuContext } from "../src/lib/menus/historyMenu";
import { duplicateGroupMenuEntries, movedPairMenuEntries, type MovedPairMenuContext } from "../src/lib/menus/duplicateMenu";
import { artistMenuEntries } from "../src/lib/menus/artistMenu";
import { columnMenuEntries, type ColumnMenuContext } from "../src/lib/menus/columnMenu";
import { LIBRARY_COLUMNS, type LibraryColumnId } from "../src/lib/tablePreferences";
import type { MovedPair, SavedSearch } from "../src/lib/types";

type Calls = { name: string; args: unknown[] }[];
const recorder = (calls: Calls) => (name: string) => (...args: unknown[]) => { calls.push({ name, args }); };

const labels = (entries: MenuEntry[]) => entries.map(e => (e.type === "separator" ? "—" : e.label));
function find(entries: MenuEntry[], label: string): MenuEntry {
  const hit = entries.find(e => e.type !== "separator" && e.label === label);
  if (!hit) throw new Error(`no entry «${label}» in ${labels(entries).join(" | ")}`);
  return hit;
}
const sub = (entries: MenuEntry[], label: string) => {
  const hit = find(entries, label);
  if (hit.type !== "sub") throw new Error(`«${label}» is not a submenu`);
  return hit.entries;
};
const select = (entry: MenuEntry) => { if ("onSelect" in entry) entry.onSelect(); };
const disabled = (entry: MenuEntry) => "disabled" in entry && !!entry.disabled;
const reason = (entry: MenuEntry) => ("reason" in entry ? entry.reason : undefined);

describe("set menu", () => {
  function actions(over: Partial<SetMenuActions> = {}, calls: Calls = []): SetMenuActions {
    const rec = recorder(calls);
    return { exportAs: rec("export"), duplicate: rec("duplicate"), rename: rec("rename"), remove: rec("remove"), ...over };
  }

  test("Library: open, active set, then export, rename, copy and delete", () => {
    const calls: Calls = [];
    const rec = recorder(calls);
    const entries = setMenuEntries(actions({ open: rec("open"), active: { checked: true, toggle: rec("active") } }, calls));
    expect(labels(entries)).toEqual(["Άνοιγμα στο Set Builder", "Ενεργό set", "—", "Εξαγωγή", "Μετονομασία…", "Δημιουργία αντιγράφου", "—", "Διαγραφή set…"]);
    expect(find(entries, "Ενεργό set")).toMatchObject({ type: "check", checked: true });
    expect(find(entries, "Διαγραφή set…")).toMatchObject({ danger: true });
    select(find(entries, "Ενεργό set"));
    select(find(entries, "Μετονομασία…"));
    select(find(entries, "Διαγραφή set…"));
    expect(calls.map(c => c.name)).toEqual(["active", "rename", "remove"]);
  });

  test("Set Builder: the mix and «παιγμένο» come first; the export list names the JSON backup", () => {
    const calls: Calls = [];
    const rec = recorder(calls);
    const entries = setMenuEntries(actions({
      mix: { running: false, disabled: true, toggle: rec("mix") },
      markPlayed: { disabled: false, run: rec("played") },
    }, calls));
    expect(labels(entries).slice(0, 3)).toEqual(["Αναπαραγωγή ως μίξη", "Σήμανση set ως παιγμένο", "—"]);
    expect(disabled(find(entries, "Αναπαραγωγή ως μίξη"))).toBe(true);
    expect(labels(setMenuEntries(actions({ mix: { running: true, disabled: false, toggle: rec("mix") } })))[0]).toBe("Διακοπή μίξης");
    const exports = sub(entries, "Εξαγωγή");
    expect(labels(exports)).toEqual(["M3U", "CSV", "Markdown", "JSON (αντίγραφο ασφαλείας)"]);
    select(exports[3]);
    expect(calls).toEqual([{ name: "export", args: ["json-backup"] }]);
  });

  test("busy disables export, rename, copy and delete, not the mix", () => {
    const entries = setMenuEntries(actions({ busy: true, mix: { running: true, disabled: false, toggle: () => {} } }));
    expect(disabled(find(entries, "Εξαγωγή"))).toBe(true);
    expect(disabled(find(entries, "Μετονομασία…"))).toBe(true);
    expect(disabled(find(entries, "Δημιουργία αντιγράφου"))).toBe(true);
    expect(disabled(find(entries, "Διαγραφή set…"))).toBe(true);
    expect(disabled(find(entries, "Διακοπή μίξης"))).toBe(false);
  });
});

describe("crate menu", () => {
  const crate = (over: Partial<SavedSearch> = {}) => ({ id: 4, name: "Night", query: "energy:7-9", pinned: false, count: 12, sort_order: 0, ...over } as SavedSearch);
  function ctx(over: Partial<CrateMenuContext> = {}, calls: Calls = []): CrateMenuContext {
    const rec = recorder(calls);
    return { mainCrateId: null, open: rec("open"), pin: rec("pin"), toggleMain: rec("main"), edit: rec("edit"), analyze: rec("analyze"), remove: rec("remove"), ...over };
  }

  test("the Crates tab shows every item; delete is last and rose", () => {
    expect(labels(crateMenuEntries(crate(), ctx()))).toEqual([
      "Άνοιγμα", "Καρφίτσωμα", "Κύριο crate", "—", "Επεξεργασία…", "Ανάλυση BPM…", "—", "Διαγραφή crate",
    ]);
    expect(find(crateMenuEntries(crate(), ctx()), "Διαγραφή crate")).toMatchObject({ danger: true });
  });

  test("the Dashboard has no edit or analysis; a pinned crate offers unpin; the main crate is checked", () => {
    const entries = crateMenuEntries(crate({ pinned: true }), ctx({ edit: undefined, analyze: undefined, mainCrateId: 4 }));
    expect(labels(entries)).toEqual(["Άνοιγμα", "Ξεκαρφίτσωμα", "Κύριο crate", "—", "Διαγραφή crate"]);
    expect(find(entries, "Κύριο crate")).toMatchObject({ type: "check", checked: true });
  });

  test("items call the card's own actions with the crate", () => {
    const calls: Calls = [];
    const c = crate();
    select(find(crateMenuEntries(c, ctx({}, calls)), "Άνοιγμα"));
    expect(calls).toEqual([{ name: "open", args: [c] }]);
  });
});

describe("transition menu", () => {
  function ctx(over: Partial<TransitionMenuContext> = {}, calls: Calls = []): TransitionMenuContext {
    const rec = recorder(calls);
    return { hasTransition: true, mixable: true, hasNote: false, preview: rec("preview"), edit: rec("edit"), bridge: rec("bridge"), note: rec("note"), ...over };
  }

  test("preview and edit, then bridge and note", () => {
    expect(labels(transitionMenuEntries(ctx()))).toEqual([
      "Προεπισκόπηση μετάβασης", "Επεξεργασία μετάβασης…", "—", "Βρες track-γέφυρα", "Σημείωση μετάβασης…",
    ]);
    expect(labels(transitionMenuEntries(ctx({ hasNote: true })))[4]).toBe("Επεξεργασία σημείωσης…");
  });

  test("an unmixable pair disables the preview with the pill's reason; no transition yet disables both", () => {
    const unmixable = transitionMenuEntries(ctx({ mixable: false }));
    expect(disabled(unmixable[0])).toBe(true);
    expect(reason(unmixable[0])).toBe("χωρίς μίξη");
    expect(disabled(unmixable[1])).toBe(false);
    const none = transitionMenuEntries(ctx({ hasTransition: false }));
    expect([disabled(none[0]), disabled(none[1])]).toEqual([true, true]);
    expect(disabled(find(none, "Βρες track-γέφυρα"))).toBe(false);
  });
});

describe("history session menu", () => {
  function ctx(over: Partial<SessionMenuContext> = {}, calls: Calls = []): SessionMenuContext {
    const rec = recorder(calls);
    return { partial: false, busy: false, saveAsSet: rec("save"), ...over };
  }

  test("Library tab: save, fold, the full page", () => {
    const entries = sessionMenuEntries(ctx({ fold: { open: true, toggle: () => {} }, openPage: () => {} }));
    expect(labels(entries)).toEqual(["Αποθήκευση ως set", "Σύμπτυξη", "—", "Άνοιγμα στη σελίδα «Ιστορικό»"]);
    expect(labels(sessionMenuEntries(ctx({ fold: { open: false, toggle: () => {} } })))[1]).toBe("Ανάπτυξη");
  });

  test("/history: save, then delete in rose; a cut session waits for older plays", () => {
    const calls: Calls = [];
    const entries = sessionMenuEntries(ctx({ remove: recorder(calls)("remove") }));
    expect(labels(entries)).toEqual(["Αποθήκευση ως set", "—", "Διαγραφή session…"]);
    expect(find(entries, "Διαγραφή session…")).toMatchObject({ danger: true });
    const partial = sessionMenuEntries(ctx({ partial: true, remove: () => {} }));
    expect(partial.filter(disabled).map(reason)).toEqual(["φόρτωσε παλιότερα", "φόρτωσε παλιότερα"]);
    expect(sessionMenuEntries(ctx({ busy: true })).every(e => e.type === "separator" || disabled(e))).toBe(true);
  });
});

describe("duplicate menus", () => {
  const pair = {
    old: { track_id: 1, absolute_path: "/Music/old/a.flac" },
    new: { track_id: 2, absolute_path: "/Music/new/a.flac" },
  } as MovedPair;
  function ctx(over: Partial<MovedPairMenuContext> = {}, calls: Calls = []): MovedPairMenuContext {
    const rec = recorder(calls);
    return { merging: false, confirm: rec("confirm"), decline: rec("decline"), reveal: rec("reveal"), copy: rec("copy"), ...over };
  }

  test("a group offers its «αγνόηση»", () => {
    let ignored = false;
    const entries = duplicateGroupMenuEntries(() => { ignored = true; });
    expect(labels(entries)).toEqual(["Δεν είναι διπλότυπο (αγνόηση)"]);
    select(entries[0]);
    expect(ignored).toBe(true);
  });

  test("a moved pair: the two answers, the new file's folder and both paths", () => {
    const calls: Calls = [];
    const entries = movedPairMenuEntries(pair, ctx({}, calls));
    expect(labels(entries)).toEqual(["Είναι το ίδιο", "Δεν είναι το ίδιο", "—", "Εμφάνιση νέου αρχείου στον φάκελο", "Αντιγραφή"]);
    sub(entries, "Αντιγραφή").forEach(select);
    expect(calls.map(c => c.args[0])).toEqual(["/Music/old/a.flac", "/Music/new/a.flac"]);
    expect(labels(movedPairMenuEntries(pair, ctx({ reveal: undefined })))).not.toContain("Εμφάνιση νέου αρχείου στον φάκελο");
    expect(movedPairMenuEntries(pair, ctx({ merging: true })).slice(0, 2).every(disabled)).toBe(true);
  });
});

describe("artist menu", () => {
  test("tracks, the waiting review, the name", () => {
    const copied: unknown[] = [];
    const entries = artistMenuEntries("Astrix", { openTracks: () => {}, review: () => {}, copy: text => copied.push(text) });
    expect(labels(entries)).toEqual(["Κομμάτια του καλλιτέχνη", "Επιβεβαίωση είδους…", "—", "Αντιγραφή ονόματος"]);
    select(find(entries, "Αντιγραφή ονόματος"));
    expect(copied).toEqual(["Astrix"]);
  });

  test("an artist the Library already filters is taken out; no review without a waiting result", () => {
    expect(labels(artistMenuEntries("Astrix", { filtered: true, openTracks: () => {}, copy: () => {} })))
      .toEqual(["Αφαίρεση από το φίλτρο", "—", "Αντιγραφή ονόματος"]);
  });
});

describe("column header menu", () => {
  const visibility = Object.fromEntries(LIBRARY_COLUMNS.map(c => [c.id, !("hidden" in c && c.hidden)])) as Record<LibraryColumnId, boolean>;
  function ctx(over: Partial<ColumnMenuContext> = {}, calls: Calls = []): ColumnMenuContext {
    const rec = recorder(calls);
    return { sort: null, setSort: rec("sort"), visibility, setVisible: rec("visible"), resetWidth: rec("width"), resetWidths: rec("widths"), ...over };
  }

  test("sort, hide, columns, then the width resets", () => {
    expect(labels(columnMenuEntries("bpm", ctx()))).toEqual([
      "Ταξινόμηση", "Απόκρυψη στήλης", "Στήλες", "—", "Επαναφορά πλάτους στήλης", "Επαναφορά μεγεθών",
    ]);
  });

  test("«Κομμάτι» cannot be hidden; a `sort:` token hides the sort; «Δομή» has no sort", () => {
    expect(labels(columnMenuEntries("track", ctx()))).not.toContain("Απόκρυψη στήλης");
    expect(labels(columnMenuEntries("bpm", ctx({ setSort: undefined })))).not.toContain("Ταξινόμηση");
    expect(labels(columnMenuEntries("structure", ctx()))).not.toContain("Ταξινόμηση");
    const columns = sub(columnMenuEntries("bpm", ctx()), "Στήλες");
    expect(columns).toHaveLength(LIBRARY_COLUMNS.length);
    expect(disabled(columns[0])).toBe(true);
  });

  test("the sort radios follow this column's sort; «Χωρίς ταξινόμηση» clears only this column's sort", () => {
    const calls: Calls = [];
    const sorted = sub(columnMenuEntries("bpm", ctx({ sort: { key: "bpm", dir: "desc" } }, calls)), "Ταξινόμηση");
    expect(sorted.map(e => e.type === "radio" && e.checked)).toEqual([false, true, false]);
    select(sorted[0]);
    select(sorted[2]);
    expect(calls).toEqual([{ name: "sort", args: [{ key: "bpm", dir: "asc" }] }, { name: "sort", args: [null] }]);
    calls.length = 0;
    const other = sub(columnMenuEntries("key", ctx({ sort: { key: "bpm", dir: "desc" } }, calls)), "Ταξινόμηση");
    expect(other.map(e => e.type === "radio" && e.checked)).toEqual([false, false, true]);
    select(other[2]);
    expect(calls).toEqual([]);
  });

  test("hide and the «Στήλες» checks write the visibility", () => {
    const calls: Calls = [];
    const entries = columnMenuEntries("bpm", ctx({}, calls));
    select(find(entries, "Απόκρυψη στήλης"));
    select(find(sub(entries, "Στήλες"), "BPM"));
    expect(calls).toEqual([{ name: "visible", args: ["bpm", false] }, { name: "visible", args: ["bpm", false] }]);
  });
});

describe("eitherMenu", () => {
  test("each target goes to its own menu; no menus, no menu", () => {
    const opened: string[] = [];
    const menu = eitherMenu(
      { entries: (n: number) => [{ type: "label", label: `row ${n}` }], onOpenChange: open => { if (open) opened.push("row"); } },
      { entries: (s: string) => [{ type: "label", label: `header ${s}` }] },
    );
    expect(labels(menu!.entries({ first: 3 }))).toEqual(["row 3"]);
    expect(labels(menu!.entries({ second: "bpm" }))).toEqual(["header bpm"]);
    menu!.onOpenChange?.(true, { first: 3 });
    menu!.onOpenChange?.(true, { second: "bpm" });
    expect(opened).toEqual(["row"]);
    expect(eitherMenu(undefined, undefined)).toBeUndefined();
  });
});
