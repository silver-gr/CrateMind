import { describe, expect, test } from 'bun:test';
import { playerDockHeight } from '../src/lib/playerLayout';

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
});
