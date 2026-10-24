/**
 * Browser Interaction Layer
 *
 * Implements human-like, framework-compatible browser interactions:
 * - Text entry with realistic browser events (focus, beforeinput, input, change)
 *   supporting React, Lexical, ProseMirror, DraftJS, and native inputs.
 * - Text verification confirming the framework accepted the prompt.
 * - Control activation with pointer and mouse event sequences.
 * - Observable submission confirmation (composer cleared, stop button, indicators, turn count).
 * - Safe handling of ambiguous submissions to prevent duplicate prompts.
 */

import {
  ComposerCandidate,
  SubmitControlCandidate,
  isElementVisible,
  queryGeneratedOutputElements
} from './domInspection';

export interface TextEntryResult {
  success: boolean;
  actualText: string;
  verified: boolean;
  diagnostics: string;
  rejectionReason?: string;
}

export interface ActivationResult {
  activated: boolean;
  method: 'pointer_click' | 'keyboard_enter' | 'synthetic_click';
  diagnostics: string;
}

export interface SubmissionVerificationResult {
  confirmed: boolean;
  uncertain: boolean;
  evidence: string;
  diagnostics: string;
}

/**
 * Realistic bounded asynchronous pause to simulate human interaction intervals.
 */
export async function humanDelay(minMs = 80, maxMs = 250): Promise<void> {
  const boundedMin = Math.max(0, minMs);
  const boundedMax = Math.max(boundedMin, maxMs);
  const ms = Math.floor(Math.random() * (boundedMax - boundedMin + 1)) + boundedMin;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normalizes text for comparison by collapsing multiple whitespace characters.
 */
export function normalizeText(text: string): string {
  return (text || '').replace(/\s+/g, ' ').trim();
}

/**
 * Reads the current textual content of an input or contenteditable element.
 */
export function readElementText(el: HTMLElement): string {
  if (!el) return '';
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return el.value || '';
  }
  return el.textContent || el.innerText || '';
}

/**
 * Enters text into an input or contenteditable element using human-like events
 * and framework-safe setters (React/Vue/Lexical/ProseMirror).
 */
export async function enterTextWithHumanEvents(
  element: HTMLElement,
  text: string,
  options?: {
    clearFirst?: boolean;
    dispatchChange?: boolean;
    simulateTypingPause?: boolean;
  }
): Promise<TextEntryResult> {
  if (!element || !isElementVisible(element)) {
    return {
      success: false,
      actualText: '',
      verified: false,
      diagnostics: 'Target element is not visible or not present in DOM.',
      rejectionReason: 'ELEMENT_NOT_VISIBLE'
    };
  }

  // 1. Focus and click element so framework focus/active listeners wake up
  try {
    element.focus();
    element.dispatchEvent(new FocusEvent('focus', { bubbles: true, composed: true }));
    element.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true }));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true }));
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
  } catch {
    // Some mock environments may not support FocusEvent/MouseEvent
    element.dispatchEvent(new Event('focus', { bubbles: true }));
  }

  if (options?.simulateTypingPause) {
    await humanDelay(30, 80);
  }

  const doc = element.ownerDocument;
  const hasLayoutEngine = Boolean(
    doc?.body &&
      (doc.body.offsetWidth > 0 ||
        doc.body.offsetHeight > 0 ||
        doc.body.getClientRects().length > 0)
  );

  const isInputOrTextArea =
    element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
  const isContentEditable =
    element.getAttribute('contenteditable') === 'true' ||
    element.isContentEditable === true ||
    element.getAttribute('role') === 'textbox';

  if (isInputOrTextArea) {
    const inputEl = element as HTMLInputElement | HTMLTextAreaElement;

    // Select existing content if clearing first
    if (options?.clearFirst !== false) {
      try {
        inputEl.select();
        if (typeof inputEl.setSelectionRange === 'function') {
          inputEl.setSelectionRange(0, inputEl.value.length);
        }
      } catch {
        // Ignore selection errors
      }
    }

    // In real browsers, try document.execCommand('insertText') first so Blink's native
    // C++ Editor pipeline fires authentic InputEvents and updates Lit/Angular/React state.
    let insertedNatively = false;
    if (hasLayoutEngine && doc && typeof doc.execCommand === 'function') {
      try {
        if (options?.clearFirst !== false && inputEl.value.length > 0) {
          doc.execCommand('selectAll', false);
          doc.execCommand('delete', false);
        }
        insertedNatively = doc.execCommand('insertText', false, text);
      } catch {
        insertedNatively = false;
      }
    }

    // If execCommand did not populate the exact text (e.g. in JSDOM or restricted input),
    // invoke the prototype native value setter to bypass React/Lit/Angular value traps.
    if (!insertedNatively || normalizeText(inputEl.value) !== normalizeText(text)) {
      const proto = Object.getPrototypeOf(inputEl);
      const nativeSetter =
        Object.getOwnPropertyDescriptor(proto, 'value')?.set ||
        Object.getOwnPropertyDescriptor(
          inputEl instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype,
          'value'
        )?.set;

      // Dispatch beforeinput
      try {
        inputEl.dispatchEvent(
          new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            composed: true,
            inputType: 'insertText',
            data: text
          })
        );
      } catch {
        // Fallback for minimal test DOM
      }

      if (nativeSetter) {
        nativeSetter.call(inputEl, text);
      } else {
        inputEl.value = text;
      }

      // Dispatch InputEvent('input') with composed: true
      try {
        inputEl.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            cancelable: true,
            composed: true,
            inputType: 'insertText',
            data: text
          })
        );
      } catch {
        inputEl.dispatchEvent(new Event('input', { bubbles: true, cancelable: true, composed: true }));
      }
    }

    if (options?.dispatchChange !== false) {
      inputEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    }

    // Dispatch keyup so key-driven validators (e.g. Angular/Lit button enablement) update
    try {
      inputEl.dispatchEvent(
        new KeyboardEvent('keyup', {
          key: text.slice(-1) || ' ',
          bubbles: true,
          cancelable: true,
          composed: true
        })
      );
    } catch {
      // Ignore in minimal test DOM
    }
  } else if (isContentEditable) {
    // Contenteditable (Slate, ProseMirror, Lexical, DraftJS)
    const isSlateEditor =
      element.hasAttribute('data-slate-editor') ||
      Boolean(element.querySelector('[data-slate-node], [data-slate-leaf], [data-slate-zero-width]'));

    // Place an explicit DOM Selection range inside the editor leaf so Slate/ProseMirror/Lexical
    // knows where the active cursor is even when the browser tab was not just clicked by the user.
    const sel =
      doc?.getSelection?.() ||
      (typeof window !== 'undefined' && typeof window.getSelection === 'function'
        ? window.getSelection()
        : null);
    if (sel && doc) {
      try {
        const range = doc.createRange();
        const targetLeaf =
          element.querySelector('[data-slate-string="true"], [data-slate-zero-width], [data-slate-leaf="true"]') ||
          element;
        range.selectNodeContents(targetLeaf);
        sel.removeAllRanges();
        sel.addRange(range);
        doc.dispatchEvent(new Event('selectionchange', { bubbles: true }));
      } catch {
        // Ignore selection range errors in minimal test DOM
      }
    }

    if (hasLayoutEngine) {
      await new Promise((r) => setTimeout(r, 40));
    }

    // Dispatch beforeinput
    try {
      element.dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          composed: true,
          inputType: 'insertText',
          data: text
        })
      );
    } catch {
      // Fallback
    }

    let insertedViaExecCommand = false;
    if (doc && typeof doc.execCommand === 'function') {
      try {
        if (options?.clearFirst !== false && readElementText(element).trim().length > 0) {
          doc.execCommand('selectAll', false);
          doc.execCommand('delete', false);
        }
        insertedViaExecCommand = doc.execCommand('insertText', false, text);
      } catch {
        insertedViaExecCommand = false;
      }
    }

    // If execCommand did not update a live Slate editor (e.g. tab in background), try synthetic paste with DataTransfer
    // without destroying Slate's internal React DOM nodes (`data-slate-node`).
    if (
      hasLayoutEngine &&
      isSlateEditor &&
      (!insertedViaExecCommand || normalizeText(readElementText(element)) !== normalizeText(text))
    ) {
      try {
        if (typeof DataTransfer !== 'undefined') {
          const dt = new DataTransfer();
          dt.setData('text/plain', text);
          element.dispatchEvent(
            new InputEvent('beforeinput', {
              bubbles: true,
              cancelable: true,
              composed: true,
              inputType: 'insertFromPaste',
              data: text,
              dataTransfer: dt
            })
          );
          if (normalizeText(readElementText(element)) !== normalizeText(text) && typeof ClipboardEvent !== 'undefined') {
            element.dispatchEvent(
              new ClipboardEvent('paste', {
                bubbles: true,
                cancelable: true,
                composed: true,
                clipboardData: dt
              })
            );
          }
        }
      } catch {
        // Will be handled by CDP hardware Input.insertText fallback
      }
    }

    // IMPORTANT: Never overwrite `element.innerHTML` on a live Slate.js editor (`hasLayoutEngine && isSlateEditor`),
    // because wiping `innerHTML` destroys Slate's React DOM-to-Node WeakMap and leaves the Generate button disabled.
    if (
      (!insertedViaExecCommand || normalizeText(readElementText(element)) !== normalizeText(text)) &&
      !(hasLayoutEngine && isSlateEditor)
    ) {
      // DOM fallback for JSDOM / ProseMirror / custom contenteditable (TrustedHTML-safe)
      while (element.firstChild) {
        element.removeChild(element.firstChild);
      }
      const p = doc.createElement('p');
      p.textContent = text;
      element.appendChild(p);
    }

    try {
      element.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          composed: true,
          inputType: 'insertText',
          data: text
        })
      );
    } catch {
      element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true, composed: true }));
    }

    if (options?.dispatchChange !== false) {
      element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    }
  } else {
    return {
      success: false,
      actualText: readElementText(element),
      verified: false,
      diagnostics: `Element <${element.tagName}> is neither an input/textarea nor contenteditable.`,
      rejectionReason: 'UNSUPPORTED_ELEMENT_TYPE'
    };
  }

  if (options?.simulateTypingPause) {
    await humanDelay(30, 80);
  }

  // 2. Verify entered text
  const verification = verifyEnteredText(element, text);

  return {
    success: verification.verified,
    actualText: verification.actualText,
    verified: verification.verified,
    diagnostics: verification.verified
      ? `Text successfully entered and verified (${verification.actualText.length} chars).`
      : `Text entry verification failed. Expected "${text.slice(0, 30)}...", found "${verification.actualText.slice(0, 30)}...".`
  };
}

/**
 * Verifies that the expected text is present in the target element.
 */
export function verifyEnteredText(
  element: HTMLElement,
  expectedText: string
): { verified: boolean; actualText: string; similarity: number } {
  const actualText = readElementText(element);
  const normalizedActual = normalizeText(actualText);
  const normalizedExpected = normalizeText(expectedText);

  if (normalizedActual === normalizedExpected) {
    return { verified: true, actualText, similarity: 1.0 };
  }

  // If actual contains expected (or expected contains actual due to framework wrappers)
  if (
    normalizedActual.includes(normalizedExpected) ||
    (normalizedExpected.length > 10 && normalizedActual.startsWith(normalizedExpected.slice(0, 10)))
  ) {
    return { verified: true, actualText, similarity: 0.9 };
  }

  return {
    verified: false,
    actualText,
    similarity: normalizedActual.length === 0 ? 0 : 0.2
  };
}

/**
 * Activates an interactive control (button, input[type=submit], role=button)
 * using genuine pointerdown/mousedown/pointerup/mouseup/click events.
 */
export async function activateControlWithEvents(
  controlEl: HTMLElement,
  options?: {
    keyboardFallbackComposer?: HTMLElement;
    simulatePause?: boolean;
  }
): Promise<ActivationResult> {
  if (!controlEl || !isElementVisible(controlEl)) {
    // If control element is missing or invisible, try keyboard fallback if provided
    if (options?.keyboardFallbackComposer) {
      const enterResult = triggerEnterKeySubmission(options.keyboardFallbackComposer);
      return {
        activated: enterResult,
        method: 'keyboard_enter',
        diagnostics: 'Submit button not visible; dispatched KeyboardEvent("Enter") on composer.'
      };
    }

    return {
      activated: false,
      method: 'pointer_click',
      diagnostics: 'Submit control is not visible or not present.'
    };
  }

  // Check if disabled
  const isDisabled =
    (controlEl as HTMLButtonElement).disabled ||
    controlEl.getAttribute('aria-disabled') === 'true' ||
    controlEl.hasAttribute('disabled');

  if (isDisabled) {
    if (options?.keyboardFallbackComposer) {
      const enterResult = triggerEnterKeySubmission(options.keyboardFallbackComposer);
      return {
        activated: enterResult,
        method: 'keyboard_enter',
        diagnostics: 'Submit button is disabled; dispatched KeyboardEvent("Enter") fallback.'
      };
    }
    return {
      activated: false,
      method: 'pointer_click',
      diagnostics: 'Submit control is currently disabled.'
    };
  }

  if (options?.simulatePause) {
    await humanDelay(20, 60);
  }

  // Compute center coordinates for realistic pointer/mouse events
  let clientX = 0;
  let clientY = 0;
  try {
    const rect = controlEl.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      clientX = Math.round(rect.left + rect.width / 2);
      clientY = Math.round(rect.top + rect.height / 2);
    }
  } catch {
    // Fallback for test DOM
  }

  const pointerOpts: PointerEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX,
    clientY,
    button: 0,
    buttons: 1
  };
  const mouseDownOpts: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX,
    clientY,
    button: 0,
    buttons: 1
  };
  const mouseUpOpts: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX,
    clientY,
    button: 0,
    buttons: 0
  };

  // Dispatch full pointer and mouse sequence
  try {
    controlEl.dispatchEvent(new PointerEvent('pointerdown', pointerOpts));
  } catch {
    // PointerEvent not supported in minimal test DOM
  }

  controlEl.dispatchEvent(new MouseEvent('mousedown', mouseDownOpts));

  try {
    controlEl.dispatchEvent(
      new PointerEvent('pointerup', { ...pointerOpts, buttons: 0 })
    );
  } catch {
    // PointerEvent fallback
  }

  controlEl.dispatchEvent(new MouseEvent('mouseup', mouseUpOpts));

  if (typeof controlEl.click === 'function') {
    controlEl.click();
  } else {
    controlEl.dispatchEvent(new MouseEvent('click', mouseUpOpts));
  }

  const labelInfo = controlEl.getAttribute('aria-label') || (controlEl.textContent || '').trim().slice(0, 24);
  return {
    activated: true,
    method: 'pointer_click',
    diagnostics: `Activated submit control <${controlEl.tagName}${
      controlEl.id ? ` id="${controlEl.id}"` : ''
    }${labelInfo ? ` label="${labelInfo}"` : ''}> with pointer event sequence.`
  };
}

/**
 * Dispatches Enter keyboard event sequence on a composer element as a fallback submission method.
 */
export function triggerEnterKeySubmission(composerEl: HTMLElement): boolean {
  if (!composerEl) return false;
  try {
    composerEl.focus();
    const keyInit: KeyboardEventInit = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      composed: true
    };
    const kd = composerEl.dispatchEvent(new KeyboardEvent('keydown', keyInit));
    composerEl.dispatchEvent(new KeyboardEvent('keypress', keyInit));
    composerEl.dispatchEvent(new KeyboardEvent('keyup', keyInit));
    return kd;
  } catch {
    return false;
  }
}

/**
 * Observes post-click evidence of submission:
 * - Did the composer text clear or reset?
 * - Did the submit button become disabled, detached, or change to a stop/loading icon?
 * - Did an active loading/progress/percentage indicator appear?
 * - Did the empty workspace splash ("Start creating or drop media") disappear?
 * - Did turn count or output/media count increase?
 * - Did an explicit error alert appear?
 */
export async function verifySubmissionEvidence(
  doc: Document,
  options: {
    composerEl?: HTMLElement | null;
    submitBtnEl?: HTMLElement | null;
    wasSubmitBtnEnabled?: boolean;
    previousTurnCount?: number;
    previousOutputCount?: number;
    hadEmptySplash?: boolean;
    expectedText?: string;
    maxWaitMs?: number;
    pollIntervalMs?: number;
  }
): Promise<SubmissionVerificationResult> {
  const maxWait = options.maxWaitMs ?? 1500;
  const pollInterval = options.pollIntervalMs ?? 100;
  const startTime = Date.now();

  while (Date.now() - startTime <= maxWait) {
    // Check 1: Stop button appearance
    const stopBtn = doc.querySelector(
      '[data-testid="stop-button"], button[aria-label="Stop" i], button[aria-label*="Stop" i], button[aria-label*="Cancel generation" i]'
    );
    if (stopBtn && isElementVisible(stopBtn)) {
      return {
        confirmed: true,
        uncertain: false,
        evidence: 'Stop button appeared in DOM.',
        diagnostics: 'Submission confirmed: Platform transitioned into active generating/streaming state.'
      };
    }

    // Check 2: Active loading / progress indicator or Google Flow generation percentage/spinner
    const activeIndicators = doc.querySelectorAll(
      '[data-testid="image-gen-loading"], [data-testid="flow-generating-indicator"], .dalle-progress, [role="progressbar"], [aria-busy="true"]:not([aria-label*="profile" i]):not([aria-label*="menu" i]), .flow-loader, .flow-generation-progress, .result-streaming, mat-progress-spinner, mat-spinner, md-circular-progress, md-linear-progress, [class*="shimmer" i], [class*="skeleton" i]'
    );
    const visibleIndicator = Array.from(activeIndicators).find(isElementVisible);
    if (visibleIndicator) {
      return {
        confirmed: true,
        uncertain: false,
        evidence: `Active progress indicator visible (${visibleIndicator.className || visibleIndicator.tagName}).`,
        diagnostics: 'Submission confirmed: Platform displayed active progress indicator.'
      };
    }

    // Check 2b: Visible workspace percentage or active generation status text (e.g. "12%", "Generating...", "Creating...")
    const statusTextNodes = doc.querySelectorAll(
      '[role="status"], [aria-live], [class*="progress" i], [class*="loading" i], [class*="generating" i], [class*="status" i], aisandbox-root span, aisandbox-root div'
    );
    const visibleStatusNode = Array.from(statusTextNodes).find((el) => {
      if (el.children.length > 0) return false;
      if (!isElementVisible(el)) return false;
      const txt = (el.textContent || '').trim();
      if (!txt || /start creating or drop media/i.test(txt)) return false;
      return (
        /^\d{1,3}%$/.test(txt) ||
        /^(?:generating|creating|queuing|queued|rendering)(?:\.{0,3}|\s+\d{1,3}%|\s+image|\s+video)?$/i.test(txt)
      );
    });
    if (visibleStatusNode) {
      return {
        confirmed: true,
        uncertain: false,
        evidence: `Generation status indicator active: "${(visibleStatusNode.textContent || '').trim().slice(0, 40)}".`,
        diagnostics: 'Submission confirmed: Platform displayed generation progress status.'
      };
    }

    // Check 3: Assistant turns increased (ChatGPT)
    if (typeof options.previousTurnCount === 'number') {
      const currentTurns = doc.querySelectorAll(
        '[data-turn-key], [data-virtualized-turn-content], [data-content-search-turn-key], [data-message-author-role="assistant"], article[data-testid^="conversation-turn-"], .agent-turn'
      );
      if (currentTurns.length > options.previousTurnCount) {
        return {
          confirmed: true,
          uncertain: false,
          evidence: `Turn count increased from ${options.previousTurnCount} to ${currentTurns.length}.`,
          diagnostics: 'Submission confirmed: New conversation turn created.'
        };
      }
    }

    // Check 4: Output count increased (Google Flow — strictly using queryGeneratedOutputElements to exclude account avatars)
    if (typeof options.previousOutputCount === 'number') {
      const currentOutputs = queryGeneratedOutputElements(doc);
      if (currentOutputs.length > options.previousOutputCount) {
        return {
          confirmed: true,
          uncertain: false,
          evidence: `Output count increased from ${options.previousOutputCount} to ${currentOutputs.length}.`,
          diagnostics: 'Submission confirmed: New output element rendered.'
        };
      }
    }

    // Check 5: Composer cleared or reset
    if (options.composerEl && options.expectedText) {
      const currentText = normalizeText(readElementText(options.composerEl));
      const expectedText = normalizeText(options.expectedText);
      if (currentText.length === 0 || (!currentText.includes(expectedText) && currentText !== expectedText)) {
        return {
          confirmed: true,
          uncertain: false,
          evidence: 'Prompt composer was cleared by the application.',
          diagnostics: 'Submission confirmed: Composer input was reset.'
        };
      }
    }

    // Check 6: Submit button became disabled, aria-disabled, detached, or switched to stop/spinner icon
    if (options.submitBtnEl) {
      if (!doc.contains(options.submitBtnEl)) {
        return {
          confirmed: true,
          uncertain: false,
          evidence: 'Submit button was replaced in DOM upon submission.',
          diagnostics: 'Submission confirmed: Submit control transitioned state.'
        };
      }
      if (isElementVisible(options.submitBtnEl)) {
        const isNowDisabled =
          (options.submitBtnEl as HTMLButtonElement).disabled ||
          options.submitBtnEl.getAttribute('aria-disabled') === 'true' ||
          options.submitBtnEl.hasAttribute('disabled');
        const btnText = (options.submitBtnEl.textContent || '').toLowerCase();
        const switchedToStopOrSpinner =
          btnText.includes('stop') ||
          btnText.includes('hourglass') ||
          btnText.includes('progress_activity') ||
          Boolean(options.submitBtnEl.querySelector('[role="progressbar"], mat-spinner, mat-progress-spinner'));
        if ((isNowDisabled && options.wasSubmitBtnEnabled !== false) || switchedToStopOrSpinner) {
          return {
            confirmed: true,
            uncertain: false,
            evidence: 'Submit button transitioned to disabled/busy state.',
            diagnostics: 'Submission confirmed: Submit button disabled by application.'
          };
        }
      }
    }

    // Check 6b: Empty workspace splash ("Start creating or drop media") disappeared after submission
    if (options.hadEmptySplash) {
      const bodyText = (doc.body?.innerText || doc.body?.textContent || '').toLowerCase();
      if (!bodyText.includes('start creating or drop media')) {
        return {
          confirmed: true,
          uncertain: false,
          evidence: 'Empty project splash screen transitioned to active canvas.',
          diagnostics: 'Submission confirmed: Workspace transitioned from empty state to generation canvas.'
        };
      }
    }

    // Check 7: Immediate error alert
    const errorAlert = doc.querySelector(
      '[data-testid="conversation-error"], [data-testid="flow-error-banner"], [role="alert"][data-error="true"], .result-error, .policy-violation'
    );
    if (errorAlert && isElementVisible(errorAlert)) {
      return {
        confirmed: true, // It was received and resulted in an error
        uncertain: false,
        evidence: `Platform returned error alert: "${(errorAlert.textContent || '').trim()}".`,
        diagnostics: 'Submission processed but returned an immediate platform error banner.'
      };
    }

    await humanDelay(pollInterval, pollInterval + 20);
  }

  // After timeout without confirmed state change, mark as uncertain submission
  return {
    confirmed: false,
    uncertain: true,
    evidence:
      options.composerEl && options.expectedText && normalizeText(readElementText(options.composerEl)) === normalizeText(options.expectedText)
        ? 'Composer still contains the original prompt; no page state change observed.'
        : 'Ambiguous page state: no generation indicator or turn creation was observed after submit control activation.',
    diagnostics:
      'Submission could not be conclusively verified within timeout window. Entering needs_attention to prevent duplicate prompt submissions.'
  };
}
