import { ResolvedReferenceAttachment } from '../core/referenceManager';
import {
  diagnosePlatformTab,
  ensureTabContentScriptConnected,
  findMatchingPlatformTabs,
  getDefaultPlatformLaunchUrl,
  waitForTabLoadComplete
} from '../services/tabDiscovery';
import {
  GenerationSettings,
  PlatformId,
  PlatformTabDiagnostics,
  TaskRecord,
  TaskType
} from '../types/models';
import {
  AdapterDownloadActionResult,
  AdapterStatusInspection,
  AdapterSubmissionOptions,
  AdapterSubmissionResult,
  DetectedPlatformAsset,
  PlatformAdapter,
  PlatformAvailabilityResult
} from './types';

export type ContentScriptActionMessage =
  | {
      type: 'BS_ADAPTER_CHECK_AVAILABILITY';
      platformId: PlatformId;
      taskType?: TaskType;
      settings?: GenerationSettings;
    }
  | {
      type: 'BS_ADAPTER_ATTACH_REFERENCES';
      platformId: PlatformId;
      task: TaskRecord;
      references: ResolvedReferenceAttachment[];
    }
  | {
      type: 'BS_ADAPTER_SUBMIT_TASK';
      platformId: PlatformId;
      task: TaskRecord;
      references: ResolvedReferenceAttachment[];
      options?: AdapterSubmissionOptions;
    }
  | {
      type: 'BS_ADAPTER_GET_TASK_STATUS';
      platformId: PlatformId;
      task: TaskRecord;
    }
  | {
      type: 'BS_ADAPTER_GET_RESULTS';
      platformId: PlatformId;
      task: TaskRecord;
    }
  | {
      type: 'BS_ADAPTER_DOWNLOAD_RESULT';
      platformId: PlatformId;
      asset: DetectedPlatformAsset;
      suggestedFilename: string;
    }
  | {
      type: 'BS_ADAPTER_RECOVER_TASK';
      platformId: PlatformId;
      task: TaskRecord;
    }
  | {
      type: 'BS_PING';
      platformId: PlatformId;
    };

export class ChromeTabBridgeAdapter implements PlatformAdapter {
  public readonly platformId: PlatformId;
  private preferredTabId?: number;

  constructor(platformId: PlatformId, preferredTabId?: number) {
    this.platformId = platformId;
    this.preferredTabId = preferredTabId;
  }

  public async initialize(): Promise<void> {
    await this.resolveTargetTab();
  }

  public getPreferredTabId(): number | undefined {
    return this.preferredTabId;
  }

  public setPreferredTabId(tabId: number | undefined): void {
    this.preferredTabId = tabId;
  }

  public async resolveTargetTab(): Promise<chrome.tabs.Tab | null> {
    const matchingTabs = await findMatchingPlatformTabs(
      this.platformId,
      this.preferredTabId
    );
    if (matchingTabs.length === 0) {
      return null;
    }
    const chosen = matchingTabs[0];
    this.preferredTabId = chosen.id;
    return chosen;
  }

  public async getDiagnostics(): Promise<PlatformTabDiagnostics> {
    return diagnosePlatformTab(this.platformId, this.preferredTabId);
  }

  private async sendToTab<T>(message: ContentScriptActionMessage): Promise<T> {
    const tab = await this.resolveTargetTab();
    if (!tab || typeof tab.id !== 'number') {
      throw new Error('TARGET_TAB_NOT_FOUND');
    }

    const conn = await ensureTabContentScriptConnected(tab, this.platformId);
    if (!conn.connected) {
      throw new Error(conn.errorMessage || 'CONTENT_SCRIPT_UNREACHABLE');
    }

    try {
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch (msgErr) {
      const errMsg = msgErr instanceof Error ? msgErr.message : String(msgErr);
      if (
        errMsg.includes('Receiving end does not exist') ||
        errMsg.includes('Could not establish connection')
      ) {
        // Attempt injection once more and retry message
        const retryConn = await ensureTabContentScriptConnected(tab, this.platformId);
        if (retryConn.connected) {
          return await chrome.tabs.sendMessage(tab.id, message);
        }
      }
      throw msgErr;
    }
  }

  public async checkAvailability(
    taskType?: TaskType,
    settings?: GenerationSettings
  ): Promise<PlatformAvailabilityResult> {
    const platformLabel = this.platformId === 'chatgpt' ? 'ChatGPT' : 'Google Flow';
    const targetUrl = getDefaultPlatformLaunchUrl(this.platformId);

    // 1. Stage 1: Tab Discovery
    const matchingTabs = await findMatchingPlatformTabs(
      this.platformId,
      this.preferredTabId
    );

    if (matchingTabs.length === 0) {
      return {
        available: false,
        authenticated: false,
        correctPage: false,
        requestedModeAvailable: false,
        friendlyMessage: `${platformLabel} tab is not open.`,
        errorCode: 'TAB_NOT_FOUND',
        recommendedAction: `Click "Open ${platformLabel}" to launch ${platformLabel}, sign in if needed, and press Resume.`
      };
    }

    let targetTab = matchingTabs[0];
    this.preferredTabId = targetTab.id;

    let tabHostname = 'unknown';
    try {
      const rawUrl = targetTab.url || targetTab.pendingUrl || '';
      if (rawUrl) tabHostname = new URL(rawUrl).hostname;
    } catch {
      // Non-fatal
    }

    // 2. Stage 2: Tab Loading Status
    if (targetTab.status === 'loading') {
      // Wait briefly (up to 800ms) in case navigation is just finishing
      if (typeof targetTab.id === 'number') {
        try {
          targetTab = await waitForTabLoadComplete(targetTab.id, 800);
        } catch {
          // Non-fatal if wait expires
        }
      }

      if (targetTab.status === 'loading') {
        return {
          available: false,
          authenticated: false,
          correctPage: true,
          requestedModeAvailable: false,
          friendlyMessage: `${platformLabel} tab is loading... Waiting for page to finish loading.`,
          errorCode: 'TAB_LOADING',
          recommendedAction: `Wait for ${platformLabel} to finish loading in your browser. It will be detected automatically.`,
          diagnostics: `Tab ID: ${targetTab.id}, Hostname: ${tabHostname}, Status: loading`
        };
      }
    }

    // 3. Stage 3: Content Script Connectivity
    const conn = await ensureTabContentScriptConnected(targetTab, this.platformId);
    if (!conn.connected) {
      if (conn.state === 'tab_loading') {
        return {
          available: false,
          authenticated: false,
          correctPage: true,
          requestedModeAvailable: false,
          friendlyMessage: `${platformLabel} tab is loading...`,
          errorCode: 'TAB_LOADING',
          recommendedAction: `Wait for the ${platformLabel} page to finish loading.`
        };
      }

      if (conn.state === 'permission_error') {
        return {
          available: false,
          authenticated: false,
          correctPage: true,
          requestedModeAvailable: false,
          friendlyMessage: `Permission error communicating with ${platformLabel} tab.`,
          errorCode: 'PERMISSION_ERROR',
          recommendedAction: `Check that extension permissions allow access to ${tabHostname}.`,
          diagnostics: conn.errorMessage
        };
      }

      return {
        available: false,
        authenticated: false,
        correctPage: true,
        requestedModeAvailable: false,
        friendlyMessage: `${platformLabel} tab was found (Tab ID: ${targetTab.id}), but extension communication has not been established yet.`,
        errorCode: 'CONTENT_SCRIPT_NOT_READY',
        recommendedAction: `Refresh the ${platformLabel} tab and press Resume.`,
        diagnostics: `Tab ID: ${targetTab.id}, Hostname: ${tabHostname}. ${
          conn.errorMessage || 'Content script failed to respond to ping.'
        }`
      };
    }

    // 4. Stage 4: Application Readiness Check (via Content Script DOM inspection)
    try {
      const appResult = await this.sendToTab<PlatformAvailabilityResult>({
        type: 'BS_ADAPTER_CHECK_AVAILABILITY',
        platformId: this.platformId,
        taskType,
        settings
      });
      return appResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        available: false,
        authenticated: false,
        correctPage: true,
        requestedModeAvailable: false,
        friendlyMessage: `Communication with ${platformLabel} tab was interrupted.`,
        errorCode: 'COMMUNICATION_ERROR',
        recommendedAction: `Refresh the ${platformLabel} tab and press Resume.`,
        diagnostics: `Tab ID: ${targetTab.id}, Hostname: ${tabHostname}, Error: ${msg}`
      };
    }
  }

  public async attachReferences(
    task: TaskRecord,
    references: ResolvedReferenceAttachment[]
  ): Promise<{
    attached: boolean;
    errorCode?: 'REFERENCE_UPLOAD_FAILED';
    userMessage?: string;
    diagnostics?: string;
  }> {
    try {
      return await this.sendToTab({
        type: 'BS_ADAPTER_ATTACH_REFERENCES',
        platformId: this.platformId,
        task,
        references
      });
    } catch (err) {
      return {
        attached: false,
        errorCode: 'REFERENCE_UPLOAD_FAILED',
        userMessage: 'Lost connection to the website tab while attaching reference images.',
        diagnostics: err instanceof Error ? err.message : String(err)
      };
    }
  }

  public async submitTask(
    task: TaskRecord,
    references: ResolvedReferenceAttachment[],
    options?: AdapterSubmissionOptions
  ): Promise<AdapterSubmissionResult> {
    try {
      return await this.sendToTab<AdapterSubmissionResult>({
        type: 'BS_ADAPTER_SUBMIT_TASK',
        platformId: this.platformId,
        task,
        references,
        options
      });
    } catch (err) {
      return {
        submitted: false,
        errorCode: 'SUBMISSION_UNCERTAIN',
        userMessage:
          'Connection to the website tab was interrupted while submitting the prompt.',
        recommendedAction:
          'Inspect the website tab to check whether the prompt was submitted before clicking Retry.',
        diagnostics: err instanceof Error ? err.message : String(err)
      };
    }
  }

  public async getTaskStatus(task: TaskRecord): Promise<AdapterStatusInspection> {
    try {
      return await this.sendToTab<AdapterStatusInspection>({
        type: 'BS_ADAPTER_GET_TASK_STATUS',
        platformId: this.platformId,
        task
      });
    } catch (err) {
      return {
        state: 'unknown',
        detectedAssets: [],
        errorCode: 'PAGE_CLOSED_OR_NAVIGATED',
        userMessage: 'The target browser tab was closed or navigated away.',
        recommendedAction: 'Reopen the website tab and check generation status.',
        diagnostics: err instanceof Error ? err.message : String(err)
      };
    }
  }

  public async getResults(task: TaskRecord): Promise<DetectedPlatformAsset[]> {
    try {
      return await this.sendToTab<DetectedPlatformAsset[]>({
        type: 'BS_ADAPTER_GET_RESULTS',
        platformId: this.platformId,
        task
      });
    } catch {
      return [];
    }
  }

  public async downloadResult(
    asset: DetectedPlatformAsset,
    suggestedFilename: string
  ): Promise<AdapterDownloadActionResult> {
    try {
      return await this.sendToTab<AdapterDownloadActionResult>({
        type: 'BS_ADAPTER_DOWNLOAD_RESULT',
        platformId: this.platformId,
        asset,
        suggestedFilename
      });
    } catch (err) {
      return {
        initiated: false,
        method: 'manual_fallback',
        errorCode: 'DOWNLOAD_UNAVAILABLE',
        userMessage:
          err instanceof Error
            ? err.message
            : 'Could not trigger download on the website tab.'
      };
    }
  }

  public async recoverTask(task: TaskRecord): Promise<AdapterStatusInspection> {
    return this.getTaskStatus(task);
  }

  public async dispose(): Promise<void> {
    // No-op
  }
}
