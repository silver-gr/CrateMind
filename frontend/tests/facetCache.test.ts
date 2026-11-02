import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { api } from "../src/lib/api";
import { fetchFacets, notifyFacetsChanged } from "../src/lib/facets";
import type { Facet } from "../src/lib/types";

const facet = (key: string): Facet => ({ id: 1, key, label: key, multi: true, sort_order: 0, values: [] });

describe("facet cache", () => {
  let spy: ReturnType<typeof spyOn> | undefined;
  const savedWindow = globalThis.window;
  afterEach(() => {
    spy?.mockRestore();
    globalThis.window = savedWindow;
  });

  test("a write during an in-flight request never serves or caches the older response", async () => {
    globalThis.window = { dispatchEvent: () => true } as any;
    const pending: ((facets: Facet[]) => void)[] = [];
    spy = spyOn(api, "listFacets").mockImplementation(() => new Promise<Facet[]>(resolve => pending.push(resolve)));

    const before = fetchFacets(false);
    notifyFacetsChanged();
    const after = fetchFacets(true);
    expect(pending).toHaveLength(2);

    pending[0]([facet("old")]);
    pending[1]([facet("new")]);
    expect((await before).map(f => f.key)).toEqual(["new"]);
    expect((await after).map(f => f.key)).toEqual(["new"]);
    expect((await fetchFacets(false)).map(f => f.key)).toEqual(["new"]);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
