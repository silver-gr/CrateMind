import { afterEach, describe, expect, test } from "bun:test";
import { api } from "../src/lib/api";
import { needsForce, presetLoadedText, rewrittenSearchesText } from "../src/components/VocabularySettings";

describe("vocabulary toasts", () => {
  test("preset load agrees in number and says when nothing was added", () => {
    expect(presetLoadedText(8, 47)).toBe("Προστέθηκαν 8 λεξιλόγια και 47 τιμές.");
    expect(presetLoadedText(1, 1)).toBe("Προστέθηκαν 1 λεξιλόγιο και 1 τιμή.");
    expect(presetLoadedText(0, 1)).toBe("Προστέθηκε 1 τιμή.");
    expect(presetLoadedText(0, 3)).toBe("Προστέθηκαν 3 τιμές.");
    expect(presetLoadedText(1, 0)).toBe("Προστέθηκε 1 λεξιλόγιο.");
    expect(presetLoadedText(0, 0)).toBe("Το προτεινόμενο λεξιλόγιο υπάρχει ήδη.");
  });

  test("renamed searches agree in number", () => {
    expect(rewrittenSearchesText(1)).toBe("Ενημερώθηκε 1 αποθηκευμένη αναζήτηση.");
    expect(rewrittenSearchesText(3)).toBe("Ενημερώθηκαν 3 αποθηκευμένες αναζητήσεις.");
  });
});

describe("force-delete confirmation", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });
  const failWith = (body: unknown) => {
    globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 409 })) as unknown as typeof fetch;
    return api.deleteFacet(1).then(() => null, (error: unknown) => error);
  };

  test("a used vocabulary asks for confirmation", async () => {
    expect(needsForce(await failWith({ detail: "Το λεξιλόγιο έχει 3 τιμές σε 5 κομμάτια." }))).toBe(true);
  });

  test("a busy dataset never opens the force-delete dialog", async () => {
    const error = await failWith({ detail: "Η βιβλιοθήκη ετοιμάζεται για μεταφορά. Δοκίμασε ξανά σε λίγο.", code: "dataset_busy" });
    expect(needsForce(error)).toBe(false);
    expect((error as Error).message).toBe("409: Η βιβλιοθήκη ετοιμάζεται για μεταφορά. Δοκίμασε ξανά σε λίγο.");
  });
});
