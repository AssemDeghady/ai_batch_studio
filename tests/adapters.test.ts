import { describe, expect, it, vi } from 'vitest';
import { ChatGPTDomAdapter } from '../src/adapters/chatgptAdapter';
import { GoogleFlowDomAdapter } from '../src/adapters/googleFlowAdapter';
import { TaskRecord } from '../src/types/models';

const SAMPLE_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function makeDummyTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task_test_1',
    batchId: 'batch_test_1',
    sequenceNumber: 1,
    originalPrompt: 'A cinematic desert caravan at dusk',
    finalPromptSnapshot: 'Consistent style.\n\nA cinematic desert caravan at dusk',
    platform: 'chatgpt',
    taskType: 'image',
    status: 'submitting',
    friendlyStatus: 'Submitting prompt.',
    referenceIds: [],
    generationSettings: {},
    createdAt: 1000,
    updatedAt: 1000,
    retryCount: 0,
    outputIds: [],
    ...overrides
  };
}

describe('ChatGPTDomAdapter (Fixture Tests)', () => {
  it('detects wrong domain, login required, and verification challenges accurately', async () => {
    const doc = document.implementation.createHTMLDocument('ChatGPT');

    // Wrong domain
    const wrongDomainAdapter = new ChatGPTDomAdapter(doc, () => 'https://example.com/');
    const resWrong = await wrongDomainAdapter.checkAvailability('image');
    expect(resWrong.available).toBe(false);
    expect(resWrong.errorCode).toBe('WRONG_PAGE');

    // Login required
    doc.body.innerHTML = `<button data-testid="login-button">Log in</button>`;
    const loginAdapter = new ChatGPTDomAdapter(doc, () => 'https://chatgpt.com/');
    const resLogin = await loginAdapter.checkAvailability('image');
    expect(resLogin.available).toBe(false);
    expect(resLogin.errorCode).toBe('LOGIN_REQUIRED');
    expect(resLogin.friendlyMessage).toBe('Login required.');

    // Verification challenge
    doc.body.innerHTML = `<div id="challenge-running">Verify you are human</div>`;
    const challengeAdapter = new ChatGPTDomAdapter(doc, () => 'https://chatgpt.com/');
    const resChallenge = await challengeAdapter.checkAvailability('image');
    expect(resChallenge.available).toBe(false);
    expect(resChallenge.errorCode).toBe('VERIFICATION_REQUIRED');
  });

  it('attaches reference images, submits prompt, tracks active streaming, and extracts completed image results', async () => {
    const doc = document.implementation.createHTMLDocument('ChatGPT');
    doc.body.innerHTML = `
      <main>
        <div data-message-author-role="assistant">Previous turn</div>
        <div id="composer-area">
          <input type="file" accept="image/*" />
          <div id="prompt-textarea" contenteditable="true"></div>
          <button data-testid="send-button">Send</button>
        </div>
      </main>
    `;

    const adapter = new ChatGPTDomAdapter(doc, () => 'https://chatgpt.com/c/123');
    const avail = await adapter.checkAvailability('image');
    expect(avail.available).toBe(true);

    const task = makeDummyTask();
    const attachRes = await adapter.attachReferences(task, [
      {
        metadata: {
          id: 'r1',
          name: 'char.png',
          type: 'character',
          mimeType: 'image/png',
          size: 120,
          storageKey: 'k1',
          thumbnailDataUrl: SAMPLE_PNG_DATA_URL,
          createdAt: 1000
        },
        dataUrl: SAMPLE_PNG_DATA_URL
      }
    ]);
    expect(attachRes.attached).toBe(true);

    const sendBtn = doc.querySelector<HTMLButtonElement>('[data-testid="send-button"]')!;
    const sendClickSpy = vi.fn();
    sendBtn.addEventListener('click', () => {
      sendClickSpy();
      sendBtn.disabled = true;
    });

    const subRes = await adapter.submitTask(task, []);
    expect(subRes.submitted).toBe(true);
    expect(sendClickSpy).toHaveBeenCalledTimes(1);
    expect(doc.querySelector('#prompt-textarea')?.textContent).toBe(
      task.finalPromptSnapshot
    );

    // Simulate active streaming state with stop button
    const stopBtn = doc.createElement('button');
    stopBtn.setAttribute('data-testid', 'stop-button');
    doc.body.appendChild(stopBtn);

    const activeStatus = await adapter.getTaskStatus(task);
    expect(activeStatus.state).toBe('active');

    // Simulate streaming finished and new assistant turn with generated image + download button
    stopBtn.remove();
    const newTurn = doc.createElement('div');
    newTurn.setAttribute('data-message-author-role', 'assistant');
    newTurn.innerHTML = `
      <figure>
        <img src="https://files.oaiusercontent.com/generated-desert.webp" alt="Generated image" width="1024" />
        <button data-testid="download-image-button">Download</button>
      </figure>
    `;
    doc.querySelector('main')!.appendChild(newTurn);

    const completedStatus = await adapter.getTaskStatus(task);
    expect(completedStatus.state).toBe('completed');
    expect(completedStatus.detectedAssets).toHaveLength(1);
    expect(completedStatus.detectedAssets[0].extension).toBe('webp');
    expect(completedStatus.detectedAssets[0].hasNativeDownloadButton).toBe(true);

    // Verify native download button click
    const dlBtn = newTurn.querySelector<HTMLButtonElement>(
      '[data-testid="download-image-button"]'
    )!;
    const dlClickSpy = vi.fn();
    dlBtn.addEventListener('click', dlClickSpy);

    const dlAction = await adapter.downloadResult(
      completedStatus.detectedAssets[0],
      'BatchStudio/Desert_001.webp'
    );
    expect(dlAction.initiated).toBe(true);
    expect(dlAction.method).toBe('native_button');
    expect(dlClickSpy).toHaveBeenCalledTimes(1);
  });
});

describe('GoogleFlowDomAdapter (Fixture Tests for Image & Video Workflows)', () => {
  it('validates Google Flow capabilities and rejects unsupported model/video-mode combinations', async () => {
    const doc = document.implementation.createHTMLDocument('Google Flow');
    doc.body.innerHTML = `
      <textarea data-testid="flow-prompt-input"></textarea>
      <button data-testid="flow-generate-button">Generate</button>
    `;

    const adapter = new GoogleFlowDomAdapter(
      doc,
      () => 'https://labs.google/fx/tools/flow'
    );

    // Veo 2 does not support reference_ingredients mode
    const invalidCap = await adapter.checkAvailability('video', {
      model: 'veo_2',
      videoMode: 'reference_ingredients'
    });
    expect(invalidCap.available).toBe(false);
    expect(invalidCap.errorCode).toBe('UNSUPPORTED_VIDEO_MODE');

    // Veo 3 Quality supports reference_ingredients with 8s duration
    const validCap = await adapter.checkAvailability('video', {
      model: 'veo_3_quality',
      videoMode: 'reference_ingredients',
      aspectRatio: '16:9',
      durationSec: 8,
      outputCount: 1
    });
    expect(validCap.available).toBe(true);
  });

  it('executes Google Flow video generation workflow and detects completed <video> output', async () => {
    const doc = document.implementation.createHTMLDocument('Google Flow');
    doc.body.innerHTML = `
      <div id="flow-app">
        <button data-flow-tab="video">Video</button>
        <button data-video-mode="text_to_video">Text to Video</button>
        <select data-testid="flow-model-select">
          <option value="veo_2">Veo 2</option>
          <option value="veo_3_quality">Veo 3</option>
        </select>
        <button data-aspect-ratio="16:9">16:9</button>
        <button data-duration="8">8s</button>
        <textarea data-testid="flow-prompt-input"></textarea>
        <button data-testid="flow-generate-button">Generate</button>
        <div id="results-grid"></div>
      </div>
    `;

    const adapter = new GoogleFlowDomAdapter(
      doc,
      () => 'https://labs.google/fx/tools/flow/project/1'
    );

    const videoTask = makeDummyTask({
      id: 'task_flow_vid_1',
      platform: 'google_flow',
      taskType: 'video',
      generationSettings: {
        model: 'veo_2',
        videoMode: 'text_to_video',
        aspectRatio: '16:9',
        durationSec: 8,
        outputCount: 1
      }
    });

    const genBtn = doc.querySelector<HTMLButtonElement>('[data-testid="flow-generate-button"]')!;
    genBtn.addEventListener('click', () => {
      genBtn.disabled = true;
    });

    const sub = await adapter.submitTask(videoTask, []);
    expect(sub.submitted).toBe(true);

    // Simulate active generation progress bar
    const progress = doc.createElement('div');
    progress.setAttribute('data-testid', 'flow-generating-indicator');
    doc.body.appendChild(progress);

    const activeSt = await adapter.getTaskStatus(videoTask);
    expect(activeSt.state).toBe('active');

    // Finish generation and render video card
    progress.remove();
    const resultsGrid = doc.getElementById('results-grid')!;
    resultsGrid.innerHTML = `
      <div class="flow-output-card" data-testid="flow-video-result">
        <video src="https://labs.google/fx/media/generated_clip.mp4"></video>
        <button data-testid="flow-download-button">Download MP4</button>
      </div>
    `;

    const doneSt = await adapter.getTaskStatus(videoTask);
    expect(doneSt.state).toBe('completed');
    expect(doneSt.detectedAssets).toHaveLength(1);
    expect(doneSt.detectedAssets[0].type).toBe('video');
    expect(doneSt.detectedAssets[0].extension).toBe('mp4');
  });

  it('requires reference images when running image_to_video or start_end_frame workflows', async () => {
    const doc = document.implementation.createHTMLDocument('Google Flow');
    doc.body.innerHTML = `
      <textarea data-testid="flow-prompt-input"></textarea>
      <button data-testid="flow-generate-button">Generate</button>
    `;
    const adapter = new GoogleFlowDomAdapter(
      doc,
      () => 'https://labs.google/fx/tools/flow'
    );

    const i2vTask = makeDummyTask({
      platform: 'google_flow',
      taskType: 'video',
      generationSettings: {
        model: 'veo_2',
        videoMode: 'image_to_video'
      }
    });

    const subWithoutRefs = await adapter.submitTask(i2vTask, []);
    expect(subWithoutRefs.submitted).toBe(false);
    expect(subWithoutRefs.errorCode).toBe('REFERENCE_UPLOAD_FAILED');
  });

  it('converts Google Flow image output to a lossless PNG data URL to prevent Windows .jfif downloads and broken previews', async () => {
    const doc = document.implementation.createHTMLDocument('Google Flow');
    doc.body.innerHTML = `
      <div id="results-grid">
        <div class="flow-output-card">
          <img src="blob:https://flow.google.com/test-blob-uuid" data-flow-generated="true" width="1024" height="1024" />
          <button data-testid="download-image-button">Download</button>
        </div>
      </div>
    `;

    const adapter = new GoogleFlowDomAdapter(
      doc,
      () => 'https://labs.google/fx/tools/flow'
    );

    // Mock fetch to return a sample PNG blob
    const sampleBlob = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(sampleBlob)
    }));

    const imageTask = makeDummyTask({
      platform: 'google_flow',
      taskType: 'image'
    });

    const status = await adapter.getTaskStatus(imageTask);
    expect(status.state).toBe('completed');
    expect(status.detectedAssets[0].extension).toBe('png');

    const dlResult = await adapter.downloadResult(status.detectedAssets[0], 'Test_001.png');
    expect(dlResult.initiated).toBe(true);
    expect(dlResult.method).toBe('chrome_downloads');
    expect(dlResult.resolvedUrl).toMatch(/^data:image\/png;base64,/);

    vi.unstubAllGlobals();
  });
});
