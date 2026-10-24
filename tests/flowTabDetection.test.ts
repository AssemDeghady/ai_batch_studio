import { beforeEach, describe, expect, it } from 'vitest';
import { ChromeTabBridgeAdapter } from '../src/adapters/tabBridgeAdapter';
import {
  diagnosePlatformTab,
  findMatchingPlatformTabs,
  isGoogleFlowUrl,
  openOrFocusPlatformTab
} from '../src/services/tabDiscovery';
import { mockChromeState, resetMockChrome } from './setup';

describe('Google Flow Tab Discovery & Readiness Regressions', () => {
  beforeEach(() => {
    resetMockChrome();
  });

  // 1. A valid Flow tab is open and is detected
  it('1. detects a valid Google Flow tab open at flow.google or labs.google/fx', async () => {
    const tab = await chrome.tabs.create({
      url: 'https://flow.google/project/test-1',
      active: true
    });

    const matching = await findMatchingPlatformTabs('google_flow');
    expect(matching).toHaveLength(1);
    expect(matching[0].id).toBe(tab.id);

    // Also verify labs.google/fx URL
    await chrome.tabs.create({
      url: 'https://labs.google/fx/tools/flow',
      active: false
    });
    const allMatching = await findMatchingPlatformTabs('google_flow');
    expect(allMatching).toHaveLength(2);
  });

  // 2. Flow is open in a background tab
  it('2. detects Flow when it is open in a background tab', async () => {
    // Other tab is active in current window
    await chrome.tabs.create({ url: 'https://news.ycombinator.com', active: true });
    // Flow is inactive / background tab
    const bgFlowTab = await chrome.tabs.create({
      url: 'https://flow.google.com/',
      active: false
    });

    const matching = await findMatchingPlatformTabs('google_flow');
    expect(matching).toHaveLength(1);
    expect(matching[0].id).toBe(bgFlowTab.id);
  });

  // 3. Flow is open in another browser window
  it('3. detects Flow when it is open in another browser window', async () => {
    mockChromeState.activeWindowId = 1;
    await chrome.tabs.create({ url: 'https://chatgpt.com', windowId: 1, active: true });

    // Open Flow in window 2
    const win2Tab = await chrome.tabs.create({
      url: 'https://flow.google/app',
      windowId: 2,
      active: true
    });

    const matching = await findMatchingPlatformTabs('google_flow');
    expect(matching).toHaveLength(1);
    expect(matching[0].id).toBe(win2Tab.id);
    expect(matching[0].windowId).toBe(2);
  });

  // 4. The Flow tab is still loading
  it('4. reports tab_loading when the Flow tab exists but is still loading', async () => {
    const tab = await chrome.tabs.create({
      url: 'https://flow.google/',
      active: true
    });
    // Set tab status to loading
    tab.status = 'loading';

    const adapter = new ChromeTabBridgeAdapter('google_flow', tab.id);
    const availability = await adapter.checkAvailability('image');

    expect(availability.available).toBe(false);
    expect(availability.errorCode).toBe('TAB_LOADING');
    expect(availability.friendlyMessage).toContain('loading');
    // Must NOT claim tab is not open!
    expect(availability.friendlyMessage).not.toBe('Google Flow tab is not open.');
    expect(availability.correctPage).toBe(true);

    const diag = await diagnosePlatformTab('google_flow', tab.id);
    expect(diag.tabFound).toBe(true);
    expect(diag.connectionState).toBe('tab_loading');
  });

  // 5. The tab exists but its content script is not yet responding
  it('5. separates tab existence from content script responsiveness (content_script_not_ready)', async () => {
    const tab = await chrome.tabs.create({
      url: 'https://flow.google/',
      active: true
    });
    tab.status = 'complete';

    // No message handler registered yet (content script unreachable)
    const adapter = new ChromeTabBridgeAdapter('google_flow', tab.id);
    const availability = await adapter.checkAvailability('image');

    expect(availability.available).toBe(false);
    expect(availability.errorCode).toBe('CONTENT_SCRIPT_NOT_READY');
    expect(availability.friendlyMessage).toContain('was found');
    expect(availability.friendlyMessage).not.toBe('Google Flow tab is not open.');
    expect(availability.correctPage).toBe(true);

    const diag = await diagnosePlatformTab('google_flow', tab.id);
    expect(diag.tabFound).toBe(true);
    expect(diag.connectionState).toBe('content_script_not_ready');
  });

  // 6. The content script becomes responsive after a retry / dynamic injection
  it('6. connects successfully when content script responds after injection retry', async () => {
    const tab = await chrome.tabs.create({
      url: 'https://flow.google/',
      active: true
    });
    tab.status = 'complete';

    let pingAttempts = 0;
    mockChromeState.tabMessageHandlers.set(tab.id!, (msg: any) => {
      pingAttempts++;
      if (msg.type === 'BS_PING') {
        // First ping fails, second ping succeeds after dynamic injection
        if (pingAttempts === 1) {
          throw new Error('Not ready yet');
        }
        return { ok: true, version: '1.0.0', ready: true };
      }
      if (msg.type === 'BS_ADAPTER_CHECK_AVAILABILITY') {
        return {
          available: true,
          authenticated: true,
          correctPage: true,
          requestedModeAvailable: true,
          friendlyMessage: 'Ready to start.'
        };
      }
      return { ok: true };
    });

    const adapter = new ChromeTabBridgeAdapter('google_flow', tab.id);
    const availability = await adapter.checkAvailability('image');

    expect(availability.available).toBe(true);
    expect(availability.friendlyMessage).toBe('Ready to start.');
    expect(mockChromeState.scriptingInjections).toHaveLength(1);
    expect(mockChromeState.scriptingInjections[0].tabId).toBe(tab.id);
  });

  // 7. No Flow tab exists
  it('7. reports TAB_NOT_FOUND when no Flow tab is open in any window', async () => {
    await chrome.tabs.create({ url: 'https://news.ycombinator.com', active: true });
    await chrome.tabs.create({ url: 'https://github.com', active: false });

    const adapter = new ChromeTabBridgeAdapter('google_flow');
    const availability = await adapter.checkAvailability('image');

    expect(availability.available).toBe(false);
    expect(availability.errorCode).toBe('TAB_NOT_FOUND');
    expect(availability.friendlyMessage).toBe('Google Flow tab is not open.');
    expect(availability.correctPage).toBe(false);

    const diag = await diagnosePlatformTab('google_flow');
    expect(diag.tabFound).toBe(false);
    expect(diag.connectionState).toBe('tab_not_found');
  });

  // 8. A URL that merely contains the word "flow" is not incorrectly accepted
  it('8. strictly rejects arbitrary URLs containing the substring "flow"', () => {
    // Unrelated sites with "flow" in domain or path
    expect(isGoogleFlowUrl('https://google.com/search?q=flow')).toBe(false);
    expect(isGoogleFlowUrl('https://flow.microsoft.com/en-us/')).toBe(false);
    expect(isGoogleFlowUrl('https://github.com/facebook/flow')).toBe(false);
    expect(isGoogleFlowUrl('https://example.com/flow')).toBe(false);
    expect(isGoogleFlowUrl('https://flow-art.org')).toBe(false);
    expect(isGoogleFlowUrl('https://flow.org')).toBe(false);
    expect(isGoogleFlowUrl('https://not-flow.google.evil.com/')).toBe(false);

    // Legitimate Google Flow URLs
    expect(isGoogleFlowUrl('https://flow.google/')).toBe(true);
    expect(isGoogleFlowUrl('https://flow.google/project/scene-1')).toBe(true);
    expect(isGoogleFlowUrl('https://flow.google.com/')).toBe(true);
    expect(isGoogleFlowUrl('https://labs.google/fx/tools/flow')).toBe(true);
    expect(isGoogleFlowUrl('https://labs.google/fx/flow')).toBe(true);
    expect(isGoogleFlowUrl('https://aitestkitchen.withgoogle.com/tools/flow')).toBe(true);
  });

  // 9. The user clicks the Flow link, navigation finishes, and detection succeeds without restarting
  it('9. focuses existing tab or opens Flow without creating duplicates and establishes connection', async () => {
    // Initial state: no Flow tab
    expect(await findMatchingPlatformTabs('google_flow')).toHaveLength(0);

    // Click 1: opens new Flow tab
    const openRes1 = await openOrFocusPlatformTab('google_flow');
    expect(openRes1.wasAlreadyOpen).toBe(false);
    expect(openRes1.tab.url).toBe('https://flow.google/');

    // Click 2: does NOT create duplicate tab! Focuses existing tab!
    const openRes2 = await openOrFocusPlatformTab('google_flow');
    expect(openRes2.wasAlreadyOpen).toBe(true);
    expect(openRes2.tab.id).toBe(openRes1.tab.id);

    const tabsAfter = await findMatchingPlatformTabs('google_flow');
    expect(tabsAfter).toHaveLength(1);
  });

  // 10. A failed ping does not incorrectly imply that the tab itself is absent
  it('10. ensures a failed ping reports content_script_not_ready, not tab_not_found', async () => {
    const tab = await chrome.tabs.create({
      url: 'https://flow.google/',
      active: true
    });
    tab.status = 'complete';

    // Simulate ping failure even after injection attempt
    const diag = await diagnosePlatformTab('google_flow', tab.id);
    expect(diag.tabFound).toBe(true);
    expect(diag.tabId).toBe(tab.id);
    expect(diag.tabHostname).toBe('flow.google');
    expect(diag.contentScriptResponding).toBe(false);
    expect(diag.connectionState).toBe('content_script_not_ready');
    // Critical: connectionState must NEVER be tab_not_found when tab exists!
    expect(diag.connectionState).not.toBe('tab_not_found');
  });
});
