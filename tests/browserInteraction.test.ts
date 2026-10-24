import { describe, expect, it, vi } from 'vitest';
import {
  discoverComposerCandidates,
  discoverSubmitControlCandidates,
  inspectObservableGenerationState,
  isElementVisible
} from '../src/browser/domInspection';
import {
  activateControlWithEvents,
  enterTextWithHumanEvents,
  readElementText,
  triggerEnterKeySubmission,
  verifyEnteredText,
  verifySubmissionEvidence
} from '../src/browser/browserInteraction';
import { ChatGPTDomAdapter } from '../src/adapters/chatgptAdapter';
import { GoogleFlowDomAdapter } from '../src/adapters/googleFlowAdapter';
import { TaskRecord } from '../src/types/models';
import {
  createBatchWithTasks,
  stepBatchQueue
} from '../src/core/queueEngine';
import { evaluateGenerationObservation } from '../src/core/timeoutPolicy';
import { closeAndResetDatabase, getTask, getBatch } from '../src/storage/db';

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'test_task_dom_1',
    batchId: 'batch_test_dom',
    sequenceNumber: 1,
    originalPrompt: 'A futuristic floating glass greenhouse on an alien world',
    finalPromptSnapshot: 'A futuristic floating glass greenhouse on an alien world',
    platform: 'chatgpt',
    taskType: 'image',
    status: 'pending',
    friendlyStatus: 'Pending submission.',
    referenceIds: [],
    generationSettings: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
    retryCount: 0,
    outputIds: [],
    ...overrides
  };
}

describe('Live DOM Inspection Layer', () => {
  it('identifies and ranks prompt composer candidates, rejecting search and navigation inputs', () => {
    const doc = document.implementation.createHTMLDocument('ChatGPT UI');
    doc.body.innerHTML = `
      <nav>
        <input type="search" placeholder="Search chats..." id="search-input" />
      </nav>
      <main>
        <div class="sidebar">
          <input type="text" placeholder="Filter models..." />
        </div>
        <form class="composer-container">
          <div
            id="prompt-textarea"
            contenteditable="true"
            role="textbox"
            aria-label="Message ChatGPT"
            placeholder="Ask anything"
          ></div>
          <button type="submit" aria-label="Send prompt">Send</button>
        </form>
      </main>
    `;

    const result = discoverComposerCandidates(doc);
    expect(result.bestCandidate).not.toBeNull();
    expect(result.bestCandidate?.element.id).toBe('prompt-textarea');
    expect(result.bestCandidate?.score).toBeGreaterThan(50);
    expect(result.bestCandidate?.reasons.some((r) => r.includes('contenteditable'))).toBe(true);

    // Search input should be disqualified or severely penalized
    const searchCandidate = result.allCandidates.find((c) => c.element.id === 'search-input');
    expect(searchCandidate?.score).toBeLessThan(0);
    expect(searchCandidate?.rejectionReason).toContain('Search');
  });

  it('falls back gracefully to semantic cues when IDs and class names change completely', () => {
    const doc = document.implementation.createHTMLDocument('Obfuscated Flow UI');
    // Simulated obfuscated build: class names randomized, no data-testid, custom elements
    doc.body.innerHTML = `
      <div class="x78_layout">
        <div class="modal-dialog" hidden>
          <textarea placeholder="Feedback notes"></textarea>
        </div>
        <div class="flow-stage-bottom">
          <textarea
            class="obfuscated_input_99"
            aria-label="Describe the video you want to generate"
            placeholder="Describe your scene..."
          ></textarea>
          <button class="btn_primary_42" aria-label="Generate video">Create</button>
        </div>
      </div>
    `;

    const result = discoverComposerCandidates(doc);
    expect(result.bestCandidate).not.toBeNull();
    expect(result.bestCandidate?.element.getAttribute('aria-label')).toContain('video you want to generate');
    expect(result.bestCandidate?.reasons.some((r) => r.includes('keyword'))).toBe(true);
  });

  it('ranks submit control candidates by proximity and action semantics, rejecting modal close buttons', () => {
    const doc = document.implementation.createHTMLDocument('ChatGPT Modal & Composer');
    doc.body.innerHTML = `
      <div role="dialog" class="terms-modal">
        <button class="btn-close" aria-label="Close dialog">Close</button>
        <button class="btn-cancel">Cancel</button>
      </div>
      <form id="composer-form">
        <div id="prompt-textarea" contenteditable="true"></div>
        <button data-testid="send-button" aria-label="Send message">
          <svg><path d="M0 0 L10 10"></path></svg>
        </button>
      </form>
    `;

    const composer = doc.getElementById('prompt-textarea')!;
    const result = discoverSubmitControlCandidates(doc, composer);

    expect(result.bestCandidate).not.toBeNull();
    expect(result.bestCandidate?.element.getAttribute('data-testid')).toBe('send-button');
    expect(result.bestCandidate?.reasons.some((r) => r.includes('proximity') || r.includes('container'))).toBe(true);

    // Close and Cancel buttons should be rejected/penalized
    const closeCandidate = result.allCandidates.find((c) => c.text.includes('Close') || c.accessibleName.includes('Close'));
    expect(closeCandidate?.score).toBeLessThan(0);
    expect(closeCandidate?.rejectionReason).toContain('modal dismissal');
  });

  it('strictly rejects collection-management controls ("Create collection", "New collection") from being selected as submit control', () => {
    const doc = document.implementation.createHTMLDocument('Google Flow Workspace');
    doc.body.innerHTML = `
      <div class="sidebar">
        <button class="new-collection-btn" aria-label="Create collection">Create collection</button>
        <button class="folder-btn">New folder</button>
        <div class="collection-card" data-testid="collection-item">
          <span>Untitled collection</span>
          <button aria-label="Open collection">Open</button>
        </div>
      </div>
      <div class="flow-composer-dock">
        <textarea placeholder="Describe your image or video..."></textarea>
        <button class="circular-submit-btn" aria-label="Generate">
          <svg><path d="M5 12l14-7-7 14-2-5-5-2z"></path></svg>
        </button>
      </div>
    `;

    const composer = doc.querySelector<HTMLTextAreaElement>('textarea')!;
    const result = discoverSubmitControlCandidates(doc, composer);

    // Collection buttons must be disqualified with score -100
    const collectionCandidate = result.allCandidates.find((c) => c.text.includes('collection') || c.accessibleName.includes('collection'));
    expect(collectionCandidate).toBeDefined();
    expect(collectionCandidate?.score).toBeLessThanOrEqual(-100);
    expect(collectionCandidate?.rejectionReason).toContain('Collection or project management');

    // Best candidate MUST be the circular submit button inside the composer dock
    expect(result.bestCandidate).not.toBeNull();
    expect(result.bestCandidate?.accessibleName).toBe('Generate');
    expect(result.bestCandidate?.score).toBeGreaterThan(50);
  });

  it('selects the circular arrow control at bottom-right of the composer as the Generate control', () => {
    const doc = document.implementation.createHTMLDocument('Google Flow Composer');
    doc.body.innerHTML = `
      <div class="composer-container" data-testid="composer-box">
        <div class="model-picker">
          <button aria-label="Select model: Nano Banana 2.1">Nano Banana 2.1</button>
        </div>
        <textarea placeholder="Describe scene..."></textarea>
        <div class="composer-actions">
          <button aria-label="Add reference image">Upload</button>
          <button class="rounded-full action-btn" aria-label="Run prompt" title="Generate">
            <svg data-icon="arrow-up"><path d="M12 2l-8 8h5v12h6v-12h5z"></path></svg>
          </button>
        </div>
      </div>
    `;

    const composer = doc.querySelector<HTMLTextAreaElement>('textarea')!;
    const result = discoverSubmitControlCandidates(doc, composer);

    expect(result.bestCandidate).not.toBeNull();
    expect(result.bestCandidate?.accessibleName).toBe('Run prompt');
    expect(result.bestCandidate?.reasons.some((r) => r.includes('composer container'))).toBe(true);
    expect(result.bestCandidate?.reasons.some((r) => r.includes('icon'))).toBe(true);
  });

  it('correctly discriminates Google Flow dock controls: rejects Agent, + media, and quality pills in favor of the trailing circular Generate button', () => {
    const doc = document.implementation.createHTMLDocument('Google Flow Live Workspace Dock');
    doc.body.innerHTML = `
      <div class="flow-composer-dock" data-testid="composer-dock">
        <!-- 1. Plus / add media button -->
        <button class="add-media-btn" aria-label="Add media">
          <svg><path d="M12 5v14M5 12h14"></path></svg>
        </button>
        <!-- 2. Agent pill dropdown -->
        <div role="button" aria-haspopup="menu" aria-expanded="false" class="agent-pill">
          <span>Agent</span>
          <svg class="chevron"><path d="M6 9l6 6 6-6"></path></svg>
        </div>
        <!-- 3. Prompt textarea -->
        <textarea id="prompt-input" placeholder="Describe your image or video..."></textarea>
        <!-- 4. Quality / duration selector pill -->
        <div role="button" aria-haspopup="menu" aria-expanded="false" class="quality-pill">
          <span>Video · 360p · 8s</span>
          <svg class="chevron"><path d="M6 9l6 6 6-6"></path></svg>
        </div>
        <!-- 5. Generate action button (circular button with arrow icon) -->
        <button class="generate-btn rounded-full circle" aria-label="Generate">
          <svg data-icon="arrow-up"><path d="M12 2l-8 8h5v12h6v-12h5z"></path></svg>
        </button>
      </div>
    `;

    const composer = doc.getElementById('prompt-input') as HTMLTextAreaElement;
    const result = discoverSubmitControlCandidates(doc, composer);

    // Assert: Agent pill and Quality pill are strictly rejected
    const agentCandidate = result.allCandidates.find((c) => c.text.includes('Agent'));
    expect(agentCandidate).toBeDefined();
    expect(agentCandidate?.score).toBeLessThanOrEqual(-100);
    expect(agentCandidate?.rejectionReason).toBeDefined();

    const qualityCandidate = result.allCandidates.find((c) => c.text.includes('360p'));
    expect(qualityCandidate).toBeDefined();
    expect(qualityCandidate?.score).toBeLessThanOrEqual(-100);

    const plusCandidate = result.allCandidates.find((c) => c.accessibleName === 'Add media');
    expect(plusCandidate).toBeDefined();
    expect(plusCandidate?.score).toBeLessThanOrEqual(-100);

    // Assert: Generate button is the selected best candidate
    expect(result.bestCandidate).not.toBeNull();
    expect(result.bestCandidate?.tagName).toBe('button');
    expect(result.bestCandidate?.accessibleName).toBe('Generate');
    expect(result.bestCandidate?.score).toBeGreaterThan(60);
  });

  it('inspects observable generation evidence across idle, streaming, progress, error, and completed states', () => {
    const doc = document.implementation.createHTMLDocument('State Inspection Test');

    // 1. Idle
    let state = inspectObservableGenerationState(doc);
    expect(state.state).toBe('idle');
    expect(state.stopButtonFound).toBe(false);

    // 2. Active stop button (streaming)
    const stopBtn = doc.createElement('button');
    stopBtn.setAttribute('data-testid', 'stop-button');
    doc.body.appendChild(stopBtn);

    state = inspectObservableGenerationState(doc);
    expect(state.state).toBe('streaming');
    expect(state.stopButtonFound).toBe(true);
    stopBtn.remove();

    // 3. Progress indicator
    const progress = doc.createElement('div');
    progress.className = 'dalle-progress';
    doc.body.appendChild(progress);

    state = inspectObservableGenerationState(doc);
    expect(state.state).toBe('generating');
    expect(state.activeIndicatorCount).toBe(1);
    progress.remove();

    // 4. Completed asset
    const img = doc.createElement('img');
    img.src = 'https://files.oaiusercontent.com/image.webp';
    doc.body.appendChild(img);

    state = inspectObservableGenerationState(doc);
    expect(state.state).toBe('completed');
    expect(state.assetCount).toBe(1);
    img.remove();

    // 5. Error banner
    const errBanner = doc.createElement('div');
    errBanner.setAttribute('data-testid', 'conversation-error');
    errBanner.textContent = 'Too many requests. Please wait a moment.';
    doc.body.appendChild(errBanner);

    state = inspectObservableGenerationState(doc);
    expect(state.state).toBe('error');
    expect(state.errorMessages[0]).toContain('Too many requests');
  });
});

describe('Human-Like Browser Interaction Layer', () => {
  it('enters text into an HTMLTextAreaElement and dispatches input/change events', async () => {
    const doc = document.implementation.createHTMLDocument('Input Test');
    const textarea = doc.createElement('textarea');
    doc.body.appendChild(textarea);

    const inputSpy = vi.fn();
    const changeSpy = vi.fn();
    textarea.addEventListener('input', inputSpy);
    textarea.addEventListener('change', changeSpy);

    const result = await enterTextWithHumanEvents(textarea, 'Neon cyberpunk skyline');
    expect(result.success).toBe(true);
    expect(result.verified).toBe(true);
    expect(textarea.value).toBe('Neon cyberpunk skyline');
    expect(inputSpy).toHaveBeenCalled();
    expect(changeSpy).toHaveBeenCalled();
  });

  it('enters text into a contenteditable element and verifies content', async () => {
    const doc = document.implementation.createHTMLDocument('Contenteditable Test');
    const editable = doc.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    doc.body.appendChild(editable);

    const inputSpy = vi.fn();
    editable.addEventListener('input', inputSpy);

    const result = await enterTextWithHumanEvents(editable, 'A serene mountain lake at sunrise');
    expect(result.success).toBe(true);
    expect(result.verified).toBe(true);
    expect(readElementText(editable)).toBe('A serene mountain lake at sunrise');
    expect(inputSpy).toHaveBeenCalled();
  });

  it('verifies entered text accurately and detects discrepancies', () => {
    const doc = document.implementation.createHTMLDocument('Verification Test');
    const textarea = doc.createElement('textarea');
    textarea.value = 'Exact prompt match';
    doc.body.appendChild(textarea);

    const matched = verifyEnteredText(textarea, 'Exact prompt match');
    expect(matched.verified).toBe(true);
    expect(matched.similarity).toBe(1.0);

    const mismatch = verifyEnteredText(textarea, 'Completely different prompt');
    expect(mismatch.verified).toBe(false);
  });

  it('activates controls using pointer and mouse sequences and supports keyboard Enter fallback', async () => {
    const doc = document.implementation.createHTMLDocument('Activation Test');
    const form = doc.createElement('form');
    const input = doc.createElement('textarea');
    const button = doc.createElement('button');
    form.appendChild(input);
    form.appendChild(button);
    doc.body.appendChild(form);

    const clickSpy = vi.fn();
    button.addEventListener('click', clickSpy);

    const res = await activateControlWithEvents(button);
    expect(res.activated).toBe(true);
    expect(clickSpy).toHaveBeenCalled();

    // Test fallback when button is disabled
    button.disabled = true;
    const enterSpy = vi.fn();
    input.addEventListener('keydown', enterSpy);

    const fallbackRes = await activateControlWithEvents(button, { keyboardFallbackComposer: input });
    expect(fallbackRes.method).toBe('keyboard_enter');
    expect(enterSpy).toHaveBeenCalled();
  });
});

describe('Observable Submission Verification & Uncertain Submission Handling', () => {
  it('confirms submission when the composer clears and send button disables', async () => {
    const doc = document.implementation.createHTMLDocument('Confirmed Submission');
    const composer = doc.createElement('textarea');
    const sendBtn = doc.createElement('button');
    composer.value = 'My prompt';
    doc.body.appendChild(composer);
    doc.body.appendChild(sendBtn);

    // Simulate page clearing composer upon click
    sendBtn.addEventListener('click', () => {
      composer.value = '';
      sendBtn.disabled = true;
    });

    await activateControlWithEvents(sendBtn);
    const verify = await verifySubmissionEvidence(doc, {
      composerEl: composer,
      submitBtnEl: sendBtn,
      expectedText: 'My prompt',
      maxWaitMs: 100
    });

    expect(verify.confirmed).toBe(true);
    expect(verify.uncertain).toBe(false);
  });

  it('confirms submission when a stop button appears in DOM', async () => {
    const doc = document.implementation.createHTMLDocument('Stop Button Test');
    const composer = doc.createElement('textarea');
    const sendBtn = doc.createElement('button');
    doc.body.appendChild(composer);
    doc.body.appendChild(sendBtn);

    sendBtn.addEventListener('click', () => {
      const stop = doc.createElement('button');
      stop.setAttribute('data-testid', 'stop-button');
      doc.body.appendChild(stop);
    });

    await activateControlWithEvents(sendBtn);
    const verify = await verifySubmissionEvidence(doc, {
      composerEl: composer,
      submitBtnEl: sendBtn,
      expectedText: 'My prompt',
      maxWaitMs: 100
    });

    expect(verify.confirmed).toBe(true);
    expect(verify.evidence).toContain('Stop button appeared');
  });

  it('detects uncertain submission when click occurs but page state does NOT change at all', async () => {
    const doc = document.implementation.createHTMLDocument('Uncertain Submission');
    doc.body.innerHTML = `
      <div id="composer-area">
        <div id="prompt-textarea" contenteditable="true"></div>
        <button data-testid="send-button">Send</button>
      </div>
    `;

    const adapter = new ChatGPTDomAdapter(doc, () => 'https://chatgpt.com/');
    const task = makeTask();

    // The send button is clicked, but the simulated page does NOT clear the input,
    // does NOT disable the button, and does NOT add a stop button or turn.
    const sendBtn = doc.querySelector<HTMLButtonElement>('[data-testid="send-button"]')!;
    const clickSpy = vi.fn();
    sendBtn.addEventListener('click', clickSpy);

    const subRes = await adapter.submitTask(task, [], { maxWaitMs: 50 });

    // Must NOT be marked as submitted!
    expect(subRes.submitted).toBe(false);
    expect(subRes.errorCode).toBe('SUBMISSION_UNCERTAIN');
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(subRes.diagnostics).toContain('could not be conclusively verified');
  });

  it('transitions task to needs_attention without duplicate resubmission when submission is uncertain', async () => {
    await closeAndResetDatabase();

    const created = await createBatchWithTasks({
      name: 'Uncertain Test Batch',
      platform: 'chatgpt',
      taskType: 'image',
      prompts: [
        { index: 1, prompt: 'Task 1 prompt', referenceNames: [], generationSettings: {} },
        { index: 2, prompt: 'Task 2 prompt', referenceNames: [], generationSettings: {} }
      ]
    });

    const doc = document.implementation.createHTMLDocument('Uncertain Page');
    doc.body.innerHTML = `
      <div id="prompt-textarea" contenteditable="true"></div>
      <button data-testid="send-button">Send</button>
    `;

    // Adapter where click does not change page state (uncertain submission)
    const adapter = new ChatGPTDomAdapter(doc, () => 'https://chatgpt.com/');

    const stepResult = await stepBatchQueue(created.batch.id, adapter);

    // Queue must pause on task 1 in needs_attention state!
    const task1 = await getTask(created.tasks[0].id);
    expect(task1?.status).toBe('needs_attention');
    expect(task1?.lastError?.code).toBe('SUBMISSION_UNCERTAIN');

    // Batch status should be needs_attention
    const batch = await getBatch(created.batch.id);
    expect(batch?.status).toBe('needs_attention');

    // Task 2 must still be pending (NEVER blindly proceeded or duplicated!)
    const task2 = await getTask(created.tasks[1].id);
    expect(task2?.status).toBe('pending');
  });
});

describe('Error Recovery & Missing Controls', () => {
  it('reports CONTROLS_NOT_FOUND with actionable diagnostics when composer is absent', async () => {
    const doc = document.implementation.createHTMLDocument('Empty Page');
    doc.body.innerHTML = `<div>No inputs here</div>`;

    const adapter = new ChatGPTDomAdapter(doc, () => 'https://chatgpt.com/');
    const task = makeTask();

    const result = await adapter.submitTask(task, []);
    expect(result.submitted).toBe(false);
    expect(result.errorCode).toBe('CONTROLS_NOT_FOUND');
    expect(result.userMessage).toContain('prompt box was not found');
  });

  it('detects rate limits and policy violations during generation observation', async () => {
    const doc = document.implementation.createHTMLDocument('Error Banner');
    doc.body.innerHTML = `
      <div data-testid="conversation-error">You have hit the hourly image generation limit.</div>
    `;

    const adapter = new ChatGPTDomAdapter(doc, () => 'https://chatgpt.com/');
    const task = makeTask({ status: 'generating' });

    const status = await adapter.getTaskStatus(task);
    expect(status.state).toBe('failed');
    expect(status.errorCode).toBe('GENERATION_FAILED');
    expect(status.userMessage).toContain('hourly image generation limit');
  });

  it('guarantees that a visible prompt does not imply submission', async () => {
    const doc = document.implementation.createHTMLDocument('Visible Prompt Not Submitted');
    const composer = doc.createElement('textarea');
    composer.value = 'Unsubmitted draft text';
    doc.body.appendChild(composer);

    // No submission took place, no buttons clicked
    const verify = await verifySubmissionEvidence(doc, {
      composerEl: composer,
      expectedText: 'Unsubmitted draft text',
      maxWaitMs: 30
    });

    expect(verify.confirmed).toBe(false);
  });

  it('guarantees that a button click does not imply generation started', async () => {
    const doc = document.implementation.createHTMLDocument('Click Without Generation');
    const composer = doc.createElement('textarea');
    const button = doc.createElement('button');
    composer.value = 'My prompt';
    doc.body.appendChild(composer);
    doc.body.appendChild(button);

    const clickSpy = vi.fn();
    button.addEventListener('click', clickSpy);

    await activateControlWithEvents(button);
    expect(clickSpy).toHaveBeenCalledTimes(1);

    // Button clicked, but NO observable state change happened
    const verify = await verifySubmissionEvidence(doc, {
      composerEl: composer,
      submitBtnEl: button,
      expectedText: 'My prompt',
      maxWaitMs: 30
    });

    expect(verify.confirmed).toBe(false);
    expect(verify.uncertain).toBe(true);
  });

  it('ensures persistent idle state past observation window does not stall forever in "Generation is still in progress"', () => {
    const task = makeTask({
      status: 'generating',
      submittedAt: 1000,
      initialObservationUntil: 11000,
      timeoutAt: 120000
    });

    const settings = {
      initialObservationMinSec: 10,
      initialObservationMaxSec: 15,
      maxImageTimeoutSec: 120,
      maxVideoTimeoutSec: 300,
      pollIntervalSec: 2,
      maxAutoRetries: 2,
      timeoutPolicy: 'keep_waiting' as const
    };

    // At 15 seconds (initial window elapsed), state is still idle
    const evalGrace = evaluateGenerationObservation({
      task,
      settings,
      observableState: 'idle',
      now: 15000
    });
    expect(evalGrace.decision).toBe('continue_generating');

    // Past grace period (30 seconds past initial window, platform still completely idle)
    const evalStalled = evaluateGenerationObservation({
      task,
      settings,
      observableState: 'idle',
      now: 35000
    });

    // MUST NOT remain in continue_generating indefinitely!
    expect(evalStalled.decision).toBe('needs_attention');
    expect(evalStalled.friendlyStatus).toContain('No active generation detected');
  });

  it('transitions ambiguous generation results to needs_attention instead of claiming false success', async () => {
    await closeAndResetDatabase();

    const created = await createBatchWithTasks({
      name: 'Ambiguous Result Batch',
      platform: 'google_flow',
      taskType: 'image',
      prompts: [{ index: 1, prompt: 'A magic forest', referenceNames: [], generationSettings: {} }]
    });

    const doc = document.implementation.createHTMLDocument('Google Flow Result Missing');
    doc.body.innerHTML = `
      <textarea data-testid="flow-prompt-input"></textarea>
      <button data-testid="flow-generate-button">Generate</button>
      <div id="results-area"></div>
    `;

    const adapter = new GoogleFlowDomAdapter(doc, () => 'https://flow.google/');

    // Submit task first
    const genBtn = doc.querySelector<HTMLButtonElement>('[data-testid="flow-generate-button"]')!;
    genBtn.addEventListener('click', () => {
      genBtn.disabled = true;
    });

    await stepBatchQueue(created.batch.id, adapter);

    // Simulate task entering generating state
    const runningTask = await getTask(created.tasks[0].id);
    expect(runningTask?.status).toBe('generating');

    // Simulate generation observation where observableState is completed but 0 assets are actually in DOM
    const evalDecision = evaluateGenerationObservation({
      task: runningTask!,
      settings: created.batch.timeoutSettings,
      observableState: 'completed',
      now: Date.now() + 20000
    });
    expect(evalDecision.decision).toBe('proceed_to_download');

    // Step queue: when adapter returns completed state but 0 assets can be found, it marks task failed/needs_attention
    vi.spyOn(adapter, 'getTaskStatus').mockResolvedValueOnce({
      state: 'completed',
      detectedAssets: []
    });
    vi.spyOn(adapter, 'getResults').mockResolvedValueOnce([]);

    await stepBatchQueue(created.batch.id, adapter, undefined, Date.now() + 25000);
    const checkedTask = await getTask(created.tasks[0].id);
    expect(checkedTask?.lastError?.code).toBe('RESULT_NOT_IDENTIFIED');
  });

  it('correctly handles real Google Flow DOM (deeply nested textarea, 16:9 dock pill, google-symbols arrow_forward, splash disappearance, and googleusercontent output)', async () => {
    const doc = document.implementation.createHTMLDocument('Real Google Flow Workspace');
    doc.body.innerHTML = `
      <main>
        <div id="empty-splash">Start creating or drop media</div>
        <div id="workspace-grid"></div>
        <div class="sc-dock-outer">
          <div class="sc-dock-inner">
            <div class="sc-row-top">
              <div class="sc-field-wrap">
                <div class="sc-infix">
                  <textarea placeholder="What do you want to create?"></textarea>
                </div>
              </div>
            </div>
            <div class="sc-row-bottom">
              <button aria-label="Add media"><i class="google-symbols">add</i></button>
              <div role="button" aria-label="Agent"><span>Agent</span></div>
              <button id="dock-settings-pill" aria-label="Nano Banana 2.1 16:9 x1" aria-haspopup="dialog">
                <span>Nano Banana 2.1</span><span>x1</span>
              </button>
              <button id="real-flow-submit"><i class="google-symbols">arrow_forward</i></button>
            </div>
          </div>
        </div>
      </main>
    `;

    const settingsPill = doc.getElementById('dock-settings-pill') as HTMLButtonElement;
    const realSubmitBtn = doc.getElementById('real-flow-submit') as HTMLButtonElement;
    const pillClickSpy = vi.fn();
    settingsPill.addEventListener('click', pillClickSpy);

    // When the real arrow_forward button is clicked, Google Flow removes the empty splash and starts generating
    realSubmitBtn.addEventListener('click', () => {
      const splash = doc.getElementById('empty-splash');
      splash?.remove();
      const grid = doc.getElementById('workspace-grid')!;
      grid.innerHTML = `
        <div class="sc-tile">
          <span role="status">12%</span>
        </div>
      `;
    });

    const adapter = new GoogleFlowDomAdapter(
      doc,
      () => 'https://labs.google/fx/tools/flow/project/real-project-123'
    );

    const task = makeTask({
      platform: 'google_flow',
      taskType: 'image',
      originalPrompt: 'Cinematic neon street in Tokyo',
      finalPromptSnapshot: 'Cinematic neon street in Tokyo',
      generationSettings: {
        aspectRatio: '16:9',
        outputCount: 1
      }
    });

    const subRes = await adapter.submitTask(task, [], { maxWaitMs: 300 });

    // 1. Settings pill with aria-label containing "16:9" must NEVER be clicked
    expect(pillClickSpy).not.toHaveBeenCalled();

    // 2. Real arrow_forward button must be activated and submission confirmed via splash removal / percentage status
    expect(subRes.submitted).toBe(true);

    // 3. While percentage indicator is present, getTaskStatus must report 'active'
    const activeStatus = await adapter.getTaskStatus(task);
    expect(activeStatus.state).toBe('active');

    // 4. When Google Flow replaces the percentage tile with a googleusercontent <img>, getTaskStatus must detect completion
    const grid = doc.getElementById('workspace-grid')!;
    grid.innerHTML = `
      <div class="sc-tile">
        <img src="https://lh3.googleusercontent.com/aida/generated-image-xyz" alt="Generated output" />
      </div>
    `;

    const completedStatus = await adapter.getTaskStatus(task);
    expect(completedStatus.state).toBe('completed');
    expect(completedStatus.detectedAssets).toHaveLength(1);
    expect(completedStatus.detectedAssets[0].url).toContain('googleusercontent.com');
  });

  it('ignores OneGoogleBar profile avatar (img.gb_0.gbii) and selects button.flow-icon-button-secondary over the × clear button in AiSandboxAngularFrontend', async () => {
    const doc = document.implementation.createHTMLDocument('AiSandboxAngularFrontend Live Page');
    doc.body.innerHTML = `
      <div class="boqOnegoogleliteOgbOneGoogleBar">
        <div id="gb">
          <a class="gb_B" aria-label="Google Account: User">
            <img
              class="gb_0 gbii"
              src="https://lh3.googleusercontent.com/ogw/AF2bZyjfOeCGxvxTZVbS56dv7sW35onywwzZHHCa0N06nAmA9Q=s32-c-mo"
              srcset="https://lh3.googleusercontent.com/ogw/AF2bZyjfOeCGxvxTZVbS56dv7sW35onywwzZHHCa0N06nAmA9Q=s32-c-mo 1x, https://lh3.googleusercontent.com/ogw/AF2bZyjfOeCGxvxTZVbS56dv7sW35onywwzZHHCa0N06nAmA9Q=s64-c-mo 2x"
              alt=""
              aria-hidden="true"
            />
          </a>
        </div>
      </div>
      <aisandbox-root>
        <mat-sidenav-container class="mat-drawer-container mat-sidenav-container aisandbox-sidenav-container">
          <mat-sidenav class="sidenav">
            <img src="https://lh3.googleusercontent.com/sidebar-icon" />
          </mat-sidenav>
          <mat-sidenav-content class="mat-drawer-content mat-sidenav-content">
            <div id="splash-banner">Start creating or drop media</div>
            <div id="output-canvas">
              <img src="https://lh3.googleusercontent.com/aida/pre-existing-image-000" />
            </div>
            <div class="prompt-dock-container">
              <div class="prompt-top-input-wrapper">
                <textarea placeholder="What do you want to create?"></textarea>
                <button id="clear-btn" class="mdc-icon-button mat-mdc-icon-button flow-icon-button-transparent" aria-label="Clear">
                  <mat-icon class="google-material-icons">close</mat-icon>
                </button>
              </div>
              <div class="prompt-bottom-actions">
                <button id="add-media-btn" class="mdc-icon-button mat-mdc-icon-button flow-icon-button-primary">
                  <mat-icon class="google-material-icons">add</mat-icon>
                </button>
                <button id="settings-chip" class="mat-mdc-button">
                  <span>Nano Banana 2</span>
                  <span>x1</span>
                </button>
                <button id="submit-arrow-btn" class="mdc-icon-button mat-mdc-icon-button flow-icon-button-secondary">
                  <mat-icon class="google-material-icons">arrow_forward</mat-icon>
                </button>
              </div>
            </div>
          </mat-sidenav-content>
        </mat-sidenav-container>
      </aisandbox-root>
    `;

    const clearBtn = doc.getElementById('clear-btn') as HTMLButtonElement;
    const submitArrowBtn = doc.getElementById('submit-arrow-btn') as HTMLButtonElement;
    const clearSpy = vi.fn();
    const submitSpy = vi.fn();
    clearBtn.addEventListener('click', clearSpy);

    // If verifySubmissionEvidence falsely counted img.gb_0.gbii at 0ms before/without real submission evidence,
    // a broken implementation would report confirmed:true even when submitArrowBtn does nothing.
    // Here, verify that without any DOM change on click, verifySubmissionEvidence does NOT false-positive on img.gb_0.gbii:
    const textarea = doc.querySelector('textarea')!;
    textarea.value = 'Test prompt';
    const falsePositiveCheck = await verifySubmissionEvidence(doc, {
      composerEl: textarea,
      submitBtnEl: submitArrowBtn,
      expectedText: 'Test prompt',
      previousOutputCount: 1,
      maxWaitMs: 50
    });
    expect(falsePositiveCheck.confirmed).toBe(false);

    // Now wire submitArrowBtn to clear the prompt and remove the splash banner when clicked
    submitArrowBtn.addEventListener('click', () => {
      submitSpy();
      textarea.value = '';
      doc.getElementById('splash-banner')?.remove();
    });

    const adapter = new GoogleFlowDomAdapter(
      doc,
      () => 'https://flow.google.com/project/bb3c7ae7-bfe5-47fd-9f53-38f60e3ad52b'
    );

    const task = makeTask({
      platform: 'google_flow',
      taskType: 'image',
      originalPrompt: 'A surreal desert oasis under two moons',
      finalPromptSnapshot: 'A surreal desert oasis under two moons'
    });

    const subRes = await adapter.submitTask(task, [], { maxWaitMs: 250 });
    expect(clearSpy).not.toHaveBeenCalled();
    expect(submitSpy).toHaveBeenCalled();
    expect(subRes.submitted).toBe(true);

    // Simulate Google Flow prepending the newly generated image at the top-left of #output-canvas
    // inside .aisandbox-sidenav-container > .mat-sidenav-content
    const outputCanvas = doc.getElementById('output-canvas')!;
    outputCanvas.innerHTML = `
      <div class="flow-tile">
        <img src="https://lh3.googleusercontent.com/aida/newly-generated-oasis-999" aria-hidden="true" />
        <img src="https://lh3.googleusercontent.com/aida/newly-generated-oasis-999" />
      </div>
      <img src="https://lh3.googleusercontent.com/aida/pre-existing-image-000" />
    `;

    const doneStatus = await adapter.getTaskStatus(task);
    expect(doneStatus.state).toBe('completed');
    expect(doneStatus.detectedAssets).toHaveLength(1);
    expect(doneStatus.detectedAssets[0].url).toBe(
      'https://lh3.googleusercontent.com/aida/newly-generated-oasis-999'
    );
    expect(doneStatus.detectedAssets[0].extension).toBe('png');
  });
});
