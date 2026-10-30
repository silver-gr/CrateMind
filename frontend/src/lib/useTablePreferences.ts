import { useEffect, useSyncExternalStore } from "react";
import { preferenceStorage } from "./preferenceStorage";
import { createTablePreferenceStore } from "./tablePreferences";

export const tablePreferenceStore = createTablePreferenceStore(preferenceStorage);

export function useTablePreferences() {
  const preferences = useSyncExternalStore(tablePreferenceStore.subscribe, tablePreferenceStore.getSnapshot, tablePreferenceStore.getSnapshot);
  useEffect(() => { tablePreferenceStore.migrate(); }, []);
  return preferences;
}
