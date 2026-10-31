import { ChromeTabBridgeAdapter } from '../adapters/tabBridgeAdapter';
import { PlatformAdapter } from '../adapters/types';
import {
  pauseBatchQueue,
  recoverQueueAfterRestart,
  resumeBatchQueue,
  retryAllFailedTasks,
  retrySelectedFailedTasks,
  retrySingleFailedTask,
  skipTask,
  startBatchQueue,
  stepBatchQueue,
  stopBatchQueue
} from '../core/queueEngine';
import {
  clearPendingNativeDownload,
  consumePendingDirectDownload,
  getPendingNativeDownload,
  handleChromeDownloadChanged,
  retryTaskDownloadsOnly
} from '../downloads/downloadManager';
import {
  appendDiagnosticLog,
  getBatch,
  getOutput,
  saveBatch,
  saveOutput
} from '../storage/db';
import { getActiveBatchId, getPreferences } from '../storage/preferences';
import {
  diagnosePlatformTab,
  isChatGptUrl,
  isGoogleFlowUrl,
  openOrFocusPlatformTab
} from '../services/tabDiscovery';
import { BatchStatus, PlatformId } from '../types/models';

export const QUEUE_ALARM_NAME = 'batch_studio_queue_poll_alarm';

export type BackgroundCommandMessage =
  | { type: 'BS_BG_START_BATCH'; batchId: string }
  | { type: 'BS_BG_PAUSE_BATCH'; batchId: string }
  | { type: 'BS_BG_RESUME_BATCH'; batchId: string }
  | { type: 'BS_BG_STOP_BATCH'; batchId: string }
  | { type: 'BS_BG_STEP_BATCH'; batchId: string }
  | { type: 'BS_BG_RETRY_TASK'; taskId: string; batchId: string }
  | { type: 'BS_BG_RETRY_SELECTED'; batchId: string; taskIds: string[] }
  | { type: 'BS_BG_RETRY_ALL_FAILED'; batchId: string }
  | { type: 'BS_BG_RETRY_DOWNLOAD'; taskId: string; batchId: string }
  | { type: 'BS_BG_SKIP_TASK'; taskId: string; batchId: string }
  | { type: 'BS_BG_RECOVER_ACTIVE' }
  | { type: 'BS_BG_DIAGNOSE_TAB'; platformId: PlatformId; batchId?: string }
  | { type: 'BS_BG_OPEN_OR_FOCUS_TAB'; platformId: PlatformId; batchId?: string }
  | { type: 'BS_BG_DISPATCH_TRUSTED_CLICK'; tabId?: number; x: number; y: number; promptText?: string }
  | { type: 'BS_BG_DISPATCH_TRUSTED_ENTER'; tabId?: number };

const debuggerTabLocks = new Map<number, Promise<unknown>>();

async function withDebuggerTabLock<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  const previous = debuggerTabLocks.get(tabId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  debuggerTabLocks.set(tabId, next);
  try {
    return await next;
  } finally {
    if (debuggerTabLocks.get(tabId) === next) {
      debuggerTabLocks.delete(tabId);
    }
  }
}

/**
 * Dispatches a trusted hardware-level mouse click via chrome.debugger CDP.
 * This sets event.isTrusted = true, satisfying strict frameworks like Google Flow.
 * If the target submit button is still disabled when the debugger attaches and `promptText` is provided,
 * it first hardware-clicks the Slate/contenteditable composer and inserts `promptText` via CDP `Input.insertText`
 * so the framework enables the submit button before clicking it.
 */
export async function dispatchDebuggerTrustedClick(
  tabId: number,
  x: number,
  y: number,
  promptText?: string
): Promise<{ success: boolean; btnEnabledBeforeClick?: boolean; error?: string }> {
  if (typeof chrome === 'undefined' || !chrome.debugger) {
    return { success: false, error: 'chrome.debugger API is not available' };
  }
  return withDebuggerTabLock(tabId, async () => {
    const target = { tabId };
    let attachedByUs = false;
    try {
      await chrome.debugger.attach(target, '1.3');
      attachedByUs = true;

      // Wait briefly for Chrome's debugger infobar layout shift to settle, then inspect
      // both the submit button state and the composer coordinates.
      await new Promise((r) => setTimeout(r, 60));
      let targetX = Math.round(x);
      let targetY = Math.round(y);
      let btnEnabledBeforeClick = false;
      try {
        const inspectRes = (await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
          expression: `(() => {
            const btn =
              document.querySelector('[data-batch-studio-click-target="true"]') ||
              document.querySelector('button[aria-label="Send"], button[data-testid="send-button"], [data-testid="fruitjuice-send-button"], button[aria-label*="Send" i]') ||
              document.querySelector('button.flow-icon-button-secondary');
            const comp =
              document.querySelector('[data-batch-studio-composer-target="true"]') ||
              document.querySelector('#prompt-textarea, [data-testid="composer-input"], div[contenteditable="true"], [data-slate-editor="true"], textarea');
            const btnRect = btn ? btn.getBoundingClientRect() : null;
            const compRect = comp ? comp.getBoundingClientRect() : null;
            const btnEnabled = Boolean(btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true' && !btn.hasAttribute('disabled'));
            return {
              btnX: btnRect && btnRect.width > 0 ? Math.round(btnRect.left + btnRect.width / 2) : null,
              btnY: btnRect && btnRect.height > 0 ? Math.round(btnRect.top + btnRect.height / 2) : null,
              btnEnabled,
              compX: compRect && compRect.width > 0 ? Math.round(compRect.left + compRect.width / 2) : null,
              compY: compRect && compRect.height > 0 ? Math.round(compRect.top + compRect.height / 2) : null
            };
          })()`,
          returnByValue: true
        })) as {
          result?: {
            value?: {
              btnX?: number | null;
              btnY?: number | null;
              btnEnabled?: boolean;
              compX?: number | null;
              compY?: number | null;
            };
          };
        } | undefined;

        const info = inspectRes?.result?.value;
        btnEnabledBeforeClick = Boolean(info?.btnEnabled);
        if (typeof info?.btnX === 'number' && typeof info?.btnY === 'number') {
          targetX = info.btnX;
          targetY = info.btnY;
        }

        // If the submit button is still disabled and we have promptText + composer coordinates,
        // hardware-click the composer and insert text via CDP Input.insertText so Slate enables the button!
        if (
          promptText &&
          info &&
          info.btnEnabled === false &&
          typeof info.compX === 'number' &&
          typeof info.compY === 'number'
        ) {
          await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: info.compX,
            y: info.compY,
            button: 'left',
            buttons: 1,
            clickCount: 1
          });
          await new Promise((r) => setTimeout(r, 35));
          await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: info.compX,
            y: info.compY,
            button: 'left',
            buttons: 0,
            clickCount: 1
          });
          await new Promise((r) => setTimeout(r, 60));

          // Select and delete any existing partial text in the focused composer
          await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
            expression: `(() => {
              const comp = document.querySelector('[data-batch-studio-composer-target="true"]') || document.querySelector('[data-slate-editor="true"], div[contenteditable="true"], textarea');
              if (!comp) return;
              comp.focus();
              const sel = window.getSelection();
              if (sel) {
                const range = document.createRange();
                range.selectNodeContents(comp);
                sel.removeAllRanges();
                sel.addRange(range);
              }
              document.execCommand('selectAll', false);
              document.execCommand('delete', false);
            })()`
          });
          await new Promise((r) => setTimeout(r, 40));

          await chrome.debugger.sendCommand(target, 'Input.insertText', {
            text: promptText
          });
          await new Promise((r) => setTimeout(r, 180));

          // Re-read the live coordinates of the now-enabled submit button
          const postTextRes = (await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
            expression: `(() => {
              const el =
                document.querySelector('[data-batch-studio-click-target="true"]') ||
                document.querySelector('button[aria-label="Send"]:not([disabled]), button[data-testid="send-button"]:not([disabled]), button[aria-label*="Send" i]:not([disabled])') ||
                document.querySelector('button.flow-icon-button-secondary:not([disabled])');
              if (!el) return null;
              const r = el.getBoundingClientRect();
              const enabled = Boolean(!el.disabled && el.getAttribute('aria-disabled') !== 'true' && !el.hasAttribute('disabled'));
              if (r.width <= 0 || r.height <= 0) return { enabled };
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), enabled };
            })()`,
            returnByValue: true
          })) as { result?: { value?: { x?: number; y?: number; enabled?: boolean } } } | undefined;
          if (typeof postTextRes?.result?.value?.enabled === 'boolean') {
            btnEnabledBeforeClick = postTextRes.result.value.enabled;
          }
          if (
            typeof postTextRes?.result?.value?.x === 'number' &&
            typeof postTextRes?.result?.value?.y === 'number'
          ) {
            targetX = postTextRes.result.value.x;
            targetY = postTextRes.result.value.y;
          }
        }
      } catch {}

      await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: targetX,
        y: targetY
      });
      await new Promise((r) => setTimeout(r, 35));
      await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: targetX,
        y: targetY,
        button: 'left',
        buttons: 1,
        clickCount: 1
      });
      await new Promise((r) => setTimeout(r, 50));
      await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: targetX,
        y: targetY,
        button: 'left',
        buttons: 0,
        clickCount: 1
      });
      await chrome.debugger.detach(target);
      attachedByUs = false;
      return { success: true, btnEnabledBeforeClick };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (attachedByUs) {
        try {
          await chrome.debugger.detach(target);
        } catch {}
      }
      return { success: false, error: errorMsg };
    }
  });
}

/**
 * Dispatches a trusted Enter key event via chrome.debugger CDP.
 */
export async function dispatchDebuggerTrustedEnter(
  tabId: number
): Promise<{ success: boolean; error?: string }> {
  if (typeof chrome === 'undefined' || !chrome.debugger) {
    return { success: false, error: 'chrome.debugger API is not available' };
  }
  return withDebuggerTabLock(tabId, async () => {
    const target = { tabId };
    let attachedByUs = false;
    try {
      await chrome.debugger.attach(target, '1.3');
      attachedByUs = true;
      // Focus composer before dispatching Enter
      try {
        await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
          expression: `(() => {
            const comp =
              document.querySelector('[data-batch-studio-composer-target="true"]') ||
              document.querySelector('#prompt-textarea, [data-testid="composer-input"], div[contenteditable="true"], [data-slate-editor="true"], textarea');
            if (comp) comp.focus();
          })()`
        });
        await new Promise((r) => setTimeout(r, 40));
      } catch {}
      await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        windowsVirtualKeyCode: 13,
        unmodifiedText: '\r',
        text: '\r',
        code: 'Enter',
        key: 'Enter'
      });
      await new Promise((r) => setTimeout(r, 35));
      await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        windowsVirtualKeyCode: 13,
        unmodifiedText: '\r',
        text: '\r',
        code: 'Enter',
        key: 'Enter'
      });
      await chrome.debugger.detach(target);
      attachedByUs = false;
      return { success: true };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (attachedByUs) {
        try {
          await chrome.debugger.detach(target);
        } catch {}
      }
      return { success: false, error: errorMsg };
    }
  });
}

let activePollTimer: ReturnType<typeof setTimeout> | null = null;
let customAdapterFactory: ((batchId: string) => Promise<PlatformAdapter>) | null = null;

export function setCustomAdapterFactoryForTest(
  factory: ((batchId: string) => Promise<PlatformAdapter>) | null
): void {
  customAdapterFactory = factory;
}

async function getAdapterForBatch(batchId: string): Promise<PlatformAdapter> {
  if (customAdapterFactory) {
    return customAdapterFactory(batchId);
  }
  const batch = await getBatch(batchId);
  if (!batch) {
    throw new Error(`Batch ${batchId} not found`);
  }
  return new ChromeTabBridgeAdapter(batch.platform, batch.targetTabId);
}

async function notifyUser(title: string, message: string): Promise<void> {
  try {
    const prefs = await getPreferences();
    if (!prefs.notificationsEnabled) return;
    if (typeof chrome !== 'undefined' && chrome.notifications && chrome.notifications.create) {
      chrome.notifications.create(`bs_notif_${Date.now()}`, {
        type: 'basic',
        iconUrl: 'icons/icon-128.png',
        title,
        message
      });
    }
  } catch {
    // Non-fatal if notifications permission is unavailable
  }
}

function broadcastStateUpdate(batchId: string, status: BatchStatus): void {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime
        .sendMessage({
          type: 'BS_STATE_UPDATED',
          batchId,
          status,
          timestamp: Date.now()
        })
        .catch(() => {
          // Popup may be closed; expected in background operation
        });
    }
  } catch {
    // Expected when no UI listeners are open
  }
}

async function scheduleNextPoll(batchId: string): Promise<void> {
  if (activePollTimer) {
    clearTimeout(activePollTimer);
    activePollTimer = null;
  }

  const batch = await getBatch(batchId);
  if (!batch || batch.status !== 'running') {
    if (typeof chrome !== 'undefined' && chrome.alarms) {
      await chrome.alarms.clear(QUEUE_ALARM_NAME);
    }
    return;
  }

  const pollIntervalMs = Math.max(1500, (batch.timeoutSettings.pollIntervalSec || 3) * 1000);

  // Schedule Chrome alarm for service-worker suspension resilience
  if (typeof chrome !== 'undefined' && chrome.alarms) {
    chrome.alarms.create(QUEUE_ALARM_NAME, {
      periodInMinutes: 0.5
    });
  }

  // Also schedule short timer while service worker is awake
  activePollTimer = setTimeout(() => {
    runScheduledQueueTick(batchId).catch(() => {
      // Logged inside tick
    });
  }, pollIntervalMs);
}

export async function runScheduledQueueTick(batchId?: string): Promise<void> {
  const targetBatchId = batchId || (await getActiveBatchId());
  if (!targetBatchId) return;

  const beforeBatch = await getBatch(targetBatchId);
  if (!beforeBatch || beforeBatch.status !== 'running') return;

  const adapter = await getAdapterForBatch(targetBatchId);
  const { batch: afterBatch } = await stepBatchQueue(targetBatchId, adapter);

  broadcastStateUpdate(afterBatch.id, afterBatch.status);

  if (beforeBatch.status === 'running' && afterBatch.status === 'completed') {
    await notifyUser(
      'Batch Completed — AI Batch Studio',
      `Batch "${afterBatch.name}" has finished processing all tasks.`
    );
  } else if (beforeBatch.status === 'running' && afterBatch.status === 'needs_attention') {
    await notifyUser(
      'Action Needed — AI Batch Studio',
      `Batch "${afterBatch.name}" needs your attention on the platform tab.`
    );
  } else if (
    beforeBatch.status === 'running' &&
    afterBatch.status === 'paused' &&
    (afterBatch.consecutiveFailureCount || 0) >= (afterBatch.circuitBreakerLimit ?? 3)
  ) {
    await notifyUser(
      'Circuit Breaker Tripped — AI Batch Studio',
      `Batch "${afterBatch.name}" paused automatically after ${afterBatch.consecutiveFailureCount} consecutive task failures to protect credits.`
    );
  }

  await scheduleNextPoll(afterBatch.id);
}

export async function handleBackgroundCommand(
  cmd: BackgroundCommandMessage,
  senderTabId?: number
): Promise<unknown> {
  switch (cmd.type) {
    case 'BS_BG_START_BATCH': {
      const adapter = await getAdapterForBatch(cmd.batchId);
      const res = await startBatchQueue(cmd.batchId, adapter);
      broadcastStateUpdate(res.batch.id, res.batch.status);
      await scheduleNextPoll(res.batch.id);
      return res;
    }

    case 'BS_BG_PAUSE_BATCH': {
      const res = await pauseBatchQueue(cmd.batchId);
      broadcastStateUpdate(res.batch.id, res.batch.status);
      await scheduleNextPoll(res.batch.id);
      return res;
    }

    case 'BS_BG_RESUME_BATCH': {
      const adapter = await getAdapterForBatch(cmd.batchId);
      const res = await resumeBatchQueue(cmd.batchId, adapter);
      broadcastStateUpdate(res.batch.id, res.batch.status);
      await scheduleNextPoll(res.batch.id);
      return res;
    }

    case 'BS_BG_STOP_BATCH': {
      const res = await stopBatchQueue(cmd.batchId);
      broadcastStateUpdate(res.batch.id, res.batch.status);
      await scheduleNextPoll(res.batch.id);
      return res;
    }

    case 'BS_BG_STEP_BATCH': {
      const adapter = await getAdapterForBatch(cmd.batchId);
      const res = await stepBatchQueue(cmd.batchId, adapter);
      broadcastStateUpdate(res.batch.id, res.batch.status);
      await scheduleNextPoll(res.batch.id);
      return res;
    }

    case 'BS_BG_RETRY_TASK': {
      const adapter = await getAdapterForBatch(cmd.batchId);
      const task = await retrySingleFailedTask(cmd.taskId, adapter);
      const batch = await getBatch(cmd.batchId);
      if (batch) {
        broadcastStateUpdate(batch.id, batch.status);
        await scheduleNextPoll(batch.id);
      }
      return task;
    }

    case 'BS_BG_RETRY_SELECTED': {
      const adapter = await getAdapterForBatch(cmd.batchId);
      const tasks = await retrySelectedFailedTasks(cmd.batchId, cmd.taskIds, adapter);
      const batch = await getBatch(cmd.batchId);
      if (batch) {
        broadcastStateUpdate(batch.id, batch.status);
        await scheduleNextPoll(batch.id);
      }
      return tasks;
    }

    case 'BS_BG_RETRY_ALL_FAILED': {
      const adapter = await getAdapterForBatch(cmd.batchId);
      const tasks = await retryAllFailedTasks(cmd.batchId, adapter);
      const batch = await getBatch(cmd.batchId);
      if (batch) {
        broadcastStateUpdate(batch.id, batch.status);
        await scheduleNextPoll(batch.id);
      }
      return tasks;
    }

    case 'BS_BG_RETRY_DOWNLOAD': {
      const adapter = await getAdapterForBatch(cmd.batchId);
      const task = await retryTaskDownloadsOnly(cmd.taskId, adapter);
      const batch = await getBatch(cmd.batchId);
      if (batch) {
        broadcastStateUpdate(batch.id, batch.status);
      }
      return task;
    }

    case 'BS_BG_SKIP_TASK': {
      const skipped = await skipTask(cmd.taskId);
      const batch = await getBatch(cmd.batchId);
      if (batch && batch.status === 'running') {
        const adapter = await getAdapterForBatch(cmd.batchId);
        await stepBatchQueue(cmd.batchId, adapter);
      }
      if (batch) {
        broadcastStateUpdate(batch.id, batch.status);
      }
      return skipped;
    }

    case 'BS_BG_RECOVER_ACTIVE': {
      const activeBatchId = await getActiveBatchId();
      if (!activeBatchId) return null;
      const batch = await getBatch(activeBatchId);
      if (!batch || batch.status !== 'running') return batch;
      const adapter = await getAdapterForBatch(activeBatchId);
      const recovered = await recoverQueueAfterRestart(activeBatchId, adapter);
      broadcastStateUpdate(recovered.batch.id, recovered.batch.status);
      await scheduleNextPoll(recovered.batch.id);
      return recovered;
    }

    case 'BS_BG_DIAGNOSE_TAB': {
      let targetTabId: number | undefined;
      if (cmd.batchId) {
        const batch = await getBatch(cmd.batchId);
        targetTabId = batch?.targetTabId;
      }
      return await diagnosePlatformTab(cmd.platformId, targetTabId);
    }

    case 'BS_BG_OPEN_OR_FOCUS_TAB': {
      const result = await openOrFocusPlatformTab(cmd.platformId);
      if (cmd.batchId && result.tab?.id) {
        const batch = await getBatch(cmd.batchId);
        if (batch) {
          const updatedBatch = {
            ...batch,
            targetTabId: result.tab.id,
            updatedAt: Date.now()
          };
          await saveBatch(updatedBatch);
          broadcastStateUpdate(updatedBatch.id, updatedBatch.status);
        }
      }
      return result;
    }
    case 'BS_BG_DISPATCH_TRUSTED_CLICK': {
      let targetTabId = cmd.tabId || senderTabId;
      if (!targetTabId && typeof chrome !== 'undefined' && chrome.tabs) {
        const tabs = await chrome.tabs.query({});
        const platformTab = tabs.find((t) => t.url && (isGoogleFlowUrl(t.url) || isChatGptUrl(t.url)));
        targetTabId = platformTab?.id || tabs.find((t) => t.active)?.id;
      }
      if (!targetTabId) return { success: false, error: 'No active tab ID available' };
      return await dispatchDebuggerTrustedClick(targetTabId, cmd.x, cmd.y, cmd.promptText);
    }

    case 'BS_BG_DISPATCH_TRUSTED_ENTER': {
      let targetTabId = cmd.tabId || senderTabId;
      if (!targetTabId && typeof chrome !== 'undefined' && chrome.tabs) {
        const tabs = await chrome.tabs.query({});
        const platformTab = tabs.find((t) => t.url && (isGoogleFlowUrl(t.url) || isChatGptUrl(t.url)));
        targetTabId = platformTab?.id || tabs.find((t) => t.active)?.id;
      }
      if (!targetTabId) return { success: false, error: 'No active tab ID available' };
      return await dispatchDebuggerTrustedEnter(targetTabId);
    }
  }
}

export async function initializeBackgroundServiceWorker(): Promise<void> {
  if (typeof chrome === 'undefined') return;

  // 0. Enable side panel on toolbar action click (Chrome 116+)
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }

  // 1. Handle startup / wake-up recovery
  if (chrome.runtime?.onStartup) {
    chrome.runtime.onStartup.addListener(() => {
      handleBackgroundCommand({ type: 'BS_BG_RECOVER_ACTIVE' }).catch((err) => {
        appendDiagnosticLog({
          level: 'error',
          scope: 'background',
          message: `Startup recovery failed: ${err instanceof Error ? err.message : String(err)}`
        });
      });
    });
  }

  if (chrome.runtime?.onInstalled) {
    chrome.runtime.onInstalled.addListener(() => {
      appendDiagnosticLog({
        level: 'info',
        scope: 'background',
        message: 'Batch Studio extension installed/updated.'
      });
    });
  }

  // 2. Handle alarms for background queue polling after service worker sleep
  if (chrome.alarms?.onAlarm) {
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === QUEUE_ALARM_NAME) {
        runScheduledQueueTick().catch(() => {});
      }
    });
  }

  // 3. Track Chrome download lifecycle changes
  if (chrome.downloads?.onChanged) {
    chrome.downloads.onChanged.addListener((delta) => {
      handleChromeDownloadChanged(delta)
        .then(({ updatedTask }) => {
          if (updatedTask) {
            broadcastStateUpdate(updatedTask.batchId, 'running');
            runScheduledQueueTick(updatedTask.batchId).catch(() => {});
          }
        })
        .catch(() => {});
    });
  }

  // 4. Intercept downloads to enforce custom filename template, subfolder, and .png extension (preventing .jfif overrides)
  if (chrome.downloads?.onDeterminingFilename) {
    chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
      const directPending = consumePendingDirectDownload(
        item.id,
        item.url,
        (item as { finalUrl?: string }).finalUrl,
        (item as { byExtensionId?: string }).byExtensionId
      );
      if (directPending) {
        suggest({
          filename: directPending.relativePath.replace(/\.jfif$/i, '.png'),
          conflictAction: directPending.conflictAction
        });
        return true;
      }

      const pending = getPendingNativeDownload();
      if (pending) {
        clearPendingNativeDownload();
        getOutput(pending.outputId)
          .then((output) => {
            if (output) {
              saveOutput({
                ...output,
                downloadId: item.id,
                status: output.status === 'completed' ? 'completed' : 'in_progress'
              });
            }
          })
          .catch(() => {});
        suggest({
          filename: pending.relativePath.replace(/\.jfif$/i, '.png'),
          conflictAction: 'uniquify'
        });
        return true;
      }

      if (item.filename && /\.(jfif|jpe?g)$/i.test(item.filename)) {
        suggest({
          filename: item.filename.replace(/\.(jfif|jpe?g)$/i, '.png'),
          conflictAction: 'uniquify'
        });
        return true;
      }

      suggest();
      return false;
    });
  }

  // 5. Handle UI commands over chrome.runtime.onMessage
  if (chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener(
      (message: BackgroundCommandMessage, sender, sendResponse) => {
        if (!message || typeof message.type !== 'string' || !message.type.startsWith('BS_BG_')) {
          return false;
        }
        handleBackgroundCommand(message, sender.tab?.id)
          .then((res) => sendResponse({ ok: true, data: res }))
          .catch((err) =>
            sendResponse({
              ok: false,
              error: err instanceof Error ? err.message : String(err)
            })
          );
        return true;
      }
    );
  }
}

// IMPORTANT: Only auto-initialize listeners when running inside the actual MV3 Background
// Service Worker (ServiceWorkerGlobalScope has no `window`). Never register background
// listeners inside `index.html` (`assets/popup.js`), otherwise both the Side Panel UI
// and the Service Worker will handle every `BS_BG_*` message and `chrome.debugger.attach`
// simultaneously!
if (typeof window === 'undefined') {
  initializeBackgroundServiceWorker().catch(() => {});
}
