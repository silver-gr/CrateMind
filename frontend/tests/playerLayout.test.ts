import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { DECK_DEFAULT_HEIGHT, DECK_HEIGHT_KEY, DOCK_COLUMN_MIN_WIDTH, dockInColumn, moveOldDeckHeight, playerDockHeight } from '../src/lib/playerLayout';
import { PageRail } from '../src/lib/pageRail';

describe('compact player height contract', () => {
  test('caps older persisted sizes and oversized reference decks at170', () => {
    for (const size of [171,200,280,1024]) expect(playerDockHeight(size)).toBe(170);
  });
  test('preserves valid user adjustments and enforces a usable lower bound', () => {
    for (const size of [136,144,156,168,170]) expect(playerDockHeight(size)).toBe(size);
    for (const size of [-1,0,90,110]) expect(playerDockHeight(size)).toBe(136);
  });
  test('invalid caller values cannot create an invalid CSS height', () => {
    for (const size of [NaN,Infinity,-Infinity]) expect(playerDockHeight(size)).toBe(170);
  });
  test('two-deck mode uses its own taller bounds; its default is 208 now that the overview left the dock', () => {
    expect(playerDockHeight(170, true)).toBe(200);
    expect(playerDockHeight(240, true)).toBe(240);
    expect(playerDockHeight(900, true)).toBe(280);
    expect(DECK_DEFAULT_HEIGHT).toBe(208);
    expect(playerDockHeight(NaN, true)).toBe(208);
  });
});

describe('the old two-deck default height', () => {
  const storage = (initial: Record<string, string> = {}) => {
    const values = new Map(Object.entries(initial));
    return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  };
  test('a stored 240, the old default and not a choice, becomes 208 once', () => {
    const store = storage({ [DECK_HEIGHT_KEY]: '240' });
    moveOldDeckHeight(store);
    expect(store.getItem(DECK_HEIGHT_KEY)).toBe('208');
  });
  test('any other stored height is kept, and so is no stored height', () => {
    for (const height of ['200', '224', '239', '241', '280']) {
      const store = storage({ [DECK_HEIGHT_KEY]: height });
      moveOldDeckHeight(store);
      expect(store.getItem(DECK_HEIGHT_KEY)).toBe(height);
    }
    const empty = storage();
    moveOldDeckHeight(empty);
    expect(empty.getItem(DECK_HEIGHT_KEY)).toBeNull();
  });
  test('it runs once: a height set to 240 afterwards is a choice and stays', () => {
    const store = storage({ [DECK_HEIGHT_KEY]: '240' });
    moveOldDeckHeight(store);
    store.setItem(DECK_HEIGHT_KEY, '240');
    moveOldDeckHeight(store);
    expect(store.getItem(DECK_HEIGHT_KEY)).toBe('240');
    // The single-deck height has its own key and is never touched.
    expect([...store.values.keys()].sort()).toEqual([DECK_HEIGHT_KEY, 'cm:deck-height-208']);
  });
  test('the shell moves it before the dock height is first read', () => {
    const shell = readFileSync(new URL('../src/components/layout/AppShell.tsx', import.meta.url), 'utf8');
    expect(shell.indexOf('moveOldDeckHeight(preferenceStorage)')).toBeGreaterThan(-1);
    expect(shell.indexOf('moveOldDeckHeight(preferenceStorage)')).toBeLessThan(shell.indexOf('storageKey: DECK_HEIGHT_KEY'));
  });
});

describe('dock placement', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
  const shell = read('../src/components/layout/AppShell.tsx');
  test('two decks move into a page column of at least 1,500 px; one deck, or a narrower column, keeps the full-width dock', () => {
    expect(DOCK_COLUMN_MIN_WIDTH).toBe(1500);
    expect(dockInColumn(1500, true)).toBe(true);
    expect(dockInColumn(1610, true)).toBe(true);
    expect(dockInColumn(1499, true)).toBe(false);
    expect(dockInColumn(2000, false)).toBe(false);
    expect(dockInColumn(0, true)).toBe(false); // before the first measurement
  });
  test('the shell is a grid: sidebar | page | rail over the bottom panel, mix strip and dock, placed by CSS only', () => {
    expect(shell).toContain('grid min-h-0 flex-1 grid-cols-[auto_minmax(0,1fr)_auto] grid-rows-[minmax(0,1fr)_auto_auto_auto]');
    expect(shell).toContain('const side = inColumn ? "[grid-row:1/5]" : "[grid-row:1]";');
    expect(shell).toContain('const under = inColumn ? "[grid-column:2]" : "[grid-column:1/4]";');
    expect(shell).toContain('<div className={cn("flex min-h-0 [grid-column:1]", side)}><Sidebar key={profile} /></div>');
    expect(shell).toContain('<div ref={railHost} data-page-rail className={cn("flex min-h-0 [grid-column:3]", side)} />');
    expect(shell).toContain('<PageRailContext.Provider value={rail}>{children}</PageRailContext.Provider>');
    // The dock is rendered once, unconditionally, so moving it never remounts the decks (and their audio).
    expect(shell.match(/<DeckDock\b/g)).toHaveLength(1);
    expect(shell).toContain('className={cn("relative z-20 min-w-0 [grid-row:4]", under,');
    expect(shell).toContain('const inColumn = dockInColumn(columnWidth, twoDeck);');
  });
  test('a right panel renders in place outside the shell; Set Builder and the tagging queue hand theirs to the rail', () => {
    expect(renderToString(createElement(PageRail, null, createElement('aside', null, 'panel')))).toBe('<aside>panel</aside>');
    for (const page of ['../src/pages/SetBuilder.tsx', '../src/pages/TaggingQueue.tsx']) {
      const src = read(page);
      expect(src.match(/<PageRail>/g)).toHaveLength(1);
      expect(src.match(/<\/PageRail>/g)).toHaveLength(1);
    }
  });
});
