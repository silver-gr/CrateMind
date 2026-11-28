import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { NamesSettingsView } from "../src/components/NamesSettings";
import { NAME_STATUSES, NAME_STATUS_COUNT_LABEL } from "../src/lib/namesLabels";
import {
  canRunNow,
  causeText,
  countRows,
  lastRunText,
  libraryHref,
  newChangesView,
  runText,
  SCAN_SECTION_HREF,
  shouldPoll,
  switchView,
  tracksText,
  unreadableText,
  unreadText,
  whenText,
} from "../src/lib/namesSettings";
import type { NamesStatus } from "../src/lib/types";

function status(patch: Partial<NamesStatus> = {}): NamesStatus {
  return {
    on: false,
    can_turn_on: true,
    blocked_reason: null,
    ruleset: "names-8",
    present: 120,
    named: 120,
    unread: 0,
    unreadable: 0,
    counts: { sure: 100, look: 12, open: 3, none: 2, hand: 3 },
    accepted: 0,
    changed: 20,
    new: 0,
    run: { state: "idle", cause: null, job_id: null },
    last_run: null,
    refusal: null,
    refusal_text: null,
    ...patch,
  };
}

const BLOCKED = "7 κομμάτια δεν έχουν διαβαστεί ακόμη: κάνε σάρωση";
const render = (s: NamesStatus, busy = false) =>
  renderToString(<MemoryRouter><NamesSettingsView status={s} busy={busy} onSwitch={() => {}} onRun={() => {}} /></MemoryRouter>);

describe("the switch", () => {
  test("off and readable: it can be turned on", () => {
    expect(switchView(status())).toEqual({ checked: false, disabled: false, reason: null });
  });

  test("off with unread tracks: disabled, with the backend's reason", () => {
    const s = status({ can_turn_on: false, blocked_reason: BLOCKED, unread: 7 });
    expect(switchView(s)).toEqual({ checked: false, disabled: true, reason: BLOCKED });
  });

  test("a blocked switch without a backend reason still says why", () => {
    expect(switchView(status({ can_turn_on: false, unread: 7 })).reason).toBe(BLOCKED);
    expect(switchView(status({ can_turn_on: false, unread: 1 })).reason).toBe("1 κομμάτι δεν έχει διαβαστεί ακόμη: κάνε σάρωση");
    expect(switchView(status({ can_turn_on: false })).reason).toBeTruthy();
  });

  test("on: turning it off is never blocked, unread tracks or not", () => {
    expect(switchView(status({ on: true, can_turn_on: false, unread: 4, blocked_reason: BLOCKED })))
      .toEqual({ checked: true, disabled: false, reason: null });
  });

  test("busy while a switch call is in flight", () => {
    expect(switchView(status(), true).disabled).toBe(true);
  });
});

describe("counts and lines", () => {
  test("one row per status, in the fixed order, each with its Library filter", () => {
    const rows = countRows(status());
    expect(rows.map(r => r.status)).toEqual([...NAME_STATUSES]);
    expect(rows.map(r => r.label)).toEqual(NAME_STATUSES.map(k => NAME_STATUS_COUNT_LABEL[k]));
    for (const row of rows) expect(row.label).not.toBe("");
    expect(rows.map(r => r.count)).toEqual([100, 12, 3, 2, 3]);
    expect(rows[1].href).toBe("/library?q=names%3Alook");
  });

  test("«Άλλαξαν από την τελευταία ματιά» links to names:new only when there are changes", () => {
    expect(newChangesView(status({ new: 0 }))).toEqual({ text: "Άλλαξαν από την τελευταία ματιά: 0", href: null });
    expect(newChangesView(status({ new: 1234 }))).toEqual({
      text: "Άλλαξαν από την τελευταία ματιά: 1.234",
      href: libraryHref("names:new"),
    });
  });

  test("Greek singular and plural, with Greek digit grouping", () => {
    expect(tracksText(1)).toBe("1 κομμάτι");
    expect(tracksText(4675)).toBe("4.675 κομμάτια");
    expect(unreadText(1)).toBe("1 κομμάτι δεν έχει διαβαστεί ακόμη");
    expect(unreadText(2)).toBe("2 κομμάτια δεν έχουν διαβαστεί ακόμη");
    expect(unreadableText(1)).toBe("1 κομμάτι έχει tags που δεν διαβάζονται");
    expect(unreadableText(3)).toBe("3 κομμάτια έχουν tags που δεν διαβάζονται");
  });
});

describe("the names job", () => {
  test("every cause the store sends has Greek text, decisions included", () => {
    for (const cause of ["launch", "scan", "analysis", "links", "switch", "manual", "import", "decision:42"]) {
      expect(causeText(cause)).toMatch(/[α-ω]/);
    }
    expect(causeText(null)).toBe("");
    expect(causeText("unknown_cause")).toBe("");
  });

  test("idle shows nothing; queued and running say so, with their cause", () => {
    expect(runText({ state: "idle", cause: null, job_id: null })).toBeNull();
    expect(runText({ state: "running", cause: "scan", job_id: 9 })).toBe("Τα ονόματα ενημερώνονται τώρα, μετά τη σάρωση…");
    expect(runText({ state: "queued", cause: null, job_id: null })).toBe("Η ενημέρωση των ονομάτων περιμένει τη σειρά της…");
    expect(runText({ state: "queued", cause: "bogus", job_id: null })).not.toContain("bogus");
  });

  test("polls only while a run is queued or running", () => {
    expect(shouldPoll(null)).toBe(false);
    expect(shouldPoll(status())).toBe(false);
    expect(shouldPoll(status({ run: { state: "queued", cause: "switch", job_id: null } }))).toBe(true);
    expect(shouldPoll(status({ run: { state: "running", cause: "manual", job_id: 3 } }))).toBe(true);
  });

  test("«Ενημέρωση ονομάτων» waits for a queued or running run, and works with the switch off", () => {
    expect(canRunNow(status({ on: false }))).toBe(true);
    expect(canRunNow(status(), true)).toBe(false);
    expect(canRunNow(status({ run: { state: "queued", cause: "manual", job_id: null } }))).toBe(false);
    expect(canRunNow(status({ run: { state: "running", cause: "manual", job_id: 1 } }))).toBe(false);
  });

  test("the last run with its ruleset; a run on older rules names both", () => {
    expect(lastRunText(null, "names-8")).toBeNull();
    const last = { finished_at: "2026-11-27T22:53:00Z", ruleset: "names-8", cause: "scan", written: 12, seconds: 4.1 };
    const text = lastRunText(last, "names-8")!;
    expect(text).toStartWith("Τελευταία ενημέρωση: ");
    expect(text).toContain("2026");
    expect(text).toContain("κανόνες names-8 · ενημερώθηκαν 12 κομμάτια σε 4,1 δευτ.");
    expect(lastRunText({ ...last, written: 0 }, "names-8")).toContain("κανένα κομμάτι δεν ενημερώθηκε");
    expect(lastRunText({ ...last, written: 1 }, "names-8")).toContain("ενημερώθηκε 1 κομμάτι σε");
    expect(lastRunText(last, "names-9")).toContain("κανόνες names-8 (τώρα names-9: πάτα «Ενημέρωση ονομάτων»)");
    expect(whenText("not a date")).toBe("not a date");
  });
});

describe("the section", () => {
  test("a blocked switch renders disabled, with the reason and a way to the scan", () => {
    const html = render(status({ can_turn_on: false, blocked_reason: BLOCKED, unread: 7 }));
    expect(html).toContain(BLOCKED);
    expect(html).toMatch(/role="switch"[^>]*aria-checked="false"[^>]*disabled=""|disabled=""[^>]*role="switch"/);
    expect(html).toContain(`href="${SCAN_SECTION_HREF}"`);
    // The unread line is not repeated under the counts while the switch already says it.
    expect(html.split("δεν έχουν διαβαστεί ακόμη").length - 1).toBe(1);
  });

  test("counts, the changes link, unreadable tracks, the refusal, the run state and the last run", () => {
    const html = render(status({
      on: true,
      new: 5,
      unreadable: 2,
      refusal: "key_version",
      refusal_text: "Οι απαντήσεις σου γράφτηκαν με παλαιότερη έκδοση των κανόνων· τα ονόματα δεν ενημερώθηκαν",
      run: { state: "running", cause: "switch", job_id: 4 },
      last_run: { finished_at: "2026-11-27T22:53:00Z", ruleset: "names-8", cause: "manual", written: 3, seconds: 2 },
    }));
    for (const status of NAME_STATUSES) expect(html).toContain(NAME_STATUS_COUNT_LABEL[status]);
    expect(html).toContain('href="/library?q=names%3Anew"');
    expect(html).toContain("Άλλαξαν από την τελευταία ματιά: 5");
    expect(html).toContain("2 κομμάτια έχουν tags που δεν διαβάζονται");
    expect(html).toContain("παλαιότερη έκδοση των κανόνων");
    expect(html).toContain("Τα ονόματα ενημερώνονται τώρα, με το άνοιγμα του διακόπτη…");
    expect(html).toContain("κανόνες names-8");
    expect(html).toContain('href="/glossary#clean-names"');
    expect(html).not.toContain("έχουν διαβαστεί");
  });

  test("unread tracks with the switch on are named under the counts", () => {
    const html = render(status({ on: true, can_turn_on: false, blocked_reason: BLOCKED, unread: 3 }));
    expect(html).toContain("3 κομμάτια δεν έχουν διαβαστεί ακόμη");
    expect(html).toContain("κάνε σάρωση");
  });

  test("no import button: the owner's answers come in through the reconciliation script", () => {
    const html = render(status());
    expect(html).not.toMatch(/Εισαγωγή απαντήσεων|owner-answers/);
    expect(html).toContain("Ενημέρωση ονομάτων");
  });
});
