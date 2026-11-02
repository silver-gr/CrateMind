import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

describe("tag add/remove errors", () => {
  test("/tag shows the server message without the HTTP status prefix", () => {
    const text = source("pages/TaggingQueue.tsx");
    const tagLines = text.split("\n").filter(line => line.includes("api.removeTag(") || line.includes("api.assignTag("));
    expect(tagLines).toHaveLength(2);
    for (const line of tagLines) {
      expect(line.includes("as Error).message")).toBe(false);
      expect(line.includes("toast.error(apiMessage(")).toBe(true);
    }
  });

  test("the Library inspector catches tag errors and toasts them", () => {
    const text = source("components/ProfileEditor.tsx");
    for (const call of ["api.removeTag(", "api.assignTag("]) {
      const at = text.indexOf(call);
      expect(at).toBeGreaterThan(-1);
      const before = text.slice(Math.max(0, at - 120), at);
      const after = text.slice(at, at + 260);
      expect([call, before.includes("try {")]).toEqual([call, true]);
      expect([call, after.includes("toast.error(apiMessage(error))")]).toEqual([call, true]);
    }
  });
});
