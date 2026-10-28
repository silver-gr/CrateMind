import { afterEach, expect, test } from 'bun:test';
import { canAccessRoute, hasProviderWorkflows, parseCapabilities, loadCapabilities, resetCapabilities } from '../src/lib/capabilities';

const desktop = { identity: false, analysis: false, artist_enrichment: false, backup_import: true, complete_backup: false };
const python = { ...desktop, identity: true, analysis: true, artist_enrichment: true, backup_import: false, complete_backup: true };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; resetCapabilities(); });

test('identity route gates preserve ordinary library and DJ tool routes', () => {
  for (const route of ['/collections', '/canonical', '/unified', '/recovery', '/provenance']) {
    expect(canAccessRoute(desktop, route)).toBe(false);
    expect(canAccessRoute(python, route)).toBe(true);
  }
  for (const route of ['/dashboard', '/library', '/settings', '/key-harmony', '/collections-other']) {
    expect(canAccessRoute(desktop, route)).toBe(true);
  }
});

test('malformed or missing capability flags throw rather than silently disabling features', () => {
  expect(parseCapabilities(desktop)).toEqual(desktop);
  expect(() => parseCapabilities({})).toThrow();
  expect(() => parseCapabilities({ ...desktop, analysis: 'false' })).toThrow();
});

test('new desktop flags preserve older payload compatibility and explicit provider gates', () => {
  expect(hasProviderWorkflows(parseCapabilities(python))).toBe(true);
  expect(hasProviderWorkflows(parseCapabilities(desktop))).toBe(false);
  expect(hasProviderWorkflows(parseCapabilities({ ...python, provider_workflows: false }))).toBe(false);
  expect(parseCapabilities({ ...python, library_exchange: true, native_dialogs: true }).native_dialogs).toBe(true);
  expect(() => parseCapabilities({ ...python, native_dialogs: 'true' })).toThrow();
});

test('consumers share one request and failed discovery can be retried', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return calls === 1 ? Response.json({ detail: 'offline' }, { status: 503 }) : Response.json(desktop);
  }) as typeof fetch;
  const first = loadCapabilities();
  expect(loadCapabilities()).toBe(first);
  await expect(first).rejects.toThrow();
  expect(await loadCapabilities()).toEqual(desktop);
  expect(calls).toBe(2);
});
