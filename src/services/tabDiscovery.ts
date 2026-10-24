import {
  PlatformId,
  PlatformTabDiagnostics,
  TabConnectionState
} from '../types/models';

export function isGoogleFlowUrl(rawUrl: string | undefined | null): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;

    const hostname = url.hostname.toLowerCase();
    const pathname = url.pathname.toLowerCase();

    // 1. Dedicated domain: flow.google or *.flow.google
    if (hostname === 'flow.google' || hostname.endsWith('.flow.google')) {
      return true;
    }

    // 2. flow.google.com or *.flow.google.com
    if (hostname === 'flow.google.com' || hostname.endsWith('.flow.google.com')) {
      return true;
    }

    // 3. labs.google with flow/fx path
    if (hostname === 'labs.google' || hostname.endsWith('.labs.google')) {
      if (
        pathname.startsWith('/fx') ||
        pathname.startsWith('/tools/flow') ||
        pathname.startsWith('/flow')
      ) {
        return true;
      }
    }

    // 4. aitestkitchen.withgoogle.com with flow/fx path
    if (hostname === 'aitestkitchen.withgoogle.com') {
      if (
        pathname.startsWith('/tools/flow') ||
        pathname.startsWith('/flow') ||
        pathname.startsWith('/fx')
      ) {
        return true;
      }
    }

    // 5. aisandbox-pa.googleapis.com
    if (hostname.includes('aisandbox-pa.googleapis.com')) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

export function isChatGptUrl(rawUrl: string | undefined | null): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    const hostname = url.hostname.toLowerCase();
    return (
      hostname === 'chatgpt.com' ||
      hostname.endsWith('.chatgpt.com') ||
      hostname === 'chat.openai.com' ||
      hostname.endsWith('.chat.openai.com')
    );
  } catch {
    return false;
  }
}

export function isPlatformUrl(
  rawUrl: string | undefined | null,
  platformId: PlatformId
): boolean {
  return platformId === 'chatgpt'
    ? isChatGptUrl(rawUrl)
    : isGoogleFlowUrl(rawUrl);
}

export function getPlatformQueryPatterns(platformId: PlatformId): string[] {
  if (platformId === 'chatgpt') {
    return ['https://chatgpt.com/*', 'https://chat.openai.com/*'];
  }
  return [
    'https://flow.google/*',
    'https://*.flow.google/*',
    'https://flow.google.com/*',
    'https://*.flow.google.com/*',
    'https://labs.google/*',
    'https://aitestkitchen.withgoogle.com/*'
  ];
}

export function getDefaultPlatformLaunchUrl(platformId: PlatformId): string {
  return platformId === 'chatgpt'
    ? 'https://chatgpt.com/'
    : 'https://flow.google/';
}

export async function findMatchingPlatformTabs(
  platformId: PlatformId,
  preferredTabId?: number
): Promise<chrome.tabs.Tab[]> {
  if (typeof chrome === 'undefined' || !chrome.tabs) {
    return [];
  }

  const tabMap = new Map<number, chrome.tabs.Tab>();

  // 1. If preferredTabId is specified, check if it's still alive and valid
  if (preferredTabId !== undefined) {
    try {
      const tab = await chrome.tabs.get(preferredTabId);
      if (tab && typeof tab.id === 'number') {
        const candidateUrl = tab.url || tab.pendingUrl;
        if (isPlatformUrl(candidateUrl, platformId)) {
          tabMap.set(tab.id, tab);
        }
      }
    } catch {
      // Tab was closed or not found
    }
  }

  // 2. Query all open tabs across all windows
  try {
    const allTabs = await chrome.tabs.query({});
    for (const tab of allTabs) {
      if (typeof tab.id === 'number') {
        const candidateUrl = tab.url || tab.pendingUrl;
        if (isPlatformUrl(candidateUrl, platformId)) {
          tabMap.set(tab.id, tab);
        }
      }
    }
  } catch {
    // Non-fatal, try pattern-based query below
  }

  // 3. Complement with pattern-based query
  try {
    const patterns = getPlatformQueryPatterns(platformId);
    const patternTabs = await chrome.tabs.query({ url: patterns });
    for (const tab of patternTabs) {
      if (typeof tab.id === 'number') {
        tabMap.set(tab.id, tab);
      }
    }
  } catch {
    // Non-fatal
  }

  const matchingTabs = Array.from(tabMap.values());
  if (matchingTabs.length <= 1) {
    return matchingTabs;
  }

  // 4. Sort with prioritization:
  // - preferredTabId first
  // - active tab in focused window
  // - active tab in any window
  // - status complete over loading
  // - highest tab ID (most recently created)
  return matchingTabs.sort((a, b) => {
    if (preferredTabId !== undefined) {
      if (a.id === preferredTabId) return -1;
      if (b.id === preferredTabId) return 1;
    }
    if (a.active && !b.active) return -1;
    if (!a.active && b.active) return 1;
    if (a.status === 'complete' && b.status !== 'complete') return -1;
    if (a.status !== 'complete' && b.status === 'complete') return 1;
    return (b.id || 0) - (a.id || 0);
  });
}

export async function openOrFocusPlatformTab(
  platformId: PlatformId,
  preferredUrl?: string
): Promise<{ tab: chrome.tabs.Tab; wasAlreadyOpen: boolean }> {
  if (typeof chrome === 'undefined' || !chrome.tabs) {
    throw new Error('Chrome tabs API is unavailable');
  }

  const existingTabs = await findMatchingPlatformTabs(platformId);
  if (existingTabs.length > 0) {
    const target = existingTabs[0];
    if (typeof target.id === 'number') {
      try {
        if (typeof target.windowId === 'number' && chrome.windows?.update) {
          await chrome.windows.update(target.windowId, { focused: true });
        }
        const updated = await chrome.tabs.update(target.id, { active: true });
        return { tab: updated || target, wasAlreadyOpen: true };
      } catch {
        // Fall through to creating a new tab if update fails
      }
    }
  }

  const url = preferredUrl || getDefaultPlatformLaunchUrl(platformId);
  const newTab = await chrome.tabs.create({ url, active: true });
  return { tab: newTab, wasAlreadyOpen: false };
}

export async function waitForTabLoadComplete(
  tabId: number,
  timeoutMs = 8000
): Promise<chrome.tabs.Tab> {
  if (typeof chrome === 'undefined' || !chrome.tabs) {
    throw new Error('Chrome tabs API is unavailable');
  }

  const initialTab = await chrome.tabs.get(tabId);
  if (initialTab.status === 'complete') {
    return initialTab;
  }

  return new Promise<chrome.tabs.Tab>((resolve) => {
    let resolved = false;

    const timer = setTimeout(async () => {
      if (!resolved) {
        resolved = true;
        if (chrome.tabs?.onUpdated?.removeListener) {
          chrome.tabs.onUpdated.removeListener(onUpdatedListener);
        }
        try {
          const tab = await chrome.tabs.get(tabId);
          resolve(tab);
        } catch {
          resolve(initialTab);
        }
      }
    }, timeoutMs);

    const onUpdatedListener = (
      updatedTabId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab
    ) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          if (chrome.tabs?.onUpdated?.removeListener) {
            chrome.tabs.onUpdated.removeListener(onUpdatedListener);
          }
          resolve(tab);
        }
      }
    };

    if (chrome.tabs.onUpdated && chrome.tabs.onUpdated.addListener) {
      chrome.tabs.onUpdated.addListener(onUpdatedListener);
    }
  });
}

export async function pingTabContentScript(
  tabId: number,
  platformId: PlatformId,
  timeoutMs = 1500
): Promise<{ ok: boolean; version?: string; error?: string }> {
  if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.sendMessage) {
    return { ok: false, error: 'Chrome messaging unavailable' };
  }

  return new Promise((resolve) => {
    let responded = false;
    const timer = setTimeout(() => {
      if (!responded) {
        responded = true;
        resolve({ ok: false, error: 'Ping timed out' });
      }
    }, timeoutMs);

    chrome.tabs.sendMessage(
      tabId,
      { type: 'BS_PING', platformId },
      (response) => {
        if (responded) return;
        responded = true;
        clearTimeout(timer);
        const err = chrome.runtime?.lastError;
        if (err || !response) {
          resolve({ ok: false, error: err?.message || 'No response from content script' });
        } else if (response.ok) {
          resolve({ ok: true, version: response.version });
        } else {
          resolve({ ok: false, error: response.error || 'Content script responded with error' });
        }
      }
    );
  });
}

export async function ensureTabContentScriptConnected(
  tab: chrome.tabs.Tab,
  platformId: PlatformId
): Promise<{
  connected: boolean;
  state: TabConnectionState;
  tab: chrome.tabs.Tab;
  errorMessage?: string;
}> {
  if (typeof tab.id !== 'number') {
    return {
      connected: false,
      state: 'tab_not_found',
      tab,
      errorMessage: 'Invalid tab ID'
    };
  }

  // If the tab is still loading, wait a brief interval or report tab_loading
  if (tab.status === 'loading') {
    return {
      connected: false,
      state: 'tab_loading',
      tab,
      errorMessage: 'Tab is still loading'
    };
  }

  // 1. Try a harmless ping first
  const initialPing = await pingTabContentScript(tab.id, platformId, 1200);
  if (initialPing.ok) {
    return { connected: true, state: 'ready', tab };
  }

  // 2. Content script not answering; attempt dynamic injection via chrome.scripting
  if (typeof chrome !== 'undefined' && chrome.scripting && chrome.scripting.executeScript) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content/index.js']
      });

      // Brief delay to allow the content script to execute and attach listeners
      await new Promise((r) => setTimeout(r, 180));

      const retryPing = await pingTabContentScript(tab.id, platformId, 1500);
      if (retryPing.ok) {
        return { connected: true, state: 'ready', tab };
      }
      return {
        connected: false,
        state: 'content_script_not_ready',
        tab,
        errorMessage: retryPing.error || 'Content script failed to respond after injection'
      };
    } catch (injectErr) {
      const msg = injectErr instanceof Error ? injectErr.message : String(injectErr);
      const isPermissionErr =
        msg.includes('Cannot access') ||
        msg.includes('permission') ||
        msg.includes('host permission');
      return {
        connected: false,
        state: isPermissionErr ? 'permission_error' : 'communication_error',
        tab,
        errorMessage: msg
      };
    }
  }

  return {
    connected: false,
    state: 'content_script_not_ready',
    tab,
    errorMessage: initialPing.error || 'Content script unreachable'
  };
}

export async function diagnosePlatformTab(
  platformId: PlatformId,
  preferredTabId?: number
): Promise<PlatformTabDiagnostics> {
  const now = Date.now();
  const tabs = await findMatchingPlatformTabs(platformId, preferredTabId);

  if (tabs.length === 0) {
    return {
      platformId,
      connectionState: 'tab_not_found',
      tabFound: false,
      hasHostPermission: true,
      contentScriptResponding: false,
      lastErrorMessage: 'No matching tab was found in any browser window.',
      checkedAt: now
    };
  }

  const tab = tabs[0];
  let tabHostname: string | undefined;
  let tabUrlSanitized: string | undefined;

  try {
    const rawUrl = tab.url || tab.pendingUrl || '';
    if (rawUrl) {
      const parsed = new URL(rawUrl);
      tabHostname = parsed.hostname;
      tabUrlSanitized = `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`;
    }
  } catch {
    // Leave undefined if unparseable
  }

  if (tab.status === 'loading') {
    return {
      platformId,
      connectionState: 'tab_loading',
      tabFound: true,
      tabId: tab.id,
      tabUrl: tabUrlSanitized,
      tabHostname,
      tabStatus: 'loading',
      windowId: tab.windowId,
      hasHostPermission: true,
      contentScriptResponding: false,
      lastErrorMessage: 'The tab is currently loading.',
      checkedAt: now
    };
  }

  const conn = await ensureTabContentScriptConnected(tab, platformId);

  return {
    platformId,
    connectionState: conn.state,
    tabFound: true,
    tabId: tab.id,
    tabUrl: tabUrlSanitized,
    tabHostname,
    tabStatus: tab.status || 'complete',
    windowId: tab.windowId,
    hasHostPermission: conn.state !== 'permission_error',
    contentScriptResponding: conn.connected,
    lastErrorMessage: conn.errorMessage,
    checkedAt: now
  };
}
