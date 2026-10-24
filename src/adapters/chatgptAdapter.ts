import { ResolvedReferenceAttachment } from '../core/referenceManager';
import { isChatGptUrl } from '../services/tabDiscovery';
import {
  discoverComposerCandidates,
  discoverSubmitControlCandidates,
  inspectObservableGenerationState,
  isElementVisible
} from '../browser/domInspection';
import {
  activateControlWithEvents,
  enterTextWithHumanEvents,
  verifySubmissionEvidence
} from '../browser/browserInteraction';
import {
  GenerationSettings,
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

export function dataUrlToFile(
  dataUrl: string,
  filename: string,
  mimeType: string
): File {
  const parts = dataUrl.split(',');
  const base64 = parts[1] || '';
  const binaryStr = typeof atob === 'function' ? atob(base64) : '';
  const len = binaryStr.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return new File([bytes], filename, { type: mimeType });
}

export class ChatGPTDomAdapter implements PlatformAdapter {
  public readonly platformId = 'chatgpt' as const;
  private doc: Document;
  private getLocationHref: () => string;
  private taskTurnBaseline = new Map<string, number>();

  constructor(doc?: Document, getLocationHref?: () => string) {
    this.doc = doc || (typeof document !== 'undefined' ? document : ({} as Document));
    this.getLocationHref =
      getLocationHref ||
      (() => (typeof window !== 'undefined' ? window.location.href : 'https://chatgpt.com/'));
  }

  public async initialize(): Promise<void> {
    // Ready to inspect DOM
  }

  public async checkAvailability(
    taskType: TaskType = 'image',
    _settings?: GenerationSettings
  ): Promise<PlatformAvailabilityResult> {
    if (taskType === 'video') {
      return {
        available: false,
        authenticated: true,
        correctPage: true,
        requestedModeAvailable: false,
        friendlyMessage: 'ChatGPT adapter only supports batch image generation.',
        errorCode: 'UNSUPPORTED_VIDEO_MODE',
        recommendedAction: 'Switch to Google Flow for video generation or select Image mode.'
      };
    }

    const href = this.getLocationHref();
    const isChatGptDomain = isChatGptUrl(href);

    if (!isChatGptDomain) {
      return {
        available: false,
        authenticated: false,
        correctPage: false,
        requestedModeAvailable: false,
        friendlyMessage: 'ChatGPT is not open in the active tab.',
        errorCode: 'WRONG_PAGE',
        recommendedAction: 'Open https://chatgpt.com in your browser tab and press Resume.'
      };
    }

    // Check for CAPTCHA / human verification challenge
    const challengeEl = this.doc.querySelector(
      'iframe[src*="challenges.cloudflare.com"], #challenge-running, [data-testid="challenge-stage"]'
    );
    if (challengeEl) {
      return {
        available: false,
        authenticated: false,
        correctPage: true,
        requestedModeAvailable: false,
        friendlyMessage: 'Website verification required.',
        errorCode: 'VERIFICATION_REQUIRED',
        recommendedAction:
          'Complete the verification challenge in the ChatGPT browser tab, then press Resume.'
      };
    }

    // Check for login required state
    const loginBtn = this.doc.querySelector(
      '[data-testid="login-button"], [data-testid="welcome-login-button"], a[href*="/auth/login"]'
    );
    if (loginBtn) {
      return {
        available: false,
        authenticated: false,
        correctPage: true,
        requestedModeAvailable: false,
        friendlyMessage: 'Login required.',
        errorCode: 'LOGIN_REQUIRED',
        recommendedAction:
          'Sign in to your ChatGPT account in the browser tab and press Resume.'
      };
    }

    const composerInspection = discoverComposerCandidates(this.doc, {
      preferredSelectors: [
        '#prompt-textarea',
        '[data-testid="composer-input"]',
        'div[contenteditable="true"]',
        'textarea'
      ]
    });

    if (!composerInspection.bestCandidate) {
      return {
        available: false,
        authenticated: true,
        correctPage: true,
        requestedModeAvailable: false,
        friendlyMessage: 'ChatGPT prompt input could not be found on the page.',
        errorCode: 'CONTROLS_NOT_FOUND',
        recommendedAction:
          'Ensure a ChatGPT conversation page is fully loaded and press Resume.',
        diagnostics: composerInspection.diagnostics
      };
    }

    return {
      available: true,
      authenticated: true,
      correctPage: true,
      requestedModeAvailable: true,
      friendlyMessage: 'Ready to start.'
    };
  }

  private findComposerElement(): HTMLElement | null {
    const inspection = discoverComposerCandidates(this.doc, {
      preferredSelectors: [
        '#prompt-textarea',
        '[data-testid="composer-input"]',
        'div[contenteditable="true"]',
        'textarea'
      ]
    });
    return inspection.bestCandidate?.element || null;
  }

  private findSendButton(): HTMLButtonElement | null {
    const composer = this.findComposerElement();
    const inspection = discoverSubmitControlCandidates(this.doc, composer, {
      preferredSelectors: [
        'button[data-testid="send-button"]',
        'button[aria-label*="Send prompt"]',
        'button[aria-label="Send"]',
        'button[aria-label*="send" i]'
      ]
    });
    return (inspection.bestCandidate?.element as HTMLButtonElement) || null;
  }

  private findStopButton(): HTMLElement | null {
    return this.doc.querySelector<HTMLElement>(
      'button[data-testid="stop-button"], button[aria-label="Stop" i], button[aria-label*="Stop" i], button[aria-label*="Cancel" i]'
    );
  }

  private findAssistantTurns(): HTMLElement[] {
    const turnEls = Array.from(
      this.doc.querySelectorAll<HTMLElement>(
        '[data-turn-key], [data-virtualized-turn-content], [data-content-search-turn-key], [data-message-author-role="assistant"], article[data-testid^="conversation-turn-"]'
      )
    );
    return turnEls.filter((el) => {
      return !turnEls.some((other) => other !== el && other.contains(el));
    });
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
    if (references.length === 0) {
      return { attached: true };
    }

    const fileInput = this.doc.querySelector<HTMLInputElement>(
      'input[type="file"][accept*="image"], input[type="file"]:not([ disabled ])'
    );

    if (!fileInput) {
      return {
        attached: false,
        errorCode: 'REFERENCE_UPLOAD_FAILED',
        userMessage:
          'Could not find the file attachment control on ChatGPT. Reference images could not be attached.',
        diagnostics: `Task ${task.id} required ${references.length} reference(s), but input[type="file"] was not found.`
      };
    }

    try {
      const files = references.map((ref) =>
        dataUrlToFile(ref.dataUrl, ref.metadata.name, ref.metadata.mimeType)
      );

      if (typeof DataTransfer !== 'undefined') {
        const dt = new DataTransfer();
        for (const file of files) {
          dt.items.add(file);
        }
        Object.defineProperty(fileInput, 'files', {
          value: dt.files,
          configurable: true
        });
      }

      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      fileInput.setAttribute('data-batch-studio-attached-count', String(files.length));
      return { attached: true };
    } catch (err) {
      return {
        attached: false,
        errorCode: 'REFERENCE_UPLOAD_FAILED',
        userMessage: 'Failed to attach reference image(s) to the ChatGPT composer.',
        diagnostics: err instanceof Error ? err.message : String(err)
      };
    }
  }

  public async submitTask(
    task: TaskRecord,
    _references: ResolvedReferenceAttachment[],
    options?: AdapterSubmissionOptions
  ): Promise<AdapterSubmissionResult> {
    const generationState = inspectObservableGenerationState(this.doc);
    if (generationState.stopButtonFound || this.findStopButton()) {
      return {
        submitted: false,
        errorCode: 'DUPLICATE_SUBMISSION_RISK',
        userMessage: 'ChatGPT is currently still generating a previous response.',
        recommendedAction: 'Wait for the current response to complete before submitting.',
        diagnostics: generationState.evidence
      };
    }

    const composerInspection = discoverComposerCandidates(this.doc, {
      preferredSelectors: [
        '#prompt-textarea',
        '[data-testid="composer-input"]',
        'div[contenteditable="true"]',
        'textarea'
      ]
    });

    const composer = composerInspection.bestCandidate?.element;
    if (!composer) {
      return {
        submitted: false,
        errorCode: 'CONTROLS_NOT_FOUND',
        userMessage: 'ChatGPT prompt box was not found.',
        recommendedAction: 'Ensure the ChatGPT tab is open and loaded.',
        diagnostics: composerInspection.diagnostics
      };
    }

    const baselineCount = this.findAssistantTurns().length;
    this.taskTurnBaseline.set(task.id, baselineCount);
    this.doc.body?.setAttribute('data-batch-studio-active-task', task.id);
    this.doc.body?.setAttribute('data-batch-studio-baseline-turns', String(baselineCount));

    const promptText = task.finalPromptSnapshot || task.originalPrompt;

    const entryResult = await enterTextWithHumanEvents(composer, promptText, {
      simulateTypingPause: options?.simulateTypingPause ?? false,
      clearFirst: true
    });

    if (!entryResult.verified) {
      return {
        submitted: false,
        errorCode: 'CONTROLS_NOT_FOUND',
        userMessage: 'Could not enter and verify prompt text in ChatGPT composer.',
        recommendedAction: 'Inspect the ChatGPT composer and press Resume.',
        diagnostics: entryResult.diagnostics
      };
    }

    const submitInspection = discoverSubmitControlCandidates(this.doc, composer, {
      preferredSelectors: [
        'button[data-testid="send-button"]',
        'button[aria-label*="Send prompt"]',
        'button[aria-label="Send"]',
        'button[aria-label*="send" i]'
      ]
    });

    const sendButton = submitInspection.bestCandidate?.element;

    const activation = await activateControlWithEvents(sendButton || composer, {
      keyboardFallbackComposer: composer,
      simulatePause: options?.simulateTypingPause ?? false
    });

    // Attempt trusted debugger click and Enter key via background service worker (sets event.isTrusted = true)
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      try {
        if (sendButton) {
          sendButton.setAttribute('data-batch-studio-click-target', 'true');
        }
        if (composer) {
          composer.setAttribute('data-batch-studio-composer-target', 'true');
        }
        if (sendButton) {
          const rect = sendButton.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            await chrome.runtime.sendMessage({
              type: 'BS_BG_DISPATCH_TRUSTED_CLICK',
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
              promptText
            });
          }
        }
        await chrome.runtime.sendMessage({
          type: 'BS_BG_DISPATCH_TRUSTED_ENTER'
        });
      } catch {
        // Fallback to DOM pointer events
      }
    }

    if (!activation.activated) {
      return {
        submitted: false,
        errorCode: 'CONTROLS_NOT_FOUND',
        userMessage: 'ChatGPT Send button was disabled or unavailable.',
        recommendedAction: 'Check the ChatGPT tab and try again.',
        diagnostics: `${submitInspection.diagnostics} ${activation.diagnostics}`
      };
    }

    // Verify observable post-activation evidence (allow up to 4s for network request)
    const verifyResult = await verifySubmissionEvidence(this.doc, {
      composerEl: composer,
      submitBtnEl: sendButton,
      previousTurnCount: baselineCount,
      expectedText: promptText,
      maxWaitMs: options?.maxWaitMs ?? 4000
    });

    if (verifyResult.confirmed) {
      return {
        submitted: true,
        diagnostics: `${composerInspection.diagnostics} | ${activation.diagnostics} | ${verifyResult.diagnostics}`
      };
    }

    if (verifyResult.uncertain) {
      return {
        submitted: false,
        errorCode: 'SUBMISSION_UNCERTAIN',
        userMessage: 'Prompt submission was attempted, but page state did not clearly confirm generation started.',
        recommendedAction: 'Inspect the ChatGPT tab. If the prompt is generating, resume; if idle, retry.',
        diagnostics: `${activation.diagnostics} | ${verifyResult.diagnostics}`
      };
    }

    return {
      submitted: false,
      errorCode: 'CONTROLS_NOT_FOUND',
      userMessage: 'ChatGPT Send button was activated, but the page did not accept the prompt submission.',
      recommendedAction: 'Ensure ChatGPT is active and prompt input is valid, then retry.',
      diagnostics: `${activation.diagnostics} | ${verifyResult.diagnostics}`
    };
  }

  public async getTaskStatus(task: TaskRecord): Promise<AdapterStatusInspection> {
    const challengeEl = this.doc.querySelector(
      'iframe[src*="challenges.cloudflare.com"], #challenge-running'
    );
    if (challengeEl) {
      return {
        state: 'failed',
        detectedAssets: [],
        errorCode: 'VERIFICATION_REQUIRED',
        userMessage: 'Verification challenge detected on ChatGPT.',
        recommendedAction: 'Complete the verification in the ChatGPT tab and resume.'
      };
    }

    const turns = this.findAssistantTurns();
    const storedBaselineAttr = this.doc.body?.getAttribute('data-batch-studio-baseline-turns');
    const baseline =
      this.taskTurnBaseline.get(task.id) ??
      (storedBaselineAttr ? Number(storedBaselineAttr) : Math.max(0, turns.length - 1));

    const newTurns = turns.slice(baseline);
    const stopBtn = this.findStopButton();

    // Check for explicit error banners inside the new turn or page
    const errorEl = this.doc.querySelector<HTMLElement>(
      '[data-testid="conversation-error"], .result-error, [role="alert"][data-error="true"]'
    );
    if (errorEl) {
      return {
        state: 'failed',
        detectedAssets: [],
        errorCode: 'GENERATION_FAILED',
        userMessage: errorEl.textContent?.trim() || 'ChatGPT reported an error during generation.',
        recommendedAction: 'Review the message on the ChatGPT tab and click Retry.'
      };
    }

    // Check if any new turn contains a policy refusal text without images
    for (const turn of newTurns) {
      const refusalEl = turn.querySelector('[data-testid="policy-refusal"], .policy-violation');
      if (refusalEl) {
        return {
          state: 'failed',
          detectedAssets: [],
          errorCode: 'GENERATION_FAILED',
          userMessage:
            refusalEl.textContent?.trim() ||
            'ChatGPT declined to generate this image due to content policy.',
          recommendedAction: 'Edit the prompt and retry the task.'
        };
      }
    }

    // Check if streaming or image progress indicator is still active inside the new turns
    const isGeneratingTurn = newTurns.some((turn) => {
      const busyEl = turn.querySelector(
        '[data-testid="image-gen-loading"], .dalle-progress, [aria-busy="true"], .result-streaming'
      );
      return Boolean(busyEl);
    });
    if (stopBtn || isGeneratingTurn) {
      return {
        state: 'active',
        detectedAssets: []
      };
    }

    // Extract generated images strictly from the new turns created for this task
    let assets = this.extractAssetsFromTurns(newTurns, task.id);
    if (assets.length === 0 && turns.length === 0) {
      // Fallback for minimal test fixture DOMs without conversation turns
      assets = this.extractAssetsFromTurns([this.doc.body || this.doc.documentElement], task.id);
    }
    if (assets.length > 0) {
      return {
        state: 'completed',
        detectedAssets: assets
      };
    }

    // If new turn exists but no image yet, ChatGPT is still rendering the image
    if (newTurns.length > 0) {
      const lastTurnText = newTurns[newTurns.length - 1].textContent?.toLowerCase() || '';
      if (
        lastTurnText.includes('unable to generate') ||
        lastTurnText.includes('cannot generate') ||
        lastTurnText.includes('violates our content policies') ||
        lastTurnText.includes('rate limit')
      ) {
        return {
          state: 'failed',
          detectedAssets: [],
          errorCode: 'GENERATION_FAILED',
          userMessage:
            newTurns[newTurns.length - 1].textContent?.trim().slice(0, 180) ||
            'ChatGPT could not generate the requested image.',
          recommendedAction: 'Review the response in ChatGPT, adjust the prompt if needed, and retry.'
        };
      }

      return {
        state: 'active',
        detectedAssets: []
      };
    }

    return {
      state: newTurns.length > 0 ? 'active' : 'idle',
      detectedAssets: []
    };
  }

  private extractAssetsFromTurns(
    turns: HTMLElement[],
    taskId: string
  ): DetectedPlatformAsset[] {
    const assets: DetectedPlatformAsset[] = [];
    const seenUrls = new Set<string>();
    let index = 0;

    for (const turn of turns) {
      const images = Array.from(
        turn.querySelectorAll<HTMLImageElement>(
          '[data-testid="generated-image-gallery"] img, [data-testid="generated-image-preview"] img, img[alt*="Generated" i], [data-web-image-tile] img, img[src*="oaiusercontent"], [data-testid="image-gen-result"] img, img.generated-image, img[src^="https://"], img[src^="data:image/"], img[src^="blob:"]'
        )
      );

      for (const img of images) {
        // Filter out tiny avatar or UI icons
        const widthAttr = Number(img.getAttribute('width') || 0);
        if (widthAttr > 0 && widthAttr <= 48) continue;
        if (img.alt?.toLowerCase().includes('avatar')) continue;
        if (img.src?.includes('chrome-extension://')) continue;

        const src = img.currentSrc || img.src || img.getAttribute('src') || '';
        if (!src) continue;
        if (seenUrls.has(src)) continue;
        seenUrls.add(src);

        const selectorId = `bs-chatgpt-img-${taskId}-${index}`;
        img.setAttribute('data-batch-studio-asset-id', selectorId);

        // Look for an associated download button near the image
        const container = img.closest('div, figure, article') || turn;
        const downloadBtn = container.querySelector<HTMLElement>(
          '[data-testid="download-image-button"], button[aria-label*="Download"], a[download]'
        );
        if (downloadBtn) {
          downloadBtn.setAttribute('data-batch-studio-dl-btn', selectorId);
        }

        const hasNativeDownload =
          Boolean(downloadBtn) ||
          Boolean(img.closest('button[data-testid="generated-image-preview"]')) ||
          Boolean(img.closest('[data-testid="generated-image-gallery"]')) ||
          src.startsWith('blob:') ||
          Boolean(this.doc.querySelector('button[aria-label="Download"], [data-testid="download-image-button"]'));

        const extMatch = /\.([a-z0-9]{3,4})(?:[?#]|$)/i.exec(src);
        const ext = extMatch
          ? extMatch[1].toLowerCase() === 'jpeg'
            ? 'jpg'
            : extMatch[1].toLowerCase()
          : 'png';

        assets.push({
          index,
          type: 'image',
          url: src,
          extension: ext,
          hasNativeDownloadButton: hasNativeDownload,
          elementSelectorId: selectorId
        });
        index++;
      }
    }

    return assets;
  }

  public async getResults(task: TaskRecord): Promise<DetectedPlatformAsset[]> {
    const status = await this.getTaskStatus(task);
    return status.detectedAssets;
  }

  public async downloadResult(
    asset: DetectedPlatformAsset,
    _suggestedFilename: string
  ): Promise<AdapterDownloadActionResult> {
    // 1. If an official download button is directly associated or already visible in a modal
    const associatedDlBtn = asset.elementSelectorId
      ? this.doc.querySelector<HTMLElement>(`[data-batch-studio-dl-btn="${asset.elementSelectorId}"]`)
      : null;
    const viewerDlBtn = this.doc.querySelector<HTMLElement>(
      'button[aria-label="Download"], a[aria-label="Download"], [data-testid="download-image-button"]'
    );
    const targetDirectBtn = associatedDlBtn || (viewerDlBtn && isElementVisible(viewerDlBtn) ? viewerDlBtn : null);

    if (targetDirectBtn) {
      targetDirectBtn.click();
      await new Promise((r) => setTimeout(r, 400));
      const closeBtn = this.doc.querySelector<HTMLElement>(
        'button[aria-label="Close viewer"], button[aria-label="Close"]'
      );
      if (closeBtn) closeBtn.click();
      return {
        initiated: true,
        method: 'native_button',
        resolvedUrl: asset.url
      };
    }

    // 2. If asset is a blob: URL in the ChatGPT tab, convert it directly to a lossless data URL for instant, guaranteed Chrome download
    if (asset.url && asset.url.startsWith('blob:')) {
      try {
        const response = await fetch(asset.url);
        const blob = await response.blob();
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });

        if (dataUrl && dataUrl.startsWith('data:')) {
          return {
            initiated: true,
            method: 'chrome_downloads',
            resolvedUrl: dataUrl
          };
        }
      } catch {
        // Fall through to lightbox viewer or direct URL
      }
    }

    // 3. Fallback: Click the image preview tile or thumbnail to open ChatGPT's full-size viewer lightbox
    const assetEl = asset.elementSelectorId
      ? this.doc.querySelector<HTMLElement>(`[data-batch-studio-asset-id="${asset.elementSelectorId}"]`)
      : null;
    const previewBtn =
      assetEl?.closest<HTMLElement>(
        'button[data-testid="generated-image-preview"], button[aria-label*="Generated" i], button'
      );

    if (previewBtn) {
      await activateControlWithEvents(previewBtn);
      await new Promise((r) => setTimeout(r, 600));
      const dlBtn = this.doc.querySelector<HTMLElement>(
        'button[aria-label="Download"], a[aria-label="Download"], [data-testid="download-image-button"]'
      );
      if (dlBtn) {
        dlBtn.click();
        await new Promise((r) => setTimeout(r, 400));
        const closeBtn = this.doc.querySelector<HTMLElement>(
          'button[aria-label="Close viewer"], button[aria-label="Close"]'
        );
        if (closeBtn) closeBtn.click();
        return {
          initiated: true,
          method: 'native_button',
          resolvedUrl: asset.url
        };
      }
    }

    // 4. Fallback to direct URL download if https:// or data:
    if (
      asset.url &&
      (asset.url.startsWith('https://') ||
        asset.url.startsWith('http://') ||
        asset.url.startsWith('data:'))
    ) {
      return {
        initiated: true,
        method: 'chrome_downloads',
        resolvedUrl: asset.url
      };
    }

    return {
      initiated: false,
      method: 'manual_fallback',
      errorCode: 'DOWNLOAD_UNAVAILABLE',
      userMessage: 'Could not download the generated image from ChatGPT.'
    };
  }

  public async recoverTask(task: TaskRecord): Promise<AdapterStatusInspection> {
    return this.getTaskStatus(task);
  }

  public async dispose(): Promise<void> {
    this.taskTurnBaseline.clear();
  }
}
