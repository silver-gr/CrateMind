import { describe, expect, test } from 'bun:test';
import { matchSettingsSections, normalizeSearch, SETTINGS_GROUPS, SETTINGS_SECTIONS } from '../src/lib/settingsSections';

const ids = (query: string) => matchSettingsSections(SETTINGS_SECTIONS, query).map(section => section.id);

describe('settings sections', () => {
  test('every section belongs to a known group and ids are unique', () => {
    const groups = new Set(SETTINGS_GROUPS.map(group => group.id));
    expect(SETTINGS_SECTIONS.every(section => groups.has(section.group))).toBe(true);
    expect(new Set(SETTINGS_SECTIONS.map(section => section.id)).size).toBe(SETTINGS_SECTIONS.length);
  });

  test('normalizeSearch drops Greek accents, case and final sigma', () => {
    expect(normalizeSearch('  Εμφάνιση ')).toBe('εμφανιση');
    expect(normalizeSearch('ΚΥΜΑΤΟΜΟΡΦΈΣ')).toBe('κυματομορφεσ');
    expect(normalizeSearch('φάκελος')).toBe(normalizeSearch('ΦΑΚΕΛΟΣ'));
  });

  test('an empty query keeps every section', () => {
    expect(ids('   ')).toEqual(SETTINGS_SECTIONS.map(section => section.id));
  });

  test('matches labels and the settings a section holds, accent-insensitively', () => {
    expect(ids('εμφανιση')).toEqual(['appearance']);
    expect(ids('Maximizer')).toEqual(['playback']);
    expect(ids('vst3')).toEqual(['playback']);
    expect(ids('fpcalc')).toContain('scan');
  });

  test('every word must match', () => {
    expect(ids('beatgrid djay')).toEqual(['djay']);
    expect(ids('beatgrid maximizer')).toEqual([]);
  });
});
