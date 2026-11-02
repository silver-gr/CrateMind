import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { BulkTagBar } from "../src/components/BulkTagBar";
import { preferenceStorage } from "../src/lib/preferenceStorage";
import { changeSummary } from "../src/lib/selection";

describe("bulk bar accessibility", () => {
  let storageSpy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => storageSpy?.mockRestore());

  test("the bar is a named group and its scope and mode chips expose aria-pressed", () => {
    storageSpy = spyOn(preferenceStorage, "getItem").mockImplementation(() => null);
    const html = renderToString(<BulkTagBar selectedIds={new Set([1, 2])} query="" onApplied={() => {}} />);
    expect(html).toMatch(/role="group"[^>]*aria-label="Μαζική αλλαγή"|aria-label="Μαζική αλλαγή"[^>]*role="group"/);
    const chip = (label: string) => html.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}`))?.[0] ?? "";
    expect(chip("Επιλεγμένα")).toContain('aria-pressed="true"');
    expect(chip("Όλα τα αποτελέσματα")).toContain('aria-pressed="false"');
    expect(chip("Προσθήκη τιμών")).toContain('aria-pressed="true"');
    expect(chip("Αφαίρεση τιμών")).toContain('aria-pressed="false"');
  });

  test("the confirmation names the mode, the values and the axes", () => {
    expect(changeSummary("add", ["χαλάρωση", "ύπνος"], [])).toBe("Προσθήκη: χαλάρωση, ύπνος.");
    expect(changeSummary("remove", ["χαλάρωση"], [["Διέγερση", 3]])).toBe("Αφαίρεση: χαλάρωση. Διέγερση: 3.");
    expect(changeSummary("remove", [], [["Διέγερση", 3], ["Συναισθηματικό σθένος", 7]])).toBe("Διέγερση: 3. Συναισθηματικό σθένος: 7.");
  });
});
