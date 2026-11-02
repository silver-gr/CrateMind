import { useEffect, useSyncExternalStore } from "react";
import { preferenceStorage } from "./preferenceStorage";
import { getPref } from "./prefs";
import { createTablePreferenceStore } from "./tablePreferences";

export const tablePreferenceStore = createTablePreferenceStore(preferenceStorage, () => getPref("libraryProfile"));

export function useTablePreferences() {
  const preferences = useSyncExternalStore(tablePreferenceStore.subscribe, tablePreferenceStore.getSnapshot, tablePreferenceStore.getSnapshot);
  useEffect(() => { tablePreferenceStore.migrate(); }, []);
  return preferences;
}
