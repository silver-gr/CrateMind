import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const player = read("../src/components/MiniPlayer.tsx");
const dock = read("../src/components/DeckDock.tsx");

describe("deck controls tell a screen reader what the eye sees", () => {
  test("the Sync button's name carries its «÷2» / «×2» fold note", () => {
    expect(player).toContain('aria-label={`Sync Deck ${deck}${syncNote ? ` ${syncNote.label}` : ""}`}');
  });

  test("the headphone knobs say on the focused slider that they do not change the sound yet", () => {
    expect(dock).toContain('ariaLabel={`Ένταση ακουστικών (${CUE_HINT})`}');
    expect(dock).toContain('ariaLabel={`Μείξη ακουστικών (${CUE_HINT})`}');
  });
});
