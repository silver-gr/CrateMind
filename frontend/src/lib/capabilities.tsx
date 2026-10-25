import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';

export type BackendCapabilities = {
  identity: boolean;
  analysis: boolean;
  artist_enrichment: boolean;
  backup_import: boolean;
  complete_backup: boolean;
};

export function parseCapabilities(value: unknown): BackendCapabilities {
  if (!value || typeof value !== 'object' ||
      ['identity', 'analysis', 'artist_enrichment', 'backup_import', 'complete_backup'].some(key =>
        typeof (value as Record<string, unknown>)[key] !== 'boolean')) {
    throw new Error('Η εφαρμογή δεν επέστρεψε έγκυρες διαθέσιμες λειτουργίες.');
  }
  return value as BackendCapabilities;
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
export function canAccessRoute(capabilities: BackendCapabilities, path: string): boolean {
  const pathname = path.split(/[?#]/)[0];
  return capabilities.identity || !IDENTITY_ROUTES.some(route => pathname === route || pathname.startsWith(route + '/'));
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
