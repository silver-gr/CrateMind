import { describe, expect, test } from "bun:test";
import { scrollEdges } from "../src/lib/scrollFades";

describe("scroll fade edges", () => {
  test("a list that does not overflow is at both edges (no fades)", () => {
    expect(scrollEdges(0, 400, 400)).toEqual({ atTop: true, atBottom: true });
  });
  test("at the top of a long list only the bottom fade shows", () => {
    expect(scrollEdges(0, 400, 1200)).toEqual({ atTop: true, atBottom: false });
  });
  test("mid-scroll shows both fades; the end shows only the top fade (sub-pixel tolerant)", () => {
    expect(scrollEdges(300, 400, 1200)).toEqual({ atTop: false, atBottom: false });
    expect(scrollEdges(799.5, 400, 1200)).toEqual({ atTop: false, atBottom: true });
  });
});
