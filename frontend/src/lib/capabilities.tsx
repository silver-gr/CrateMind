import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
import type { LibraryProfile } from './prefs';

export type BackendCapabilities = {
  identity: boolean;
  analysis: boolean;
  artist_enrichment: boolean;
  backup_import: boolean;
  complete_backup: boolean;
  provider_workflows?: boolean;
  library_exchange?: boolean;
  native_dialogs?: boolean;
};

export function parseCapabilities(value: unknown): BackendCapabilities {
  if (!value || typeof value !== 'object' ||
      ['identity', 'analysis', 'artist_enrichment', 'backup_import', 'complete_backup'].some(key =>
        typeof (value as Record<string, unknown>)[key] !== 'boolean')) {
    throw new Error('Η εφαρμογή δεν επέστρεψε έγκυρες διαθέσιμες λειτουργίες.');
  }
  for (const key of ['provider_workflows', 'library_exchange', 'native_dialogs']) {
    const flag = (value as Record<string, unknown>)[key];
    if (flag !== undefined && typeof flag !== 'boolean') throw new Error('Μη έγκυρη διαθέσιμη λειτουργία.');
  }
  return value as BackendCapabilities;
}

export function hasProviderWorkflows(capabilities: BackendCapabilities): boolean {
  return capabilities.provider_workflows ?? capabilities.analysis;
}

let request: Promise<BackendCapabilities> | null = null;
export function resetCapabilities() { request = null; }
export function loadCapabilities(): Promise<BackendCapabilities> {
  if (!request) {
    request = api.capabilities().then(parseCapabilities).catch(error => {
      request = null;
      throw error;
    });
  }
  return request;
}

const IDENTITY_ROUTES = ['/collections', '/provenance', '/recovery', '/canonical', '/unified'];
/** DJ-only screens that the «Μουσικοθεραπεία» profile hides. */
export const THERAPY_HIDDEN_ROUTES = ['/flow', '/key-harmony', '/phrase-finder', '/smart-folders'];

function under(pathname: string, routes: readonly string[]): boolean {
  return routes.some(route => pathname === route || pathname.startsWith(route + '/'));
}

export function canAccessRoute(capabilities: BackendCapabilities, path: string, profile: LibraryProfile = 'dj'): boolean {
  const pathname = path.split(/[?#]/)[0];
  if (profile === 'therapy' && under(pathname, THERAPY_HIDDEN_ROUTES)) return false;
  return capabilities.identity || !under(pathname, IDENTITY_ROUTES);
}

export function filterRoutes<T extends { to: string }>(items: T[], capabilities: BackendCapabilities, profile: LibraryProfile): T[] {
  return items.filter(item => canAccessRoute(capabilities, item.to, profile));
}

/** Nav groups with hidden items and sub-items removed; a group left empty is dropped. Order is kept. */
export function visibleNavGroups<G extends { items: { to: string; subItems?: { to: string }[] }[] }>(
  groups: G[], capabilities: BackendCapabilities, profile: LibraryProfile,
): G[] {
  return groups.map(group => ({
    ...group,
    items: filterRoutes(group.items, capabilities, profile).map(item => item.subItems
      ? { ...item, subItems: filterRoutes(item.subItems, capabilities, profile) }
      : item),
  })).filter(group => group.items.length > 0);
}

const CapabilitiesContext = createContext<BackendCapabilities | null>(null);
export function useCapabilities(): BackendCapabilities {
  const value = useContext(CapabilitiesContext);
  if (!value) throw new Error('CapabilitiesProvider is required');
  return value;
}

export function CapabilitiesProvider({ children }: { children: ReactNode }) {
  const [value, setValue] = useState<BackendCapabilities | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    loadCapabilities().then(result => { if (active) setValue(result); })
      .catch(reason => { if (active) setError((reason as Error).message); });
    return () => { active = false; };
  }, [attempt]);
  if (error) return (
    <div role="alert" className="p-6 text-sm text-cm-text">
      <p>Δεν ήταν δυνατή η σύνδεση με την εφαρμογή. {error}</p>
      <button type="button" className="mt-3 rounded-lg border border-cm-border px-3 py-2" onClick={() => {
        resetCapabilities(); setError(''); setAttempt(current => current + 1);
      }}>Νέα προσπάθεια</button>
    </div>
  );
  if (!value) return <p role="status" className="p-6 text-sm text-cm-muted">Σύνδεση με την εφαρμογή…</p>;
  return <CapabilitiesContext.Provider value={value}>{children}</CapabilitiesContext.Provider>;
}
