import 'fake-indexeddb/auto';
import { beforeEach, vi } from 'vitest';
import { closeAndResetDatabase } from '../src/storage/db';
import { resetMemoryPreferencesForTest } from '../src/storage/preferences';

// Setup global chrome mock for unit and integration tests
export interface MockDownloadRecord {
  id: number;
  url: string;
  filename: string;
  state: 'in_progress' | 'complete' | 'interrupted';
  error?: string;
}

export const mockChromeState = {
  storage: {} as Record<string, unknown>,
  downloads: new Map<number, MockDownloadRecord>(),
  nextDownloadId: 100,
  autoCompleteDownloads: true,
  simulateDownloadError: null as string | null,
  alarms: new Map<string, chrome.alarms.Alarm>(),
  notifications: [] as Array<{ id: string; title?: string; message?: string }>,
  tabs: new Map<number, chrome.tabs.Tab>(),
  nextTabId: 1,
  activeWindowId: 1,
  tabMessageHandlers: new Map<number, (message: unknown) => unknown>(),
  scriptingInjections: [] as Array<{ tabId: number; files?: string[] }>
};

export function resetMockChrome(): void {
  mockChromeState.storage = {};
  mockChromeState.downloads.clear();
  mockChromeState.nextDownloadId = 100;
  mockChromeState.autoCompleteDownloads = true;
  mockChromeState.simulateDownloadError = null;
  mockChromeState.alarms.clear();
  mockChromeState.notifications = [];
  mockChromeState.tabs.clear();
  mockChromeState.nextTabId = 1;
  mockChromeState.activeWindowId = 1;
  mockChromeState.tabMessageHandlers.clear();
  mockChromeState.scriptingInjections = [];
  mockChrome.runtime.lastError = undefined;
}

const tabUpdatedListeners = new Set<
  (tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => void
>();

const mockChrome = {
  runtime: {
    id: 'test-batch-studio-extension-id',
    lastError: undefined as { message: string } | undefined,
    getURL: (path: string) => `chrome-extension://test-batch-studio-extension-id/${path}`,
    sendMessage: vi.fn(async () => undefined),
    onMessage: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    },
    onStartup: {
      addListener: vi.fn()
    },
    onInstalled: {
      addListener: vi.fn()
    }
  },
  tabs: {
    query: vi.fn(async (queryInfo: chrome.tabs.QueryInfo) => {
      let results = Array.from(mockChromeState.tabs.values());
      if (queryInfo.currentWindow) {
        results = results.filter((t) => t.windowId === mockChromeState.activeWindowId);
      }
      if (queryInfo.active !== undefined) {
        results = results.filter((t) => t.active === queryInfo.active);
      }
      if (queryInfo.url) {
        const urlList = Array.isArray(queryInfo.url) ? queryInfo.url : [queryInfo.url];
        results = results.filter((t) => {
          const tabUrl = t.url || t.pendingUrl;
          if (!tabUrl) return false;
          return urlList.some((pat) => {
            const regexStr = pat.replace(/\./g, '\\.').replace(/\*/g, '.*');
            return new RegExp(`^${regexStr}$`).test(tabUrl);
          });
        });
      }
      return results;
    }),
    get: vi.fn(async (tabId: number) => {
      const tab = mockChromeState.tabs.get(tabId);
      if (!tab) {
        throw new Error(`No tab with id: ${tabId}`);
      }
      return tab;
    }),
    create: vi.fn(async (props: chrome.tabs.CreateProperties) => {
      const id = mockChromeState.nextTabId++;
      const newTab: chrome.tabs.Tab = {
        id,
        index: mockChromeState.tabs.size,
        windowId: props.windowId || mockChromeState.activeWindowId,
        highlighted: false,
        active: props.active !== false,
        selected: props.active !== false,
        pinned: false,
        incognito: false,
        url: props.url || 'about:blank',
        status: 'complete',
        discarded: false,
        autoDiscardable: true,
        groupId: -1
      };
      if (newTab.active) {
        for (const t of mockChromeState.tabs.values()) {
          if (t.windowId === newTab.windowId) t.active = false;
        }
      }
      mockChromeState.tabs.set(id, newTab);
      return newTab;
    }),
    update: vi.fn(async (tabId: number, props: chrome.tabs.UpdateProperties) => {
      const tab = mockChromeState.tabs.get(tabId);
      if (!tab) throw new Error(`No tab with id: ${tabId}`);
      if (props.url) tab.url = props.url;
      if (props.active) {
        for (const t of mockChromeState.tabs.values()) {
          if (t.windowId === tab.windowId) t.active = false;
        }
        tab.active = true;
      }
      mockChromeState.tabs.set(tabId, tab);
      return tab;
    }),
    sendMessage: vi.fn(
      (
        tabId: number,
        message: unknown,
        callback?: (response: unknown) => void
      ) => {
        const handler = mockChromeState.tabMessageHandlers.get(tabId);
        if (handler) {
          try {
            const res = handler(message);
            mockChrome.runtime.lastError = undefined;
            if (callback) callback(res);
            return Promise.resolve(res);
          } catch (err) {
            mockChrome.runtime.lastError = { message: String(err) };
            if (callback) callback(undefined);
            return Promise.reject(err);
          }
        }
        mockChrome.runtime.lastError = {
          message: 'Could not establish connection. Receiving end does not exist.'
        };
        if (callback) callback(undefined);
        return Promise.reject(new Error(mockChrome.runtime.lastError.message));
      }
    ),
    onUpdated: {
      addListener: vi.fn((listener) => tabUpdatedListeners.add(listener)),
      removeListener: vi.fn((listener) => tabUpdatedListeners.delete(listener))
    }
  },
  windows: {
    update: vi.fn(async (windowId: number, props: chrome.windows.UpdateInfo) => {
      if (props.focused) {
        mockChromeState.activeWindowId = windowId;
      }
      return { id: windowId, focused: Boolean(props.focused) } as chrome.windows.Window;
    })
  },
  scripting: {
    executeScript: vi.fn(async (injection: { target: { tabId: number }; files?: string[] }) => {
      mockChromeState.scriptingInjections.push({
        tabId: injection.target.tabId,
        files: injection.files
      });
      return [{ result: true }];
    })
  },
  storage: {
    local: {
      get: vi.fn(async (key: string) => ({ [key]: mockChromeState.storage[key] })),
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(mockChromeState.storage, items);
      })
    }
  },
  downloads: {
    download: vi.fn(
      (
        options: chrome.downloads.DownloadOptions,
        callback?: (downloadId?: number) => void
      ) => {
        const id = mockChromeState.nextDownloadId++;
        const state = mockChromeState.simulateDownloadError
          ? 'interrupted'
          : mockChromeState.autoCompleteDownloads
          ? 'complete'
          : 'in_progress';
        mockChromeState.downloads.set(id, {
          id,
          url: options.url,
          filename: options.filename || 'output.png',
          state,
          error: mockChromeState.simulateDownloadError || undefined
        });
        if (callback) callback(id);
        return Promise.resolve(id);
      }
    ),
    search: vi.fn(
      (
        query: chrome.downloads.DownloadQuery,
        callback?: (results: chrome.downloads.DownloadItem[]) => void
      ) => {
        const found = query.id
          ? [mockChromeState.downloads.get(query.id)].filter(Boolean)
          : Array.from(mockChromeState.downloads.values());
        if (callback) {
          callback(found as unknown as chrome.downloads.DownloadItem[]);
        }
        return Promise.resolve(found as unknown as chrome.downloads.DownloadItem[]);
      }
    ),
    onChanged: {
      addListener: vi.fn()
    },
    onDeterminingFilename: {
      addListener: vi.fn()
    }
  },
  alarms: {
    create: vi.fn((name: string) => {
      mockChromeState.alarms.set(name, { name, scheduledTime: Date.now() + 30000 });
    }),
    clear: vi.fn(async (name: string) => {
      mockChromeState.alarms.delete(name);
      return true;
    }),
    onAlarm: {
      addListener: vi.fn()
    }
  },
  notifications: {
    create: vi.fn((id: string, opts: chrome.notifications.NotificationOptions) => {
      mockChromeState.notifications.push({
        id,
        title: opts.title,
        message: opts.message
      });
    })
  }
};

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  writable: true,
  configurable: true
});

Object.defineProperty(globalThis, 'chrome', {
  value: mockChrome,
  writable: true,
  configurable: true
});

beforeEach(async () => {
  resetMockChrome();
  resetMemoryPreferencesForTest();
  await closeAndResetDatabase();
});
