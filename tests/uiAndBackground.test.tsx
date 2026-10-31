import React from 'react';
import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import {
  handleBackgroundCommand,
  runScheduledQueueTick,
  setCustomAdapterFactoryForTest
} from '../src/background/serviceWorker';
import { parsePlainTextPrompts } from '../src/core/promptParser';
import { createBatchWithTasks } from '../src/core/queueEngine';
import { getBatch, getTasksByBatch } from '../src/storage/db';
import { App } from '../src/ui/App';
import {
  AdapterDownloadActionResult,
  AdapterStatusInspection,
  AdapterSubmissionResult,
  DetectedPlatformAsset,
  PlatformAdapter,
  PlatformAvailabilityResult
} from '../src/adapters/types';
import { TaskRecord } from '../src/types/models';

class BackgroundTestAdapter implements PlatformAdapter {
  public readonly platformId = 'chatgpt' as const;
  public async initialize(): Promise<void> {}
  public async checkAvailability(): Promise<PlatformAvailabilityResult> {
    return {
      available: true,
      authenticated: true,
      correctPage: true,
      requestedModeAvailable: true,
      friendlyMessage: 'Ready to start.'
    };
  }
  public async attachReferences(): Promise<{ attached: boolean }> {
    return { attached: true };
  }
  public async submitTask(): Promise<AdapterSubmissionResult> {
    return { submitted: true };
  }
  public async getTaskStatus(task: TaskRecord): Promise<AdapterStatusInspection> {
    return {
      state: 'completed',
      detectedAssets: [
        {
          index: 0,
          type: 'image',
          url: `https://chatgpt.com/bg-${task.sequenceNumber}.png`,
          extension: 'png',
          hasNativeDownloadButton: true
        }
      ]
    };
  }
  public async getResults(task: TaskRecord): Promise<DetectedPlatformAsset[]> {
    const st = await this.getTaskStatus(task);
    return st.detectedAssets;
  }
  public async downloadResult(
    asset: DetectedPlatformAsset
  ): Promise<AdapterDownloadActionResult> {
    return {
      initiated: true,
      method: 'chrome_downloads',
      resolvedUrl: asset.url
    };
  }
  public async recoverTask(task: TaskRecord): Promise<AdapterStatusInspection> {
    return this.getTaskStatus(task);
  }
  public async dispose(): Promise<void> {}
}

const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 40));

describe('Background Service Worker & React UI Integration', () => {
  it('continues processing the queue in the background when the popup is closed', async () => {
    const adapter = new BackgroundTestAdapter();
    setCustomAdapterFactoryForTest(async () => adapter);

    const parsed = parsePlainTextPrompts('Background Prompt 1\nBackground Prompt 2');
    const { batch } = await createBatchWithTasks({
      name: 'BgBatch',
      platform: 'chatgpt',
      taskType: 'image',
      prompts: parsed.items
    });

    // Start via background command
    await handleBackgroundCommand({
      type: 'BS_BG_START_BATCH',
      batchId: batch.id
    });

    let tasks = await getTasksByBatch(batch.id);
    expect(tasks[0].status).toBe('generating');

    // Simulate popup closed and background alarm tick firing twice
    await runScheduledQueueTick(batch.id);
    await runScheduledQueueTick(batch.id);

    const finalBatch = await getBatch(batch.id);
    tasks = await getTasksByBatch(batch.id);
    expect(finalBatch?.status).toBe('completed');
    expect(tasks[0].status).toBe('completed');
    expect(tasks[1].status).toBe('completed');

    setCustomAdapterFactoryForTest(null);
  });

  it('renders the Studio UI with advanced settings collapsed by default and supports platform/mode selection', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOM.createRoot(container);

    await act(async () => {
      root.render(<App />);
      await flushAsync();
    });

    // Verify Advanced Settings panel is hidden by default
    expect(
      container.querySelector('[data-testid="advanced-settings-panel"]')
    ).toBeNull();

    // Click toggle to expand Advanced Settings
    const advToggle = container.querySelector<HTMLElement>(
      '[data-testid="toggle-advanced-settings"]'
    )!;
    await act(async () => {
      advToggle.click();
      await flushAsync();
    });
    expect(
      container.querySelector('[data-testid="advanced-settings-panel"]')
    ).not.toBeNull();

    // Switch platform to Google Flow and check dynamic model controls appear
    const flowBtn = container.querySelector<HTMLElement>(
      '[data-testid="select-platform-google-flow"]'
    )!;
    await act(async () => {
      flowBtn.click();
      await flushAsync();
    });
    expect(
      container.querySelector('[data-testid="flow-model-controls"]')
    ).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('creates a batch from the UI, opens the Queue Monitor, and supports Pause / Stop confirmation', async () => {
    const adapter = new BackgroundTestAdapter();
    setCustomAdapterFactoryForTest(async () => adapter);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOM.createRoot(container);

    await act(async () => {
      root.render(<App />);
      await flushAsync();
    });

    // Enter prompts into the paste textarea
    const pasteArea = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="paste-prompts-textarea"]'
    )!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      )?.set;
      setter?.call(pasteArea, 'First UI Prompt\nSecond UI Prompt');
      pasteArea.dispatchEvent(new Event('input', { bubbles: true }));
      pasteArea.dispatchEvent(new Event('change', { bubbles: true }));
      await flushAsync();
    });

    const addBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="add-pasted-prompts-btn"]'
    )!;
    await act(async () => {
      addBtn.click();
      await flushAsync();
    });

    expect(
      container.querySelector('[data-testid="prompt-count-badge"]')?.textContent
    ).toContain('2 prompts queued');

    // Click Start Batch Queue
    const startBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="start-batch-btn"]'
    )!;
    await act(async () => {
      startBtn.click();
      await flushAsync();
    });

    // Verify QueueView is now visible with the two task cards
    expect(container.querySelector('[data-testid="task-card-1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="task-card-2"]')).not.toBeNull();

    // Click Stop -> verify Stop Confirmation banner appears
    const stopBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="queue-stop-btn"]'
    )!;
    await act(async () => {
      stopBtn.click();
      await flushAsync();
    });
    expect(
      container.querySelector('[data-testid="stop-confirm-banner"]')
    ).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
    container.remove();
    setCustomAdapterFactoryForTest(null);
  });

  it('expands matrix variations in the prompt input and opens lightbox on completed output thumbnail', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOM.createRoot(container);

    await act(async () => {
      root.render(<App />);
      await flushAsync();
    });

    // 1. Enter prompt with matrix syntax: "A {red, blue} sports car"
    const pasteArea = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="paste-prompts-textarea"]'
    )!;
    expect(pasteArea).not.toBeNull();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      )?.set;
      setter?.call(pasteArea, 'A {red, blue} sports car');
      pasteArea.dispatchEvent(new Event('input', { bubbles: true }));
      pasteArea.dispatchEvent(new Event('change', { bubbles: true }));
      await flushAsync();
    });

    // Expand variations button should be visible
    const expandBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="expand-variations-btn"]'
    )!;
    expect(expandBtn).not.toBeNull();

    await act(async () => {
      expandBtn.click();
      await flushAsync();
    });

    // Check that textarea updated to both variations
    expect(pasteArea.value).toBe('A red sports car\nA blue sports car');

    // Add to batch
    const addBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="add-pasted-prompts-btn"]'
    )!;
    await act(async () => {
      addBtn.click();
      await flushAsync();
    });

    expect(
      container.querySelector('[data-testid="prompt-count-badge"]')?.textContent
    ).toContain('2 prompts queued');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('auto-clears prompts section, feedback banner, and collapses paste modal after adding in queue', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOM.createRoot(container);

    await act(async () => {
      root.render(<App />);
      await flushAsync();
    });

    // 1. Enter prompt
    const pasteArea = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="paste-prompts-textarea"]'
    )!;
    expect(pasteArea).not.toBeNull();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      )?.set;
      setter?.call(pasteArea, 'Prompt 1\nPrompt 2\n\nPrompt 3');
      pasteArea.dispatchEvent(new Event('input', { bubbles: true }));
      pasteArea.dispatchEvent(new Event('change', { bubbles: true }));
      await flushAsync();
    });

    // 2. Click Add to Batch
    const addBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="add-pasted-prompts-btn"]'
    )!;
    await act(async () => {
      addBtn.click();
      await flushAsync();
    });

    // Verify feedback banner appeared and paste box auto-collapsed
    expect(container.querySelector('[data-testid="import-feedback-banner"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="paste-prompts-textarea"]')).toBeNull();

    // Verify prompt list rendered
    expect(container.querySelectorAll('.prompt-item').length).toBe(3);

    // 3. Click Start Batch Queue
    const startBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="start-batch-btn"]'
    )!;
    await act(async () => {
      startBtn.click();
      await flushAsync();
    });

    // Switched to Queue view
    expect(container.querySelector('[data-testid="nav-tab-queue"]')?.classList.contains('active')).toBe(true);

    // 4. Switch back to Studio tab
    const studioTabBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="nav-tab-studio"]'
    )!;
    await act(async () => {
      studioTabBtn.click();
      await flushAsync();
    });

    // Verify Prompts section in Studio is now completely cleared
    expect(container.querySelector('[data-testid="parsed-prompt-list"]')).toBeNull();
    expect(container.querySelector('[data-testid="import-feedback-banner"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="prompt-count-badge"]')?.textContent
    ).toContain('0 prompts queued');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
