import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { DECK_DEFAULT_HEIGHT, DECK_HEIGHT_KEY, DOCK_COLUMN_MIN_WIDTH, RAIL_TOP_MIN_COLUMN, dockSides, moveOldDeckHeight, playerDockHeight } from '../src/lib/playerLayout';
import { PageLeftRail, PageLeftRailContext, PageRail } from '../src/lib/pageRail';

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
  test('the dock keeps both decks whole from 1,312 px: both side columns reach the bottom when the column between them is that wide', () => {
    expect(DOCK_COLUMN_MIN_WIDTH).toBe(1312);
    // Library at 2,030 px: 232 px sidebar, 384 px inspector, 1,414 px between them.
    expect(dockSides(1414, 232, 384, true)).toBe('both');
    expect(dockSides(1312, 56, 360, true)).toBe('both'); // Set Builder beside the icon rail at 1,728 px
    // Library at 1,728 px: 1,112 px between; the right panel goes on down and the dock spans under the sidebar (1,344 px).
    expect(dockSides(1112, 232, 384, true)).toBe('right');
    // Under the icon rail the dock cannot span far enough, so the sidebar side goes down and the dock spans under the panel.
    expect(dockSides(1024, 56, 360, true)).toBe('left'); // Set Builder beside the icon rail at 1,440 px: 1,384 px dock
    // Library at 1,440 px: 824 px between, 1,056 / 1,208 px beside either column: the dock spans the window.
    expect(dockSides(824, 232, 384, true)).toBe('none');
    // No right panel: the sidebar reaches the bottom from a 1,312 px column (a 1,544 px window), as before from 1,496.
    expect(dockSides(1496, 232, 0, true)).toBe('both');
    expect(dockSides(1311, 232, 0, true)).toBe('none');
    // An empty side column never takes the bottom on its own.
    expect(dockSides(1200, 0, 0, true)).toBe('none');
    expect(dockSides(1200, 0, 384, true)).toBe('none');
    // One deck, or before the first measurement: the dock spans the window.
    expect(dockSides(2000, 232, 384, false)).toBe('none');
    expect(dockSides(0, 232, 384, true)).toBe('none');
  });
  test('the shell is a grid: left column | top deck panel over the page | right rail, over bottom panel, mix strip and dock, by CSS only', () => {
    expect(shell).toContain('grid min-h-0 flex-1 grid-cols-[auto_minmax(0,1fr)_auto] grid-rows-[auto_minmax(0,1fr)_auto_auto_auto]');
    // Both side columns run from under the top bar, beside the top deck panel, and on to the bottom when the dock leaves room.
    expect(shell).toContain('const leftRows = sides === "both" || sides === "left" ? "[grid-row:1/6]" : "[grid-row:1/3]";');
    // The rail takes the top row only beside a page column wide enough for the facts row; narrower, the lanes span over it.
    expect(RAIL_TOP_MIN_COLUMN).toBe(720);
    expect(shell).toContain('const railTop = widths.column >= RAIL_TOP_MIN_COLUMN;');
    expect(shell).toContain('const railRows = railTop ? (railDown ? "[grid-row:1/6]" : "[grid-row:1/3]") : (railDown ? "[grid-row:2/6]" : "[grid-row:2]");');
    expect(shell).toContain('const under = { both: "[grid-column:2]", left: "[grid-column:2/4]", right: "[grid-column:1/3]", none: "[grid-column:1/4]" }[sides];');
    expect(shell).toContain('<div ref={leftRef} className={cn("relative z-30 flex min-h-0 [grid-column:1]", leftRows)}>');
    expect(shell).toContain('<Sidebar key={profile} onFloating={setFloatingSidebar} />');
    expect(shell).toContain('<div ref={leftRailHost} data-page-left-rail className="flex min-h-0 bg-cm-bg/30 light:bg-transparent" />');
    // The top panel takes the width between the side columns, so the playhead centres there.
    expect(shell).toContain('{twoDeck && deckViewPosition === "top" && <div className={cn("min-w-0 [grid-row:1]", railTop ? "[grid-column:2]" : "[grid-column:2/4]")}><DeckViewSlot dockHeight={stackHeight} onHeight={IGNORE_PANEL_HEIGHT} position="top" /></div>}');
    expect(shell).toContain('className="min-h-0 min-w-0 overflow-hidden bg-cm-bg/30 [grid-area:2/2] light:bg-transparent"');
    expect(shell).toContain('<div ref={railHost} data-page-rail className={cn("flex min-h-0 [grid-column:3]", railRows)} />');
    expect(shell).toContain('<PageRailContext.Provider value={rail}><PageLeftRailContext.Provider value={leftRail}>{children}</PageLeftRailContext.Provider></PageRailContext.Provider>');
    expect(shell).toContain('<div className={cn("min-w-0 [grid-row:3]", under)}><DeckViewSlot dockHeight={stackHeight} onHeight={setPanelHeight} position="bottom" /></div>');
    // The dock is rendered once, unconditionally, so moving it never remounts the decks (and their audio).
    expect(shell.match(/<DeckDock\b/g)).toHaveLength(1);
    expect(shell).toContain('className={cn("relative z-20 min-w-0 [grid-row:5]", under,');
    expect(shell).toContain('const sides = dockSides(widths.column, widths.left, widths.right, twoDeck);');
    // Both hosts are made once, so a page's panel never remounts when the shell re-renders.
    expect(shell.match(/const \[(rail|leftHost)\] = useState\(\(\) => \{/g)).toHaveLength(2);
  });
  test('folding, unfolding or resizing the sidebar changes no shell element: the shell hears only whether it floats', () => {
    // The measured widths move the dock by CSS, and the floating flag only lets a page's left panel take the left column.
    expect(shell).not.toContain('sidebar-collapsed');
    expect(shell).not.toContain('sidebar-width');
    expect(shell.match(/<Sidebar\b/g)).toHaveLength(1);
    expect(shell.match(/<DeckViewSlot\b/g)).toHaveLength(2);
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
