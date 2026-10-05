/**
 * The app's `store.json` (tauri-plugin-store), shared by every feature that
 * keeps small settings there, so the file is only ever loaded once.
 */

import { load, type Store } from '@tauri-apps/plugin-store';

const STORE_FILE = 'store.json';

// Promise singleton so concurrent callers (React Strict Mode double-mount,
// several features) all reuse the same load() call. The `defaults: {}` is
// required by the plugin-store type definition even though each feature
// holds its own defaults.
let storePromise: Promise<Store> | null = null;

export function getAppStore(): Promise<Store> {
  if (storePromise === null) {
    storePromise = load(STORE_FILE, { autoSave: true, defaults: {} });
  }
  return storePromise;
}
