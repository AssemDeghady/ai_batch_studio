import { describe, expect, it, vi } from 'vitest';
import {
  AdapterDownloadActionResult,
  AdapterStatusInspection,
  AdapterSubmissionResult,
  DetectedPlatformAsset,
  PlatformAdapter,
  PlatformAvailabilityResult
} from '../src/adapters/types';
import { parsePlainTextPrompts } from '../src/core/promptParser';
import {
  createBatchWithTasks,
  pauseBatchQueue,
  recoverQueueAfterRestart,
  resumeBatchQueue,
  retryAllFailedTasks,
  retrySelectedFailedTasks,
  retrySingleFailedTask,
  startBatchQueue,
  stepBatchQueue,
  updateBatchSharedPrefix,
  updateTaskPromptAndSettings
} from '../src/core/queueEngine';
import {
  addReferenceImage,
  deleteReference,
  ReferenceValidationError
} from '../src/core/referenceManager';
import { formatDateToken } from '../src/core/fileNaming';
import { retryTaskDownloadsOnly } from '../src/downloads/downloadManager';
import {
  cleanupOrphanReferences,
  deleteBatchCascade,
  getAllReferences,
  getBatch,
  getOutputsByBatch,
  getTasksByBatch
} from '../src/storage/db';
import { DEFAULT_DOWNLOAD_SETTINGS, TaskRecord } from '../src/types/models';
import { mockChromeState } from './setup';

const SAMPLE_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

class SimulatedPlatformAdapter implements PlatformAdapter {
  public readonly platformId = 'chatgpt' as const;
  public submittedPrompts: string[] = [];
  public attachedRefsCount: number[] = [];
  public nextStatusByTask = new Map<string, AdapterStatusInspection>();
  public failSubmissionForTaskIds = new Set<string>();

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

  public async attachReferences(
    _task: TaskRecord,
    references: unknown[]
  ): Promise<{ attached: boolean }> {
    this.attachedRefsCount.push(references.length);
    return { attached: true };
  }

  public async submitTask(task: TaskRecord): Promise<AdapterSubmissionResult> {
    if (this.failSubmissionForTaskIds.has(task.id)) {
      return {
        submitted: false,
        errorCode: 'CONTROLS_NOT_FOUND',
        userMessage: 'Simulated submission error'
      };
    }
    this.submittedPrompts.push(task.finalPromptSnapshot);
    return { submitted: true };
  }

  public async getTaskStatus(task: TaskRecord): Promise<AdapterStatusInspection> {
    return (
      this.nextStatusByTask.get(task.id) || {
        state: 'completed',
        detectedAssets: [
          {
            index: 0,
            type: 'image',
            url: `https://chatgpt.com/mock-output-${task.sequenceNumber}.png`,
            extension: 'png',
            hasNativeDownloadButton: true
          }
        ]
      }
    );
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

describe('End-to-End Batch & Queue Integration Tests', () => {
  it('executes a batch sequentially, applies shared prefix once, attaches references, and downloads numbered files', async () => {
    const sharedRef = await addReferenceImage({
      name: 'character_sheet.png',
      mimeType: 'image/png',
      size: 512,
      dataUrl: SAMPLE_PNG_DATA_URL,
      type: 'character'
    });

    const task2Ref = await addReferenceImage({
      name: 'oasis_env.png',
      mimeType: 'image/png',
      size: 512,
      dataUrl: SAMPLE_PNG_DATA_URL,
      type: 'environment'
    });

    const parsed = parsePlainTextPrompts('Nomad walking at dawn\nNomad resting by oasis');
    const { batch, tasks } = await createBatchWithTasks({
      name: 'Desert_Story',
      platform: 'chatgpt',
      taskType: 'image',
      prompts: parsed.items,
      globalPrefix: 'Maintain consistent character style.',
      prefixEnabled: true,
      sharedReferenceIds: [sharedRef.id],
      taskReferenceIdsMap: { 1: [task2Ref.id] }
    });

    expect(tasks).toHaveLength(2);
    expect(tasks[0].finalPromptSnapshot).toBe(
      'Maintain consistent character style.\n\nNomad walking at dawn'
    );

    const adapter = new SimulatedPlatformAdapter();

    // Start queue -> submits Task 1 (sequential: Task 2 remains pending!)
    const afterStart = await startBatchQueue(batch.id, adapter);
    expect(afterStart.tasks[0].status).toBe('generating');
    expect(afterStart.tasks[1].status).toBe('pending');
    expect(adapter.submittedPrompts).toHaveLength(1);
    expect(adapter.attachedRefsCount[0]).toBe(1); // Shared ref on Task 1

    // Step queue when Task 1 finishes generating -> downloads Task 1 and automatically starts Task 2
    const afterStep1 = await stepBatchQueue(batch.id, adapter);
    expect(afterStep1.tasks[0].status).toBe('completed');
    expect(afterStep1.tasks[0].friendlyStatus).toBe('Download complete.');
    expect(afterStep1.tasks[1].status).toBe('generating');
    expect(adapter.attachedRefsCount[1]).toBe(2); // Shared ref + task2Ref on Task 2

    // Step queue when Task 2 finishes generating -> downloads Task 2 and completes batch
    const afterStep2 = await stepBatchQueue(batch.id, adapter);
    expect(afterStep2.batch.status).toBe('completed');
    expect(afterStep2.tasks[1].status).toBe('completed');

    const outputs = await getOutputsByBatch(batch.id);
    expect(outputs).toHaveLength(2);
    const dateStr = formatDateToken(new Date());
    expect(outputs[0].filename).toBe(`001_Desert_Story_${dateStr}.png`);
    expect(outputs[1].filename).toBe(`002_Desert_Story_${dateStr}.png`);
  });

  it('supports Pause and Resume without losing numbering or resubmitting an active generation', async () => {
    const parsed = parsePlainTextPrompts('Prompt One\nPrompt Two');
    const { batch } = await createBatchWithTasks({
      name: 'Pause_Test',
      platform: 'chatgpt',
      taskType: 'image',
      prompts: parsed.items
    });

    const adapter = new SimulatedPlatformAdapter();
    await startBatchQueue(batch.id, adapter);
    expect(adapter.submittedPrompts).toHaveLength(1);

    // Pause while Task 1 is generating
    const pausedState = await pauseBatchQueue(batch.id);
    expect(pausedState.batch.status).toBe('paused');
    expect(pausedState.tasks[0].status).toBe('generating');
    expect(pausedState.tasks[1].status).toBe('pending');

    // Stepping while paused does nothing
    await stepBatchQueue(batch.id, adapter);
    expect(adapter.submittedPrompts).toHaveLength(1);

    // Resume: resolves Task 1 (without resubmitting Task 1!) and starts Task 2
    const resumedState = await resumeBatchQueue(batch.id, adapter);
    expect(resumedState.batch.status).toBe('running');
    expect(resumedState.tasks[0].status).toBe('completed');
    expect(resumedState.tasks[1].status).toBe('generating');
    // Only 2 total submissions (Task 1 once, Task 2 once)
    expect(adapter.submittedPrompts).toHaveLength(2);
  });

  it('supports retrying single, selected, and all failed tasks without rerunning completed tasks or double-prepending prefix', async () => {
    const parsed = parsePlainTextPrompts('Task One\nTask Two\nTask Three');
    const { batch, tasks } = await createBatchWithTasks({
      name: 'Retry_Suite',
      platform: 'chatgpt',
      taskType: 'image',
      prompts: parsed.items,
      globalPrefix: 'Consistent lighting.',
      prefixEnabled: true
    });

    const adapter = new SimulatedPlatformAdapter();
    // Make Task 2 and Task 3 fail on first submission
    adapter.failSubmissionForTaskIds.add(tasks[1].id);
    adapter.failSubmissionForTaskIds.add(tasks[2].id);

    // Start -> Task 1 generating
    await startBatchQueue(batch.id, adapter);
    // Step -> Task 1 completes, Task 2 fails, Task 3 fails, Batch completes with 1 completed & 2 failed
    const stateAfterRun = await stepBatchQueue(batch.id, adapter);
    expect(stateAfterRun.tasks[0].status).toBe('completed');
    expect(stateAfterRun.tasks[1].status).toBe('failed');
    expect(stateAfterRun.tasks[2].status).toBe('failed');

    // Now allow Task 2 and Task 3 to succeed on retry
    adapter.failSubmissionForTaskIds.clear();

    // Retry only selected Task 2
    await retrySelectedFailedTasks(batch.id, [tasks[1].id], adapter);
    await stepBatchQueue(batch.id, adapter);

    const afterRetry2 = await getTasksByBatch(batch.id);
    expect(afterRetry2[0].status).toBe('completed');
    expect(afterRetry2[1].status).toBe('completed');
    expect(afterRetry2[1].retryCount).toBe(1);
    expect(afterRetry2[2].status).toBe('failed');

    // Verify prefix was NOT prepended twice on retry!
    expect(afterRetry2[1].finalPromptSnapshot).toBe('Consistent lighting.\n\nTask Two');

    // Retry all remaining failed tasks (Task 3)
    await retryAllFailedTasks(batch.id, adapter);
    await stepBatchQueue(batch.id, adapter);

    const finalTasks = await getTasksByBatch(batch.id);
    expect(finalTasks.every((t) => t.status === 'completed')).toBe(true);
    // Task 1 was only submitted once!
    expect(
      adapter.submittedPrompts.filter((p) => p.includes('Task One'))
    ).toHaveLength(1);
  });

  it('separates download failure from generation failure and retries download without regenerating', async () => {
    const parsed = parsePlainTextPrompts('A castle in the clouds');
    const { batch } = await createBatchWithTasks({
      name: 'Download_Retry_Test',
      platform: 'chatgpt',
      taskType: 'image',
      prompts: parsed.items
    });

    const adapter = new SimulatedPlatformAdapter();
    const submitSpy = vi.spyOn(adapter, 'submitTask');

    // Simulate browser download interruption on first download attempt
    mockChromeState.simulateDownloadError = 'NETWORK_FAILED';

    await startBatchQueue(batch.id, adapter);
    const afterGen = await stepBatchQueue(batch.id, adapter);

    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(afterGen.tasks[0].status).toBe('download_failed');
    expect(afterGen.tasks[0].friendlyStatus).toBe(
      'Generation complete, but the download needs attention.'
    );

    // Now clear download network error and retry download ONLY
    mockChromeState.simulateDownloadError = null;
    const retriedTask = await retryTaskDownloadsOnly(afterGen.tasks[0].id, adapter);

    expect(retriedTask.status).toBe('completed');
    expect(retriedTask.friendlyStatus).toBe('Download complete.');
    // Crucial check: submitTask was NEVER called a second time!
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  it('handles automatic numbering disabled and resolves filename collisions safely', async () => {
    const parsed = parsePlainTextPrompts('Same Prompt\nSame Prompt');
    const { batch } = await createBatchWithTasks({
      name: 'NoNumbering',
      platform: 'chatgpt',
      taskType: 'image',
      prompts: parsed.items,
      downloadSettings: {
        ...DEFAULT_DOWNLOAD_SETTINGS,
        filenameTemplate: '{project}_{prompt}',
        autoNumbering: {
          enabled: false,
          startNumber: 1,
          paddingDigits: 3,
          separator: '_'
        }
      }
    });

    const adapter = new SimulatedPlatformAdapter();
    await startBatchQueue(batch.id, adapter);
    await stepBatchQueue(batch.id, adapter);
    await stepBatchQueue(batch.id, adapter);

    const outputs = await getOutputsByBatch(batch.id);
    expect(outputs).toHaveLength(2);
    expect(outputs[0].filename).toBe('NoNumbering_Same_Prompt.png');
    expect(outputs[1].filename).toBe('NoNumbering_Same_Prompt_2.png');
  });

  it('never silently submits a task when a required reference image is missing from storage', async () => {
    const ref = await addReferenceImage({
      name: 'temp_ref.png',
      mimeType: 'image/png',
      size: 256,
      dataUrl: SAMPLE_PNG_DATA_URL
    });

    const parsed = parsePlainTextPrompts('Prompt requiring reference');
    const { batch } = await createBatchWithTasks({
      name: 'MissingRefBatch',
      platform: 'chatgpt',
      taskType: 'image',
      prompts: parsed.items,
      sharedReferenceIds: [ref.id]
    });

    // Delete the reference before starting the queue
    await deleteReference(ref.id);

    const adapter = new SimulatedPlatformAdapter();
    const res = await startBatchQueue(batch.id, adapter);

    expect(adapter.submittedPrompts).toHaveLength(0);
    expect(res.tasks[0].status).toBe('failed');
    expect(res.tasks[0].lastError?.code).toBe('REFERENCE_UPLOAD_FAILED');
  });

  it('validates corrupt and oversized reference images and allows editing prompts & shared prefixes', async () => {
    await expect(
      addReferenceImage({
        name: 'bad.txt',
        mimeType: 'text/plain',
        size: 100,
        dataUrl: 'data:text/plain;base64,SGVsbG8='
      })
    ).rejects.toThrow(ReferenceValidationError);

    await expect(
      addReferenceImage({
        name: 'huge.png',
        mimeType: 'image/png',
        size: 25 * 1024 * 1024,
        dataUrl: SAMPLE_PNG_DATA_URL
      })
    ).rejects.toThrow(ReferenceValidationError);

    const parsed = parsePlainTextPrompts('Initial prompt');
    const { batch, tasks } = await createBatchWithTasks({
      name: 'EditBatch',
      platform: 'chatgpt',
      taskType: 'image',
      prompts: parsed.items,
      globalPrefix: 'Prefix A',
      prefixEnabled: true
    });

    const editedTask = await updateTaskPromptAndSettings(tasks[0].id, {
      originalPrompt: 'Updated prompt'
    });
    expect(editedTask.finalPromptSnapshot).toBe('Prefix A\n\nUpdated prompt');

    const updatedPrefix = await updateBatchSharedPrefix(
      batch.id,
      'Prefix B',
      true
    );
    expect(updatedPrefix.tasks[0].finalPromptSnapshot).toBe(
      'Prefix B\n\nUpdated prompt'
    );
  });

  it('recovers safely after service-worker restart without duplicate submissions', async () => {
    const parsed = parsePlainTextPrompts('Task 1\nTask 2');
    const { batch, tasks } = await createBatchWithTasks({
      name: 'RecoveryBatch',
      platform: 'chatgpt',
      taskType: 'image',
      prompts: parsed.items
    });

    const adapter = new SimulatedPlatformAdapter();
    await startBatchQueue(batch.id, adapter);

    // Simulate service worker waking up while Task 1 is still actively generating on the page
    adapter.nextStatusByTask.set(tasks[0].id, {
      state: 'active',
      detectedAssets: []
    });

    const recoveredActive = await recoverQueueAfterRestart(batch.id, adapter);
    expect(recoveredActive.tasks[0].status).toBe('generating');
    expect(adapter.submittedPrompts).toHaveLength(1);

    // Simulate service worker waking up when platform state is unknown/uncertain
    adapter.nextStatusByTask.set(tasks[0].id, {
      state: 'unknown',
      detectedAssets: []
    });
    const recoveredUncertain = await recoverQueueAfterRestart(batch.id, adapter);
    expect(recoveredUncertain.tasks[0].status).toBe('needs_attention');
    expect(recoveredUncertain.tasks[0].lastError?.code).toBe(
      'DUPLICATE_SUBMISSION_RISK'
    );
  });

  it('circuit breaker automatically pauses batch queue after consecutive task failures', async () => {
    const parsed = parsePlainTextPrompts('Task 1\nTask 2\nTask 3');
    const { batch } = await createBatchWithTasks({
      name: 'CircuitBreakerBatch',
      platform: 'chatgpt',
      taskType: 'image',
      prompts: parsed.items,
      circuitBreakerLimit: 2
    });

    const adapter = new SimulatedPlatformAdapter();
    // Task 1 will fail submission
    adapter.failSubmissionForTaskIds.add('task_' + batch.id + '_1');
    // Task 2 will be actively generating
    adapter.nextStatusByTask.set('task_' + batch.id + '_2', {
      state: 'active',
      detectedAssets: []
    });

    // Run queue step 1 -> Task 1 fails, engine advances to Task 2 which enters generating
    const step1 = await stepBatchQueue(batch.id, adapter);
    expect(step1.batch.status).toBe('running');
    expect(step1.batch.consecutiveFailureCount).toBe(1);

    // Now Task 2 finishes with failure (state: 'mark_failed')
    adapter.nextStatusByTask.set('task_' + batch.id + '_2', {
      state: 'failed',
      detectedAssets: [],
      userMessage: 'Generation failed on platform'
    });

    // Run queue step 2 -> Task 2 fails -> consecutiveFailureCount reaches 2 (limit: 2) -> circuit breaker pauses queue!
    const step2 = await stepBatchQueue(batch.id, adapter);
    expect(step2.batch.status).toBe('paused');
    expect(step2.batch.consecutiveFailureCount).toBe(2);

    // Further stepBatchQueue calls should not start Task 3 while paused
    const step3 = await stepBatchQueue(batch.id, adapter);
    expect(step3.batch.status).toBe('paused');
    const remainingTasks = await getTasksByBatch(batch.id);
    expect(remainingTasks[2].status).toBe('pending');

    // Resuming resets failure counter
    const resumed = await resumeBatchQueue(batch.id, adapter);
    expect(resumed.batch.consecutiveFailureCount).toBe(0);
  });

  it('cleans up orphaned reference records and blobs via cleanupOrphanReferences', async () => {
    // Add reference 1 and reference 2
    const ref1 = await addReferenceImage({
      name: 'ref1.png',
      mimeType: 'image/png',
      size: 100,
      type: 'character',
      dataUrl: SAMPLE_PNG_DATA_URL
    });

    const ref2 = await addReferenceImage({
      name: 'ref2.png',
      mimeType: 'image/png',
      size: 100,
      type: 'art_style',
      dataUrl: SAMPLE_PNG_DATA_URL
    });

    const parsed = parsePlainTextPrompts('Prompt with ref 1');
    const { batch } = await createBatchWithTasks({
      name: 'RefBatch',
      platform: 'chatgpt',
      taskType: 'image',
      prompts: parsed.items,
      sharedReferenceIds: [ref1.id] // Only ref1 is linked! ref2 is orphaned immediately
    });

    // Run garbage collection
    const gc1 = await cleanupOrphanReferences();
    expect(gc1.purgedReferencesCount).toBe(1); // ref2 was purged

    const remainingRefs = await getAllReferences();
    expect(remainingRefs.map((r) => r.id)).toContain(ref1.id);
    expect(remainingRefs.map((r) => r.id)).not.toContain(ref2.id);

    // Now delete the batch cascadingly -> ref1 also becomes orphaned and purged
    await deleteBatchCascade(batch.id);
    const finalRefs = await getAllReferences();
    expect(finalRefs).toHaveLength(0);
  });
});
