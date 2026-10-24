import { ResolvedReferenceAttachment } from '../core/referenceManager';
import { validateFlowCapabilities } from '../core/queueEngine';
import { isGoogleFlowUrl } from '../services/tabDiscovery';
import {
  discoverComposerCandidates,
  discoverSubmitControlCandidates,
  inspectObservableGenerationState,
  isElementVisible,
  queryGeneratedOutputElements
} from '../browser/domInspection';
import {
  activateControlWithEvents,
  enterTextWithHumanEvents,
  triggerEnterKeySubmission,
  verifySubmissionEvidence
} from '../browser/browserInteraction';
import {
  FLOW_MODEL_CAPABILITIES,
  GenerationSettings,
  TaskRecord,
  TaskType
} from '../types/models';
import { dataUrlToFile } from './chatgptAdapter';
import {
  AdapterDownloadActionResult,
  AdapterStatusInspection,
  AdapterSubmissionOptions,
  AdapterSubmissionResult,
  DetectedPlatformAsset,
  PlatformAdapter,
  PlatformAvailabilityResult
} from './types';

export class GoogleFlowDomAdapter implements PlatformAdapter {
  public readonly platformId = 'google_flow' as const;
  private doc: Document;
  private getLocationHref: () => string;
  private taskBaselineOutputCount = new Map<string, number>();
  private taskBaselineOutputUrls = new Map<string, Set<string>>();

  constructor(doc?: Document, getLocationHref?: () => string) {
    this.doc = doc || (typeof document !== 'undefined' ? document : ({} as Document));
    this.getLocationHref =
      getLocationHref ||
      (() =>
        typeof window !== 'undefined' ? window.location.href : 'https://labs.google/fx/tools/flow');
  }

  public async initialize(): Promise<void> {
    // Ready
  }

  public async checkAvailability(
    taskType: TaskType = 'image',
    settings?: GenerationSettings
  ): Promise<PlatformAvailabilityResult> {
    const href = this.getLocationHref();
    const isFlowDomain = isGoogleFlowUrl(href);

    if (!isFlowDomain) {
      return {
        available: false,
        authenticated: false,
        correctPage: false,
        requestedModeAvailable: false,
        friendlyMessage: 'Google Flow is not open in the active tab.',
        errorCode: 'WRONG_PAGE',
        recommendedAction:
          'Open https://flow.google/ in your browser tab and press Resume.'
      };
    }

    // Check for sign-in prompt
    const signInEl = this.doc.querySelector(
      'a[href*="accounts.google.com/ServiceLogin"], button[data-testid="flow-sign-in"], [data-auth-required="true"]'
    );
    if (signInEl) {
      return {
        available: false,
        authenticated: false,
        correctPage: true,
        requestedModeAvailable: false,
        friendlyMessage: 'Login required.',
        errorCode: 'LOGIN_REQUIRED',
        recommendedAction:
          'Sign in with your Google account on the Google Flow tab and press Resume.'
      };
    }

    // Validate model and mode capability rules
    if (settings) {
      const capCheck = validateFlowCapabilities(taskType, settings);
      if (!capCheck.valid) {
        return {
          available: false,
          authenticated: true,
          correctPage: true,
          requestedModeAvailable: false,
          friendlyMessage: capCheck.reason || 'Requested mode is unavailable for the selected model.',
          errorCode: 'UNSUPPORTED_VIDEO_MODE',
          recommendedAction: 'Select a supported model or video mode in settings.'
        };
      }

      // Check if the page explicitly marks the requested mode or model as unavailable in this account
      if (taskType === 'video' && settings.videoMode) {
        const disabledModeBtn = this.doc.querySelector<HTMLElement>(
          `[data-video-mode="${settings.videoMode}"][disabled], [data-video-mode="${settings.videoMode}"][aria-disabled="true"]`
        );
        if (disabledModeBtn) {
          return {
            available: false,
            authenticated: true,
            correctPage: true,
            requestedModeAvailable: false,
            friendlyMessage: `The "${settings.videoMode.replace(
              /_/g,
              ' '
            )}" workflow is currently unavailable in your Google Flow account or selected model.`,
            errorCode: 'UNSUPPORTED_VIDEO_MODE',
            recommendedAction:
              'Switch to a supported video mode (such as Text-to-Video) or select another model.'
          };
        }
      }
    }

    const composerInspection = discoverComposerCandidates(this.doc, {
      preferredSelectors: [
        'div.ProseMirror[contenteditable="true"]',
        'div[contenteditable="true"].ProseMirror',
        'textarea[data-testid="flow-prompt-input"]',
        'textarea[placeholder*="prompt" i]',
        'textarea[placeholder*="Describe" i]',
        'div[contenteditable="true"][data-testid="flow-prompt-input"]',
        'div[contenteditable="true"]',
        'textarea'
      ]
    });

    const promptInput = composerInspection.bestCandidate?.element || null;
    if (!promptInput) {
      // Check if page/app is still initializing (loading spinner, skeleton, splash)
      const isLoadingApp = Boolean(
        this.doc.querySelector(
          '[data-testid="flow-loading"], .flow-loader, [role="progressbar"], .splash-screen, .loading-indicator, [aria-busy="true"]'
        )
      );

      if (isLoadingApp) {
        return {
          available: false,
          authenticated: true,
          correctPage: true,
          requestedModeAvailable: false,
          friendlyMessage: 'Google Flow application is still loading...',
          errorCode: 'FLOW_NOT_READY',
          recommendedAction:
            'Wait for Google Flow to finish loading its workspace or select a project.'
        };
      }

      return {
        available: false,
        authenticated: true,
        correctPage: true,
        requestedModeAvailable: false,
        friendlyMessage: 'Google Flow generation controls were not found on the current page.',
        errorCode: 'CONTROLS_NOT_FOUND',
        recommendedAction:
          'Open an active project inside Google Flow so the prompt composer is visible, then press Resume.',
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

  private findPromptInput(): HTMLElement | null {
    const inspection = discoverComposerCandidates(this.doc, {
      preferredSelectors: [
        'div.ProseMirror[contenteditable="true"]',
        'div[contenteditable="true"].ProseMirror',
        'textarea[data-testid="flow-prompt-input"]',
        'textarea[placeholder*="prompt" i]',
        'textarea[placeholder*="Describe" i]',
        'div[contenteditable="true"][data-testid="flow-prompt-input"]',
        'div[contenteditable="true"]',
        'textarea'
      ]
    });
    return inspection.bestCandidate?.element || null;
  }

  private findGenerateButton(): HTMLButtonElement | null {
    const explicit = this.doc.querySelector<HTMLButtonElement>(
      'button.generate-icon-button, button[aria-label*="Start generation" i]'
    );
    if (explicit && isElementVisible(explicit)) {
      return explicit;
    }
    const composer = this.findPromptInput();
    const inspection = discoverSubmitControlCandidates(this.doc, composer, {
      preferredSelectors: [
        'button.generate-icon-button',
        'button[aria-label*="Start generation" i]',
        'button[data-testid="flow-generate-button"]',
        'button.flow-icon-button-secondary',
        'button[aria-label*="Generate" i]',
        'button[aria-label*="Run" i]',
        'button[aria-label*="Submit" i]',
        'button[aria-label*="Send" i]',
        'button[type="submit"]'
      ]
    });
    return (inspection.bestCandidate?.element as HTMLButtonElement) || null;
  }

  private findOutputElements(taskType: TaskType): HTMLElement[] {
    return queryGeneratedOutputElements(this.doc, taskType);
  }

  private applyGenerationSettingsToControls(
    taskType: TaskType,
    settings: GenerationSettings
  ): void {
    // Select taskType tab (Image vs Video) ONLY when explicit tablist or data-flow-tab is available.
    // Avoid clicking the dock's settings pill which would open a modal popup.
    const modeTab = this.doc.querySelector<HTMLElement>(
      `[data-flow-tab="${taskType}"], [role="tablist"] [role="tab"][aria-label*="${
        taskType === 'video' ? 'Video' : 'Image'
      }" i], [role="tablist"] button[aria-label*="${
        taskType === 'video' ? 'Video' : 'Image'
      }" i]`
    );
    if (modeTab) modeTab.click();

    // Select video workflow sub-mode if video
    if (taskType === 'video' && settings.videoMode) {
      const videoModeControl = this.doc.querySelector<HTMLElement>(
        `[data-video-mode="${settings.videoMode}"], button[data-mode="${settings.videoMode}"]`
      );
      if (videoModeControl && !videoModeControl.hasAttribute('disabled')) {
        videoModeControl.click();
      }
    }

    // Aspect ratio — only click explicit data-aspect-ratio controls; never click dock summary pill!
    if (settings.aspectRatio) {
      const ratioBtn = this.doc.querySelector<HTMLElement>(
        `[data-aspect-ratio="${settings.aspectRatio}"]`
      );
      if (ratioBtn) ratioBtn.click();
    }

    // Duration (for video) — only click explicit data-duration controls
    if (taskType === 'video' && settings.durationSec) {
      const durBtn = this.doc.querySelector<HTMLElement>(
        `[data-duration="${settings.durationSec}"]`
      );
      if (durBtn) durBtn.click();
    }

    // Output count
    if (settings.outputCount) {
      const countBtn = this.doc.querySelector<HTMLElement>(
        `[data-output-count="${settings.outputCount}"]`
      );
      if (countBtn) countBtn.click();
    }

    // Dismiss any open settings popups or dropdown dialogs to clear the dock for submission
    try {
      const closeDialogBtn = this.doc.querySelector<HTMLElement>(
        '[role="dialog"] button[aria-label*="Close" i], .settings-dialog button[aria-label*="Close" i]'
      );
      if (closeDialogBtn) {
        closeDialogBtn.click();
      }
    } catch {}
  }

  public async attachReferences(
    task: TaskRecord,
    references: ResolvedReferenceAttachment[]
  ): Promise<{
    attached: boolean;
    errorCode?: 'REFERENCE_UPLOAD_FAILED' | 'UNSUPPORTED_VIDEO_MODE';
    userMessage?: string;
    diagnostics?: string;
  }> {
    if (references.length === 0) {
      return { attached: true };
    }

    const modelId = task.generationSettings.model;
    if (modelId && FLOW_MODEL_CAPABILITIES[modelId] && !FLOW_MODEL_CAPABILITIES[modelId].supportsReferences) {
      return {
        attached: false,
        errorCode: 'UNSUPPORTED_VIDEO_MODE',
        userMessage: `Selected model "${FLOW_MODEL_CAPABILITIES[modelId].label}" does not support reference attachments.`
      };
    }

    // Check for dedicated start/end frame slots when in start_end_frame mode
    const videoMode = task.generationSettings.videoMode;
    if (task.taskType === 'video' && videoMode === 'start_end_frame') {
      const startInput = this.doc.querySelector<HTMLInputElement>(
        'input[type="file"][data-frame-role="start"], input[type="file"][data-testid="start-frame-input"], input[type="file"]'
      );
      if (!startInput) {
        return {
          attached: false,
          errorCode: 'REFERENCE_UPLOAD_FAILED',
          userMessage:
            'Could not find the start/end frame upload inputs on Google Flow.',
          diagnostics: 'Missing input[type="file"] for start_end_frame workflow.'
        };
      }
    }

    const fileInputs = Array.from(
      this.doc.querySelectorAll<HTMLInputElement>(
        'input[type="file"][accept*="image"], input[type="file"]:not([disabled])'
      )
    );

    if (fileInputs.length === 0) {
      return {
        attached: false,
        errorCode: 'REFERENCE_UPLOAD_FAILED',
        userMessage:
          'Google Flow reference upload input was not found on the current page. Reference images could not be attached.',
        diagnostics: `Task ${task.id} has ${references.length} reference(s), but no input[type="file"] exists in DOM.`
      };
    }

    try {
      const targetInput = fileInputs[0];
      const files = references.map((r) =>
        dataUrlToFile(r.dataUrl, r.metadata.name, r.metadata.mimeType)
      );

      if (typeof DataTransfer !== 'undefined') {
        const dt = new DataTransfer();
        for (const f of files) {
          dt.items.add(f);
        }
        Object.defineProperty(targetInput, 'files', {
          value: dt.files,
          configurable: true
        });
      }

      targetInput.dispatchEvent(new Event('change', { bubbles: true }));
      targetInput.setAttribute('data-batch-studio-attached-count', String(files.length));
      targetInput.setAttribute(
        'data-batch-studio-attached-types',
        references.map((r) => r.metadata.type).join(',')
      );
      return { attached: true };
    } catch (err) {
      return {
        attached: false,
        errorCode: 'REFERENCE_UPLOAD_FAILED',
        userMessage: 'Failed to attach reference image(s) to Google Flow.',
        diagnostics: err instanceof Error ? err.message : String(err)
      };
    }
  }

  public async submitTask(
    task: TaskRecord,
    references: ResolvedReferenceAttachment[],
    options?: AdapterSubmissionOptions
  ): Promise<AdapterSubmissionResult> {
    // Validate video mode requirements (e.g. image_to_video and start_end_frame require at least 1 reference image)
    if (task.taskType === 'video') {
      const mode = task.generationSettings.videoMode || 'text_to_video';
      if (
        (mode === 'image_to_video' ||
          mode === 'start_end_frame' ||
          mode === 'reference_ingredients') &&
        references.length === 0
      ) {
        return {
          submitted: false,
          errorCode: 'REFERENCE_UPLOAD_FAILED',
          userMessage: `Video mode "${mode.replace(
            /_/g,
            ' '
          )}" requires at least one reference or frame image.`,
          recommendedAction:
            'Attach a reference image to this task or switch video mode to Text-to-Video.'
        };
      }
    }

    const generationState = inspectObservableGenerationState(this.doc);
    if (generationState.stopButtonFound || generationState.activeIndicatorCount > 0) {
      return {
        submitted: false,
        errorCode: 'DUPLICATE_SUBMISSION_RISK',
        userMessage: 'Google Flow is currently still processing a previous generation.',
        recommendedAction: 'Wait for the current generation to complete before submitting.',
        diagnostics: generationState.evidence
      };
    }

    const hasLayoutEngine = Boolean(this.doc.body && this.doc.body.offsetWidth > 0);
    if (hasLayoutEngine) {
      const doneBtn = Array.from(this.doc.querySelectorAll<HTMLElement>('button')).find(
        (b) =>
          isElementVisible(b) &&
          ((b.textContent || '').trim().toLowerCase() === 'done' ||
            (b.getAttribute('aria-label') || '').toLowerCase().includes('done') ||
            (b.getAttribute('aria-label') || '').toLowerCase().includes('previous page') ||
            (b.textContent || '').trim().toLowerCase() === 'arrow_back')
      );
      if (doneBtn) {
        await activateControlWithEvents(doneBtn);
        await new Promise((r) => setTimeout(r, 200));
        if (isElementVisible(doneBtn)) {
          await this.dispatchCdpClickOnElement(doneBtn);
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    }

    this.applyGenerationSettingsToControls(task.taskType, task.generationSettings);

    const composerInspection = discoverComposerCandidates(this.doc, {
      preferredSelectors: [
        'div.ProseMirror[contenteditable="true"]',
        'div[contenteditable="true"].ProseMirror',
        'textarea[data-testid="flow-prompt-input"]',
        'textarea[placeholder*="prompt" i]',
        'textarea[placeholder*="Describe" i]',
        'div[contenteditable="true"][data-testid="flow-prompt-input"]',
        'div[contenteditable="true"]',
        'textarea'
      ]
    });

    const promptInput = composerInspection.bestCandidate?.element || null;
    if (!promptInput) {
      return {
        submitted: false,
        errorCode: 'CONTROLS_NOT_FOUND',
        userMessage: 'Google Flow prompt input box could not be found.',
        recommendedAction: 'Make sure the Google Flow project editor is open.',
        diagnostics: composerInspection.diagnostics
      };
    }

    const existingElements = this.findOutputElements(task.taskType);
    const existingCount = existingElements.length;
    const existingUrls = existingElements
      .map((el) =>
        (
          (el as HTMLImageElement | HTMLVideoElement).currentSrc ||
          (el as HTMLImageElement | HTMLVideoElement).src ||
          el.getAttribute('src') ||
          el.querySelector('source')?.getAttribute('src') ||
          ''
        ).trim()
      )
      .filter(Boolean);
    this.taskBaselineOutputCount.set(task.id, existingCount);
    this.taskBaselineOutputUrls.set(task.id, new Set(existingUrls));
    this.doc.body?.setAttribute('data-batch-studio-active-task', task.id);
    this.doc.body?.setAttribute(
      'data-batch-studio-baseline-outputs',
      String(existingCount)
    );
    try {
      this.doc.body?.setAttribute(
        'data-batch-studio-baseline-urls',
        JSON.stringify(existingUrls)
      );
    } catch {}

    const hadEmptySplash = (this.doc.body?.textContent || '')
      .toLowerCase()
      .includes('start creating or drop media');
    this.doc.body?.setAttribute('data-batch-studio-had-empty-splash', String(hadEmptySplash));

    const promptText = task.finalPromptSnapshot || task.originalPrompt;

    // Tag the composer so CDP debugger can also locate and focus it if Slate needs hardware Input.insertText
    try {
      this.doc
        .querySelectorAll('[data-batch-studio-composer-target]')
        .forEach((el) => el.removeAttribute('data-batch-studio-composer-target'));
      promptInput.setAttribute('data-batch-studio-composer-target', 'true');
    } catch {}

    const entryResult = await enterTextWithHumanEvents(promptInput, promptText, {
      simulateTypingPause: options?.simulateTypingPause ?? false,
      clearFirst: true
    });

    const canUseCdpFallback =
      hasLayoutEngine && typeof chrome !== 'undefined' && Boolean(chrome.runtime?.sendMessage);

    if (!entryResult.verified && !canUseCdpFallback) {
      return {
        submitted: false,
        errorCode: 'CONTROLS_NOT_FOUND',
        userMessage: 'Could not enter and verify prompt text in Google Flow composer.',
        recommendedAction: 'Inspect the Google Flow prompt box and press Resume.',
        diagnostics: entryResult.diagnostics
      };
    }

    // In a real browser, wait briefly for Lit/Angular reactive state to commit the prompt
    // and transition the Generate (→) button from disabled to enabled.
    if (hasLayoutEngine && entryResult.verified) {
      await new Promise((r) => setTimeout(r, 150));
    }

    const submitHints = {
      preferredSelectors: [
        'button.generate-icon-button',
        'button[aria-label*="Start generation" i]',
        'button[data-testid="flow-generate-button"]',
        'button.flow-icon-button-secondary',
        'button[aria-label*="Generate" i]',
        'button[aria-label*="Run" i]',
        'button[aria-label*="Submit" i]',
        'button[aria-label*="Send" i]',
        'button[type="submit"]'
      ]
    };

    let submitInspection = discoverSubmitControlCandidates(this.doc, promptInput, submitHints);
    let generateBtn: HTMLElement | null =
      this.findGenerateButton() || submitInspection.bestCandidate?.element || null;

    // If the button is still disabled in a real browser and DOM text entry verified, poll briefly for framework enablement
    if (
      hasLayoutEngine &&
      entryResult.verified &&
      generateBtn &&
      ((generateBtn as HTMLButtonElement).disabled ||
        generateBtn.getAttribute('aria-disabled') === 'true')
    ) {
      for (let attempt = 0; attempt < 4; attempt++) {
        await new Promise((r) => setTimeout(r, 90));
        submitInspection = discoverSubmitControlCandidates(this.doc, promptInput, submitHints);
        generateBtn = submitInspection.bestCandidate?.element || null;
        if (
          generateBtn &&
          !(generateBtn as HTMLButtonElement).disabled &&
          generateBtn.getAttribute('aria-disabled') !== 'true'
        ) {
          break;
        }
      }
    }

    // Tag the target button so CDP debugger can also locate its live post-attach coordinates
    try {
      this.doc
        .querySelectorAll('[data-batch-studio-click-target]')
        .forEach((el) => el.removeAttribute('data-batch-studio-click-target'));
      if (generateBtn) {
        generateBtn.setAttribute('data-batch-studio-click-target', 'true');
      }
    } catch {}

    // Scroll generate button into view if available
    if (generateBtn && typeof generateBtn.scrollIntoView === 'function') {
      try {
        generateBtn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      } catch {}
    }

    const targetDesc = generateBtn
      ? `<${generateBtn.tagName}${generateBtn.id ? ` id="${generateBtn.id}"` : ''} class="${(generateBtn.className || '').toString().slice(0, 40)}" label="${generateBtn.getAttribute('aria-label') || (generateBtn.textContent || '').trim().slice(0, 24)}">`
      : 'composer fallback';

    let debuggerLog = '';

    const wasSubmitBtnEnabledBeforeClick = Boolean(
      generateBtn &&
        !(generateBtn as HTMLButtonElement).disabled &&
        generateBtn.getAttribute('aria-disabled') !== 'true' &&
        !generateBtn.hasAttribute('disabled')
    );

    // Progressive Verified Escalation:
    // Stage 1: Activate target control with composed Pointer/Mouse/Click event sequence
    const activation = await activateControlWithEvents(generateBtn || promptInput, {
      keyboardFallbackComposer: promptInput,
      simulatePause: options?.simulateTypingPause ?? false
    });

    if (
      hasLayoutEngine &&
      activation.activated &&
      activation.method === 'pointer_click' &&
      wasSubmitBtnEnabledBeforeClick
    ) {
      const stage1Verify = await verifySubmissionEvidence(this.doc, {
        composerEl: promptInput,
        submitBtnEl: generateBtn,
        wasSubmitBtnEnabled: wasSubmitBtnEnabledBeforeClick,
        previousOutputCount: existingCount,
        expectedText: promptText,
        maxWaitMs: 900,
        hadEmptySplash
      });
      if (stage1Verify.confirmed) {
        return {
          submitted: true,
          diagnostics: `${composerInspection.diagnostics} | Target: ${targetDesc} | ${activation.diagnostics} | ${stage1Verify.diagnostics}`
        };
      }
    }

    // Stage 2: Escalate to Chrome Debugger CDP trusted hardware click (and hardware Input.insertText if button is still disabled)
    let cdpBtnEnabledBeforeClick = false;
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage && generateBtn) {
      try {
        const rect = generateBtn.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const clickX = rect.left + rect.width / 2;
          const clickY = rect.top + rect.height / 2;
          const clickRes = (await chrome.runtime.sendMessage({
            type: 'BS_BG_DISPATCH_TRUSTED_CLICK',
            x: clickX,
            y: clickY,
            promptText
          })) as {
            ok?: boolean;
            data?: { success?: boolean; btnEnabledBeforeClick?: boolean; error?: string };
            error?: string;
          } | undefined;

          if (clickRes?.data?.success) {
            cdpBtnEnabledBeforeClick = Boolean(clickRes.data.btnEnabledBeforeClick);
            debuggerLog += `[CDP Click @ (${Math.round(clickX)}, ${Math.round(clickY)}): OK]`;
            if (hasLayoutEngine) {
              const stage2Verify = await verifySubmissionEvidence(this.doc, {
                composerEl: promptInput,
                submitBtnEl: generateBtn,
                wasSubmitBtnEnabled: wasSubmitBtnEnabledBeforeClick || cdpBtnEnabledBeforeClick,
                previousOutputCount: existingCount,
                expectedText: promptText,
                maxWaitMs: 1200,
                hadEmptySplash
              });
              if (stage2Verify.confirmed) {
                return {
                  submitted: true,
                  diagnostics: `${composerInspection.diagnostics} | Target: ${targetDesc} | ${debuggerLog} | ${stage2Verify.diagnostics}`
                };
              }
            }
          } else {
            const errStr = clickRes?.data?.error || clickRes?.error || 'unspecified';
            debuggerLog += `[CDP Click FAILED: ${errStr}]`;
          }
        }
      } catch (err) {
        debuggerLog += `[CDP Click ERROR: ${err instanceof Error ? err.message : String(err)}]`;
      }
    }

    // Stage 3: Escalate to keyboard Enter submission if neither click stage confirmed yet
    if (!hasLayoutEngine || !activation.activated) {
      triggerEnterKeySubmission(promptInput);
    } else {
      try {
        promptInput.focus();
        triggerEnterKeySubmission(promptInput);
        if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
          const enterRes = (await chrome.runtime.sendMessage({
            type: 'BS_BG_DISPATCH_TRUSTED_ENTER'
          })) as { ok?: boolean; data?: { success?: boolean; error?: string }; error?: string } | undefined;

          if (enterRes?.data?.success) {
            debuggerLog += ' [CDP Enter: OK]';
          }
        }
      } catch {}
    }

    const submissionDiagnostics = `Target: ${targetDesc} | ${debuggerLog || 'DOM Events'} | ${activation.diagnostics}`;

    if (!activation.activated && !debuggerLog.includes(': OK')) {
      return {
        submitted: false,
        errorCode: 'CONTROLS_NOT_FOUND',
        userMessage: 'Google Flow Generate button was unavailable or disabled.',
        recommendedAction: 'Check the Google Flow tab and retry.',
        diagnostics: `${submitInspection.diagnostics} ${submissionDiagnostics}`
      };
    }

    // Stage 4: Final verification window for network/UI response
    const verifyResult = await verifySubmissionEvidence(this.doc, {
      composerEl: promptInput,
      submitBtnEl: generateBtn,
      wasSubmitBtnEnabled: wasSubmitBtnEnabledBeforeClick || cdpBtnEnabledBeforeClick,
      previousOutputCount: existingCount,
      expectedText: promptText,
      maxWaitMs: options?.maxWaitMs ?? 4000,
      hadEmptySplash
    });

    if (verifyResult.confirmed) {
      return {
        submitted: true,
        diagnostics: `${composerInspection.diagnostics} | ${submissionDiagnostics} | ${verifyResult.diagnostics}`
      };
    }

    if (verifyResult.uncertain) {
      return {
        submitted: false,
        errorCode: 'SUBMISSION_UNCERTAIN',
        userMessage: 'Prompt submission was attempted on Google Flow, but generation start could not be confirmed.',
        recommendedAction: 'Check the Google Flow tab. If generation started, wait for it; otherwise click Retry.',
        diagnostics: `${submissionDiagnostics} | ${verifyResult.diagnostics}`
      };
    }

    return {
      submitted: false,
      errorCode: 'CONTROLS_NOT_FOUND',
      userMessage: 'Google Flow Generate button was activated, but the page did not accept the prompt submission.',
      recommendedAction: 'Ensure Google Flow workspace is ready and prompt is valid, then retry.',
      diagnostics: `${submissionDiagnostics} | ${verifyResult.diagnostics}`
    };
  }

  public async getTaskStatus(task: TaskRecord): Promise<AdapterStatusInspection> {
    // 1. Check for explicit error banner or quota message
    const errorEl = this.doc.querySelector<HTMLElement>(
      '[data-testid="flow-error-banner"], .flow-error-message, [role="alert"][data-severity="error"]'
    );
    if (errorEl) {
      return {
        state: 'failed',
        detectedAssets: [],
        errorCode: 'GENERATION_FAILED',
        userMessage:
          errorEl.textContent?.trim() || 'Google Flow reported a generation error.',
        recommendedAction: 'Inspect the message on Google Flow and click Retry.'
      };
    }

    // 2. Check for active generation progress indicators (spinners, shimmers, progress bars)
    const hasLayoutEngine = Boolean(this.doc.body && this.doc.body.offsetWidth > 0);
    const spinnerEls = Array.from(
      this.doc.querySelectorAll<HTMLElement>(
        '[data-testid="flow-generating-indicator"], .flow-generation-progress, [role="progressbar"], [aria-busy="true"], mat-progress-spinner, mat-spinner, md-circular-progress, md-linear-progress, [class*="shimmer" i], [class*="skeleton" i]'
      )
    ).filter(isElementVisible);
    const spinnerEl = spinnerEls[0] || null;

    const statusEls = Array.from(
      this.doc.querySelectorAll<HTMLElement>(
        '[role="status"], [aria-live], .flow-status, [class*="progress" i], [class*="loading" i], [class*="generating" i]'
      )
    );
    const hasSplashDisappearedWhileGenerating =
      this.doc.body?.getAttribute('data-batch-studio-had-empty-splash') === 'true' &&
      !(this.doc.body?.textContent || '').toLowerCase().includes('start creating or drop media');

    const hasActiveProgressText = statusEls.some((el) => {
      if (!isElementVisible(el)) return false;
      if (el.children.length > 0 && !el.hasAttribute('role') && !el.hasAttribute('aria-live')) {
        return false;
      }
      const txt = (el.textContent || '').trim();
      if (!txt || /start creating or drop media/i.test(txt)) return false;
      const isDedicatedStatusEl =
        el.hasAttribute('role') ||
        el.hasAttribute('aria-live') ||
        /progress|loading|generating|flow-status/i.test((el.className || '').toString());
      return (
        /^\d{1,3}%$/.test(txt) ||
        /^(?:generating|creating|queuing|queued|rendering)(?:\.{0,3}|\s+\d{1,3}%|\s+image|\s+video)?$/i.test(txt) ||
        (isDedicatedStatusEl && /(?:\b\d{1,2}%|\b(?:generating|creating|queuing|queued|rendering)\b)/i.test(txt))
      );
    });

    const allOutputs = this.findOutputElements(task.taskType);
    const baselineAttr = this.doc.body?.getAttribute(
      'data-batch-studio-baseline-outputs'
    );
    const baseline =
      this.taskBaselineOutputCount.get(task.id) ??
      (baselineAttr ? Number(baselineAttr) : 0);

    let baselineUrls = this.taskBaselineOutputUrls.get(task.id);
    if (!baselineUrls) {
      const rawUrlsAttr = this.doc.body?.getAttribute('data-batch-studio-baseline-urls');
      if (rawUrlsAttr) {
        try {
          const parsed = JSON.parse(rawUrlsAttr);
          if (Array.isArray(parsed)) {
            baselineUrls = new Set(parsed.map(String));
          }
        } catch {}
      }
    }

    let newOutputElements = baselineUrls
      ? allOutputs.filter((el) => {
          const src = (
            (el as HTMLImageElement | HTMLVideoElement).currentSrc ||
            (el as HTMLImageElement | HTMLVideoElement).src ||
            el.getAttribute('src') ||
            el.querySelector('source')?.getAttribute('src') ||
            ''
          ).trim();
          return Boolean(src) && !baselineUrls!.has(src);
        })
      : [];

    if (newOutputElements.length === 0 && allOutputs.length > baseline) {
      const newCount = allOutputs.length - baseline;
      // Google Flow typically prepends newer cards at the top/beginning of the grid.
      // If prepending is used, slice(0, newCount) gives the new outputs; otherwise slice(baseline) gives them.
      const prepended = allOutputs.slice(0, newCount);
      newOutputElements = prepended.length > 0 ? prepended : allOutputs.slice(baseline);
    }

    // Wait briefly for any newly inserted <img> in a real browser to finish loading its network bytes
    const hasLoadingImage =
      hasLayoutEngine &&
      task.taskType === 'image' &&
      newOutputElements.some((el) => {
        if (el.tagName.toLowerCase() !== 'img') return false;
        const img = el as HTMLImageElement;
        return !img.complete;
      });

    if (hasLoadingImage) {
      return {
        state: 'active',
        detectedAssets: []
      };
    }

    const expectedCount = task.generationSettings.outputCount || 1;
    const detectedAssets = this.extractAssetsFromElements(
      newOutputElements,
      task.taskType,
      task.id
    ).slice(0, expectedCount);

    // If new output assets have been identified on the page, the generation has produced results!
    if (detectedAssets.length > 0) {
      this.doc.body?.removeAttribute('data-batch-studio-active-task');
      return {
        state: 'completed',
        detectedAssets
      };
    }

    // Only if NO new assets were detected yet do we check if generation is still in progress
    const isActiveSubmittedFlowTask =
      hasLayoutEngine &&
      this.doc.body?.getAttribute('data-batch-studio-active-task') === task.id;

    if (
      spinnerEl ||
      hasActiveProgressText ||
      hasSplashDisappearedWhileGenerating ||
      isActiveSubmittedFlowTask
    ) {
      return {
        state: 'active',
        detectedAssets: []
      };
    }

    return {
      state: 'idle',
      detectedAssets: []
    };
  }

  private findOfficialDownloadButton(scope?: ParentNode | null): HTMLElement | null {
    const root = scope || this.doc;
    const explicitCandidates = Array.from(
      root.querySelectorAll<HTMLElement>(
        '[data-testid="flow-download-button"], button[aria-label*="Download" i], button[title*="Download" i], button[mattooltip*="Download" i], a[download]'
      )
    ).filter(isElementVisible);
    if (explicitCandidates.length > 0) {
      return explicitCandidates[0];
    }

    const buttons = Array.from(
      root.querySelectorAll<HTMLElement>(
        'button, [role="button"], [role="menuitem"], .mat-mdc-menu-item'
      )
    );
    for (const btn of buttons) {
      if (!isElementVisible(btn)) continue;
      if (btn.classList.contains('flow-icon-button-secondary')) continue;
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
      if (aria.includes('download')) {
        return btn;
      }
      const iconEl = btn.querySelector(
        'mat-icon, .google-material-icons, .google-symbols, .material-symbols-outlined, .material-icons, [class*="symbol"], [class*="icon"], i'
      );
      const iconText = (iconEl?.textContent || btn.textContent || '').trim().toLowerCase();
      const rawText = (btn.textContent || '').trim().toLowerCase();
      if (
        iconText === 'download' ||
        iconText === 'file_download' ||
        iconText === 'download_2' ||
        iconText === 'arrow_downward' ||
        iconText === 'save_alt' ||
        iconText === 'vertical_align_bottom' ||
        rawText === 'download' ||
        rawText.includes('download')
      ) {
        return btn;
      }
    }

    // Fallback for Single-Image Detail View header (button immediately before "Show history" or "Hide history")
    if (root === this.doc) {
      const allBtns = Array.from(this.doc.querySelectorAll<HTMLElement>('button')).filter(
        isElementVisible
      );
      const historyIdx = allBtns.findIndex((b) =>
        (b.textContent || '').trim().toLowerCase().includes('history')
      );
      if (historyIdx > 0) {
        return allBtns[historyIdx - 1];
      }
    }

    return null;
  }

  private findOriginalSizeMenuItem(): HTMLElement | null {
    const candidates = Array.from(
      this.doc.querySelectorAll<HTMLElement>(
        '[role="menuitem"], [role="option"], .mat-mdc-menu-item, .cdk-overlay-pane button, [data-radix-popper-content-wrapper] *, button, div[tabindex]'
      )
    ).filter(isElementVisible);

    return (
      candidates.find((item) => {
        const txt = (item.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        return (
          (txt.includes('original size') || /\b1k\b/.test(txt) || /\b360p\b/.test(txt) || /\b720p\b/.test(txt)) &&
          !txt.includes('2k') &&
          !txt.includes('4k') &&
          !txt.includes('gif')
        );
      }) || null
    );
  }

  private async dispatchCdpClickOnElement(el: HTMLElement): Promise<boolean> {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      return false;
    }
    try {
      this.doc
        .querySelectorAll('[data-batch-studio-click-target]')
        .forEach((node) => node.removeAttribute('data-batch-studio-click-target'));
      el.setAttribute('data-batch-studio-click-target', 'true');
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const res = (await chrome.runtime.sendMessage({
        type: 'BS_BG_DISPATCH_TRUSTED_CLICK',
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      })) as { data?: { success?: boolean } } | undefined;
      return Boolean(res?.data?.success);
    } catch {
      return false;
    }
  }

  private extractAssetsFromElements(
    elements: HTMLElement[],
    taskType: TaskType,
    taskId: string
  ): DetectedPlatformAsset[] {
    const hasLayoutEngine = Boolean(this.doc.body && this.doc.body.offsetWidth > 0);
    const assets: DetectedPlatformAsset[] = [];
    const seenUrls = new Set<string>();

    elements.forEach((el) => {
      const src = (
        (el as HTMLImageElement | HTMLVideoElement).currentSrc ||
        (el as HTMLImageElement | HTMLVideoElement).src ||
        el.getAttribute('src') ||
        el.querySelector('source')?.getAttribute('src') ||
        ''
      ).trim();
      if (!src || seenUrls.has(src)) return;
      seenUrls.add(src);

      const idx = assets.length;
      const selectorId = `bs-flow-${taskType}-${taskId}-${idx}`;
      el.setAttribute('data-batch-studio-asset-id', selectorId);

      const card = el.closest('.flow-output-card, figure, article, div') || el.parentElement;
      const dlBtn = this.findOfficialDownloadButton(card);
      if (dlBtn) {
        dlBtn.setAttribute('data-batch-studio-dl-btn', selectorId);
      }

      const defaultExt = taskType === 'video' ? 'mp4' : 'png';
      const extMatch = /\.([a-z0-9]{3,4})(?:[?#]|$)/i.exec(src);
      const rawExt = extMatch ? extMatch[1].toLowerCase() : defaultExt;
      const normalizedExt =
        taskType === 'video'
          ? 'mp4'
          : taskType === 'image' && (rawExt === 'jfif' || rawExt === 'jpeg' || rawExt === 'jpg')
          ? 'png'
          : rawExt === 'jpeg'
          ? 'jpg'
          : rawExt;

      assets.push({
        index: idx,
        type: taskType,
        url: src,
        extension: normalizedExt,
        hasNativeDownloadButton: Boolean(dlBtn || hasLayoutEngine),
        elementSelectorId: selectorId
      });
    });

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
    const hasLayoutEngine = Boolean(this.doc.body && this.doc.body.offsetWidth > 0);
    const assetEl = asset.elementSelectorId
      ? this.doc.querySelector<HTMLElement>(`[data-batch-studio-asset-id="${asset.elementSelectorId}"]`)
      : null;

    let dlBtn = asset.elementSelectorId
      ? this.doc.querySelector<HTMLElement>(`[data-batch-studio-dl-btn="${asset.elementSelectorId}"]`)
      : null;

    if (!dlBtn || (hasLayoutEngine && !isElementVisible(dlBtn))) {
      const card = assetEl?.closest('.flow-output-card, figure, article, div') || assetEl?.parentElement;
      dlBtn = this.findOfficialDownloadButton(card) || this.findOfficialDownloadButton(this.doc);
    }

    let openedDetailView = false;

    // In a real Google Flow browser tab, if the official Download (↓) button is not visible on the Project Grid view,
    // click the generated image tile to open the Single-Image Detail view where the official Download (↓) button lives!
    if (hasLayoutEngine && !dlBtn && assetEl) {
      try {
        assetEl.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, composed: true }));
        assetEl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, composed: true }));
        await new Promise((r) => setTimeout(r, 150));
        dlBtn = this.findOfficialDownloadButton(this.doc);
      } catch {}

      if (!dlBtn) {
        await activateControlWithEvents(assetEl);
        await new Promise((r) => setTimeout(r, 350));
        dlBtn = this.findOfficialDownloadButton(this.doc);
        if (!dlBtn) {
          await this.dispatchCdpClickOnElement(assetEl);
          for (let i = 0; i < 4 && !dlBtn; i++) {
            await new Promise((r) => setTimeout(r, 250));
            dlBtn = this.findOfficialDownloadButton(this.doc);
          }
        }
        if (!dlBtn) {
          // In responsive or narrower viewports, Google Flow collapses the header actions into more_vert ("More options")
          const moreVertBtn = Array.from(this.doc.querySelectorAll<HTMLElement>('button')).find(
            (b) =>
              isElementVisible(b) &&
              ((b.getAttribute('aria-label') || '').toLowerCase().includes('more options') ||
                (b.textContent || '').trim() === 'more_vert')
          );
          if (moreVertBtn) {
            await activateControlWithEvents(moreVertBtn);
            await new Promise((r) => setTimeout(r, 250));
            dlBtn = this.findOfficialDownloadButton(this.doc);
          }
        }
        if (dlBtn) {
          openedDetailView = true;
        }
      }
    }

    if (dlBtn) {
      if (!hasLayoutEngine) {
        dlBtn.click();
        return {
          initiated: true,
          method: 'native_button',
          resolvedUrl: asset.url
        };
      }

      // 1. Click the official Download (↓) button to open the resolution menu ("1K Original size" / "2K" / "4K")
      await activateControlWithEvents(dlBtn);
      await new Promise((r) => setTimeout(r, 300));
      let originalSizeItem = this.findOriginalSizeMenuItem();

      if (!originalSizeItem) {
        await this.dispatchCdpClickOnElement(dlBtn);
        for (let i = 0; i < 4 && !originalSizeItem; i++) {
          await new Promise((r) => setTimeout(r, 220));
          originalSizeItem = this.findOriginalSizeMenuItem();
        }
      }

      // 2. Click "1K Original size" in the dropdown menu
      if (originalSizeItem) {
        await activateControlWithEvents(originalSizeItem);
        await new Promise((r) => setTimeout(r, 200));
        if (isElementVisible(originalSizeItem)) {
          await this.dispatchCdpClickOnElement(originalSizeItem);
        }
        await new Promise((r) => setTimeout(r, 350));
      }

      // 3. If we opened the Single-Image Detail View from the grid, click "Done" to return to the grid
      if (openedDetailView) {
        const doneBtn = Array.from(this.doc.querySelectorAll<HTMLElement>('button')).find(
          (b) =>
            isElementVisible(b) &&
            ((b.textContent || '').trim().toLowerCase() === 'done' ||
              (b.getAttribute('aria-label') || '').toLowerCase().includes('done') ||
              (b.getAttribute('aria-label') || '').toLowerCase().includes('previous page') ||
              (b.textContent || '').trim().toLowerCase() === 'arrow_back')
        );
        if (doneBtn) {
          await activateControlWithEvents(doneBtn);
          await new Promise((r) => setTimeout(r, 150));
          if (isElementVisible(doneBtn)) {
            await this.dispatchCdpClickOnElement(doneBtn);
          }
        }
      }

      return {
        initiated: true,
        method: 'native_button',
        resolvedUrl: asset.url
      };
    }

    if (
      asset.url &&
      (asset.url.startsWith('https://') ||
        asset.url.startsWith('http://') ||
        asset.url.startsWith('data:') ||
        asset.url.startsWith('blob:'))
    ) {
      if (asset.url.startsWith('blob:')) {
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
          // Fall through to raw blob URL
        }
      }

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
      userMessage:
        'Could not locate a supported download button or accessible media URL on Google Flow.'
    };
  }

  public async recoverTask(task: TaskRecord): Promise<AdapterStatusInspection> {
    return this.getTaskStatus(task);
  }

  public async dispose(): Promise<void> {
    this.taskBaselineOutputCount.clear();
    this.taskBaselineOutputUrls.clear();
  }
}
