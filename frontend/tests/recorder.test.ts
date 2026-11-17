import { describe, expect, test } from "bun:test";
import { formatElapsed, isFatal, joinBlocks, takeBatch } from "../src/lib/recordingCore";

describe("recorder helpers", () => {
  test("joinBlocks keeps order and length", () => {
    const joined = joinBlocks([new Float32Array([1, 2]), new Float32Array([]), new Float32Array([3, 4, 5, 6])]);
    expect(Array.from(joined)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(joinBlocks([]).length).toBe(0);
  });

  test("formatElapsed shows m:ss, then h:mm:ss", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(7.9)).toBe("0:07");
    expect(formatElapsed(754)).toBe("12:34");
    expect(formatElapsed(3723)).toBe("1:02:03");
    expect(formatElapsed(-3)).toBe("0:00");
  });

  test("only a 4xx ends the recording; network and 5xx errors are retried", () => {
    expect(isFatal(new Error("409: Ο δίσκος σχεδόν γέμισε"))).toBe(true);
    expect(isFatal(new Error("404: Η εγγραφή δεν είναι ενεργή."))).toBe(true);
    expect(isFatal(new Error("500: Σφάλμα της υπηρεσίας"))).toBe(false);
    expect(isFatal(new Error("Ο server δεν απαντά"))).toBe(false);
    expect(isFatal("x")).toBe(false);
    // Maintenance holds the library for a moment: retried, not the end of the set.
    expect(isFatal(Object.assign(new Error("409: Η βιβλιοθήκη είναι απασχολημένη"), { code: "dataset_busy" }))).toBe(false);
    expect(isFatal(new DOMException("signal timed out", "TimeoutError"))).toBe(false);
  });

  test("takeBatch caps one POST and always takes at least one block", () => {
    const q = [new Float32Array(4), new Float32Array(4), new Float32Array(4)];
    const [batch, rest] = takeBatch(q, 8);
    expect(batch.length).toBe(2);
    expect(rest.length).toBe(1);
    expect(takeBatch([new Float32Array(10)], 4)[0].length).toBe(1);
    expect(takeBatch([], 8)).toEqual([[], []]);
  });
});
