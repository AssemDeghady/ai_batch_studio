import { DEFAULT_PREFERENCES, PreferencesRecord } from '../types/models';

const PREFS_STORAGE_KEY = 'batch_studio_preferences_v1';
const ACTIVE_BATCH_KEY = 'batch_studio_active_batch_id_v1';

let memoryFallback: Record<string, unknown> = {};

function hasChromeStorage(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.storage && chrome.storage.local);
}

async function rawGet<T>(key: string): Promise<T | undefined> {
  if (hasChromeStorage()) {
    const result = await chrome.storage.local.get(key);
    return result[key] as T | undefined;
  }
  return memoryFallback[key] as T | undefined;
}

async function rawSet(key: string, value: unknown): Promise<void> {
  if (hasChromeStorage()) {
    await chrome.storage.local.set({ [key]: value });
    return;
  }
  memoryFallback[key] = value;
}

export async function getPreferences(): Promise<PreferencesRecord> {
  const stored = await rawGet<Partial<PreferencesRecord>>(PREFS_STORAGE_KEY);
  if (!stored) {
    return structuredClone(DEFAULT_PREFERENCES);
  }
  return {
    ...structuredClone(DEFAULT_PREFERENCES),
    ...stored,
    downloadPreferences: {
      ...structuredClone(DEFAULT_PREFERENCES.downloadPreferences),
      ...(stored.downloadPreferences || {}),
      autoNumbering: {
        ...structuredClone(DEFAULT_PREFERENCES.downloadPreferences.autoNumbering),
        ...(stored.downloadPreferences?.autoNumbering || {})
      }
    },
    timeoutSettings: {
      ...structuredClone(DEFAULT_PREFERENCES.timeoutSettings),
      ...(stored.timeoutSettings || {})
    },
    defaultGenerationSettings: {
      ...structuredClone(DEFAULT_PREFERENCES.defaultGenerationSettings),
      ...(stored.defaultGenerationSettings || {})
    }
  };
}

export async function savePreferences(
  updates: Partial<PreferencesRecord>
): Promise<PreferencesRecord> {
  const current = await getPreferences();
  const next: PreferencesRecord = {
    ...current,
    ...updates,
    downloadPreferences: updates.downloadPreferences
      ? {
          ...current.downloadPreferences,
          ...updates.downloadPreferences,
          autoNumbering: {
            ...current.downloadPreferences.autoNumbering,
            ...(updates.downloadPreferences.autoNumbering || {})
          }
        }
      : current.downloadPreferences,
    timeoutSettings: updates.timeoutSettings
      ? {
          ...current.timeoutSettings,
          ...updates.timeoutSettings
        }
      : current.timeoutSettings,
    defaultGenerationSettings: updates.defaultGenerationSettings
      ? {
          ...current.defaultGenerationSettings,
          ...updates.defaultGenerationSettings
        }
      : current.defaultGenerationSettings
  };
  await rawSet(PREFS_STORAGE_KEY, next);
  return next;
}

export async function getActiveBatchId(): Promise<string | null> {
  const id = await rawGet<string | null>(ACTIVE_BATCH_KEY);
  return id ?? null;
}

export async function setActiveBatchId(batchId: string | null): Promise<void> {
  await rawSet(ACTIVE_BATCH_KEY, batchId);
}

export function resetMemoryPreferencesForTest(): void {
  memoryFallback = {};
}
