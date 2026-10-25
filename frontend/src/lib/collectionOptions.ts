export type CollectionOption = {
  id: string;
  name: string;
  service: string;
  aliases?: string[];
  source_services?: string[];
  source_accounts?: string[];
};

let pending: Promise<CollectionOption[]> | undefined;
const listeners = new Set<() => void>();

/** Share one request across picker instances, including StrictMode remounts. */
export function loadCollectionOptions(): Promise<CollectionOption[]> {
  if (!pending) {
    const request = fetch('/api/identity/collections').then(async response => {
      if (!response.ok) throw Error('Αποτυχία φόρτωσης συλλογών');
      return response.json() as Promise<CollectionOption[]>;
    });
    pending = request;
    request.catch(() => { if (pending === request) pending = undefined; });
  }
  return pending;
}

export function invalidateCollectionOptions() {
  pending = undefined;
  for (const listener of listeners) listener();
}

export function subscribeCollectionOptions(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
