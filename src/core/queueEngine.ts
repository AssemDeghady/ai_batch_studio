import {
  AdapterStatusInspection,
  PlatformAdapter
} from '../adapters/types';
import {
  processTaskOutputsDownload,
  retryTaskDownloadsOnly
} from '../downloads/downloadManager';
import {
  appendDiagnosticLog,
  getBatch,
  getOutputsByTask,
  getTask,
  getTasksByBatch,
  saveBatch,
  saveTask,
  saveTasksBulk
} from '../storage/db';
import { getPreferences, setActiveBatchId } from '../storage/preferences';
import {
  BatchRecord,
  DownloadSettings,
  FLOW_MODEL_CAPABILITIES,
  GenerationSettings,
  PlatformId,
  TaskErrorInfo,
  TaskRecord,
  TaskType,
  TimeoutSettings
} from '../types/models';
import { composeFinalPrompt } from './prefixComposer';
import { ParsedPromptDraft } from './promptParser';
import {
  ReferenceValidationError,
  resolveTaskReferences
} from './referenceManager';
import {
  isActiveTaskStatus,
  transitionTaskRecord
} from './stateMachine';
import {
  computeInitialObservationDelayMs,
  computeMaxTimeoutMs,
  evaluateGenerationObservation
} from './timeoutPolicy';

export interface CreateBatchInput {
  name: string;
  platform: PlatformId;
  taskType: TaskType;
  prompts: ParsedPromptDraft[];
  globalPrefix?: string;
  prefixEnabled?: boolean;
  prefixSeparator?: string;
  sharedReferenceIds?: string[];
  taskReferenceIdsMap?: Record<number, string[]>;
  defaultGenerationSettings?: GenerationSettings;
  downloadSettings?: DownloadSettings;
  timeoutSettings?: TimeoutSettings;
  targetTabId?: number;
  circuitBreakerLimit?: number;
  maxConcurrency?: number;
}

/**
 * Validates whether the requested Google Flow generation settings are supported by the selected model.
 */
export function validateFlowCapabilities(
  taskType: TaskType,
  settings: GenerationSettings
): { valid: boolean; reason?: string } {
  // If model is omitted, Google Flow inherits the user's active session model
  if (!settings.model) {
    return { valid: true };
  }

  if (taskType === 'image') {
    const modelId = settings.model || 'imagen_3';
    const cap = FLOW_MODEL_CAPABILITIES[modelId];
    if (!cap || cap.taskType !== 'image') {
      return {
        valid: false,
        reason: `Model "${modelId}" is not an image generation model.`
      };
    }
    if (
      settings.aspectRatio &&
      !cap.supportedAspectRatios.includes(settings.aspectRatio)
    ) {
      return {
        valid: false,
        reason: `Aspect ratio "${settings.aspectRatio}" is not supported by ${cap.label}.`
      };
    }
    return { valid: true };
  }

  // Video task validation
  const modelId = settings.model || 'veo_2';
  const cap = FLOW_MODEL_CAPABILITIES[modelId];
  if (!cap || cap.taskType !== 'video') {
    return {
      valid: false,
      reason: `Model "${modelId}" does not support video generation.`
    };
  }
  const mode = settings.videoMode || 'text_to_video';
  if (!cap.supportedVideoModes.includes(mode)) {
    return {
      valid: false,
      reason: `Video mode "${mode.replace(/_/g, ' ')}" is not supported by ${cap.label}. Supported modes: ${cap.supportedVideoModes.join(', ')}.`
    };
  }
  if (
    settings.aspectRatio &&
    !cap.supportedAspectRatios.includes(settings.aspectRatio)
  ) {
    return {
      valid: false,
      reason: `Aspect ratio "${settings.aspectRatio}" is not supported by ${cap.label}.`
    };
  }
  if (
    settings.durationSec &&
    !cap.supportedDurations.includes(settings.durationSec)
  ) {
    return {
      valid: false,
      reason: `Duration ${settings.durationSec}s is not supported by ${cap.label} (supported: ${cap.supportedDurations.join('s, ')}s).`
    };
  }
  if (
    settings.outputCount &&
    !cap.supportedOutputCounts.includes(settings.outputCount)
  ) {
    return {
      valid: false,
      reason: `Output count ${settings.outputCount} is not supported by ${cap.label}.`
    };
  }
  return { valid: true };
}

export async function createBatchWithTasks(
  input: CreateBatchInput
): Promise<{ batch: BatchRecord; tasks: TaskRecord[] }> {
  const prefs = await getPreferences();
  const now = Date.now();
  const batchId = `batch_${now}_${Math.random().toString(36).slice(2, 8)}`;

  const downloadSettings: DownloadSettings = input.downloadSettings
    ? structuredClone(input.downloadSettings)
    : structuredClone(prefs.downloadPreferences);

  const timeoutSettings: TimeoutSettings = input.timeoutSettings
    ? structuredClone(input.timeoutSettings)
    : structuredClone(prefs.timeoutSettings);

  const defaultGenSettings: GenerationSettings = {
    ...structuredClone(prefs.defaultGenerationSettings),
    ...(input.defaultGenerationSettings || {})
  };

  if (input.platform === 'google_flow') {
    // Model selection is omitted for Google Flow to respect the user's active workspace session
    if (!input.defaultGenerationSettings?.model) {
      delete defaultGenSettings.model;
    }
  }

  const globalPrefix = input.globalPrefix ?? prefs.sharedPrefix;
  const prefixEnabled = input.prefixEnabled ?? prefs.prefixEnabled;
  const prefixSeparator = input.prefixSeparator ?? prefs.prefixSeparator ?? '\n\n';
  const sharedReferenceIds = [...(input.sharedReferenceIds || [])];

  const tasks: TaskRecord[] = [];
  const taskIds: string[] = [];

  for (let i = 0; i < input.prompts.length; i++) {
    const draft = input.prompts[i];
    const seq = i + 1;
    const taskId = `task_${batchId}_${seq}`;
    const mergedGenSettings: GenerationSettings = {
      ...defaultGenSettings,
      ...(draft.generationSettings || {})
    };

    const finalPromptSnapshot = composeFinalPrompt({
      originalPrompt: draft.prompt,
      globalPrefix,
      prefixEnabled,
      separator: prefixSeparator,
      taskSettings: mergedGenSettings
    });

    const specificRefs = input.taskReferenceIdsMap?.[i] || [];

    const task: TaskRecord = {
      id: taskId,
      batchId,
      sequenceNumber: seq,
      name: draft.name,
      originalPrompt: draft.prompt,
      finalPromptSnapshot,
      platform: input.platform,
      taskType: input.taskType,
      status: 'pending',
      friendlyStatus: 'Ready to start.',
      referenceIds: [...specificRefs],
      generationSettings: mergedGenSettings,
      createdAt: now + i,
      updatedAt: now + i,
      retryCount: 0,
      outputIds: []
    };

    tasks.push(task);
    taskIds.push(taskId);
  }

  const startNum = downloadSettings.autoNumbering.startNumber || 1;

  const batch: BatchRecord = {
    id: batchId,
    name: input.name.trim() || `Batch ${new Date(now).toLocaleDateString()}`,
    platform: input.platform,
    taskType: input.taskType,
    status: 'ready',
    globalPrefix,
    prefixEnabled,
    prefixSeparator,
    referenceIds: sharedReferenceIds,
    taskIds,
    defaultGenerationSettings: defaultGenSettings,
    downloadSettings,
    timeoutSettings,
    targetTabId: input.targetTabId,
    nextOutputSequenceNumber: startNum,
    circuitBreakerLimit: input.circuitBreakerLimit ?? prefs.circuitBreakerLimit ?? 3,
    consecutiveFailureCount: 0,
    maxConcurrency: input.maxConcurrency ?? prefs.maxConcurrency ?? 1,
    createdAt: now,
    updatedAt: now
  };

  await saveBatch(batch);
  await saveTasksBulk(tasks);
  await setActiveBatchId(batch.id);

  await appendDiagnosticLog({
    level: 'info',
    scope: 'queue',
    batchId: batch.id,
    message: `Created batch "${batch.name}" with ${tasks.length} tasks (${batch.platform} / ${batch.taskType}).`
  });

  return { batch, tasks };
}

/**
 * Updates an individual task's prompt, references, or settings while preserving its identity and recomputing its finalPromptSnapshot.
 */
export async function updateTaskPromptAndSettings(
  taskId: string,
  updates: {
    originalPrompt?: string;
    name?: string;
    referenceIds?: string[];
    generationSettings?: Partial<GenerationSettings>;
  }
): Promise<TaskRecord> {
  const task = await getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found.`);
  const batch = await getBatch(task.batchId);
  if (!batch) throw new Error(`Batch ${task.batchId} not found.`);

  const nextOriginalPrompt =
    updates.originalPrompt !== undefined ? updates.originalPrompt.trim() : task.originalPrompt;
  const nextSettings: GenerationSettings = {
    ...task.generationSettings,
    ...(updates.generationSettings || {})
  };

  const finalPromptSnapshot = composeFinalPrompt({
    originalPrompt: nextOriginalPrompt,
    globalPrefix: batch.globalPrefix,
    prefixEnabled: batch.prefixEnabled,
    separator: batch.prefixSeparator,
    taskSettings: nextSettings
  });

  const updated: TaskRecord = {
    ...task,
    name: updates.name !== undefined ? updates.name : task.name,
    originalPrompt: nextOriginalPrompt,
    finalPromptSnapshot,
    referenceIds: updates.referenceIds ? [...updates.referenceIds] : task.referenceIds,
    generationSettings: nextSettings,
    updatedAt: Date.now()
  };

  await saveTask(updated);
  return updated;
}

/**
 * Updates the batch's shared prefix and refreshes `finalPromptSnapshot` for all non-completed tasks
 * from their preserved `originalPrompt` (never double-prepending).
 */
export async function updateBatchSharedPrefix(
  batchId: string,
  globalPrefix: string,
  prefixEnabled: boolean,
  prefixSeparator = '\n\n'
): Promise<{ batch: BatchRecord; tasks: TaskRecord[] }> {
  const batch = await getBatch(batchId);
  if (!batch) throw new Error(`Batch ${batchId} not found.`);
  const tasks = await getTasksByBatch(batchId);

  const updatedBatch: BatchRecord = {
    ...batch,
    globalPrefix,
    prefixEnabled,
    prefixSeparator,
    updatedAt: Date.now()
  };
  await saveBatch(updatedBatch);

  const updatedTasks: TaskRecord[] = tasks.map((t) => {
    if (t.status === 'completed') return t;
    return {
      ...t,
      finalPromptSnapshot: composeFinalPrompt({
        originalPrompt: t.originalPrompt,
        globalPrefix,
        prefixEnabled,
        separator: prefixSeparator,
        taskSettings: t.generationSettings
      }),
      updatedAt: Date.now()
    };
  });

  await saveTasksBulk(updatedTasks);
  return { batch: updatedBatch, tasks: updatedTasks };
}

/**
 * Reorders pending tasks within a batch and updates their sequenceNumbers cleanly.
 */
export async function reorderBatchTasks(
  batchId: string,
  fromIndex: number,
  toIndex: number
): Promise<TaskRecord[]> {
  const batch = await getBatch(batchId);
  if (!batch) throw new Error(`Batch ${batchId} not found.`);
  const tasks = await getTasksByBatch(batchId);

  if (
    fromIndex < 0 ||
    fromIndex >= tasks.length ||
    toIndex < 0 ||
    toIndex >= tasks.length ||
    fromIndex === toIndex
  ) {
    return tasks;
  }

  const reordered = [...tasks];
  const [moved] = reordered.splice(fromIndex, 1);
  reordered.splice(toIndex, 0, moved);

  const now = Date.now();
  const updatedTasks = reordered.map((t, idx) => ({
    ...t,
    sequenceNumber: idx + 1,
    updatedAt: now
  }));

  const updatedBatch: BatchRecord = {
    ...batch,
    taskIds: updatedTasks.map((t) => t.id),
    updatedAt: now
  };

  await saveBatch(updatedBatch);
  await saveTasksBulk(updatedTasks);
  return updatedTasks;
}

/**
 * Starts or continues a batch queue.
 */
export async function startBatchQueue(
  batchId: string,
  adapter: PlatformAdapter,
  randomFn?: () => number
): Promise<{ batch: BatchRecord; tasks: TaskRecord[] }> {
  const batch = await getBatch(batchId);
  if (!batch) throw new Error(`Batch ${batchId} not found.`);

  const updatedBatch: BatchRecord = {
    ...batch,
    status: 'running',
    consecutiveFailureCount: 0,
    updatedAt: Date.now()
  };
  await saveBatch(updatedBatch);
  await setActiveBatchId(batchId);

  return stepBatchQueue(batchId, adapter, randomFn);
}

/**
 * Pauses the batch queue safely:
 * - Stops starting new tasks.
 * - Persists the queue state.
 * - Preserves completed results and pending tasks.
 * - If a task has already been submitted (`generating`), keeps its `generating` state or records pause timestamp
 *   so we never falsely claim an in-flight website generation was cancelled, and suspends timeout countdowns.
 */
export async function pauseBatchQueue(
  batchId: string,
  now = Date.now()
): Promise<{ batch: BatchRecord; tasks: TaskRecord[] }> {
  const batch = await getBatch(batchId);
  if (!batch) throw new Error(`Batch ${batchId} not found.`);
  const tasks = await getTasksByBatch(batchId);

  const updatedTasks: TaskRecord[] = [];
  for (const task of tasks) {
    if (task.status === 'preparing') {
      const pausedTask = transitionTaskRecord(task, 'paused', {
        friendlyStatus: 'Queue paused.',
        now
      });
      await saveTask(pausedTask);
      updatedTasks.push(pausedTask);
    } else if (task.status === 'generating') {
      // Suspend timeout countdown by recording elapsed time at pause
      const elapsed = task.submittedAt ? Math.max(0, now - task.submittedAt) : 0;
      const pausedGenTask: TaskRecord = {
        ...task,
        pausedElapsedMs: elapsed,
        friendlyStatus: 'Queue paused (generation in progress on website).',
        updatedAt: now
      };
      await saveTask(pausedGenTask);
      updatedTasks.push(pausedGenTask);
    } else {
      updatedTasks.push(task);
    }
  }

  const updatedBatch: BatchRecord = {
    ...batch,
    status: 'paused',
    updatedAt: now
  };
  await saveBatch(updatedBatch);

  await appendDiagnosticLog({
    level: 'info',
    scope: 'queue',
    batchId,
    message: 'Queue paused by user.'
  });

  return { batch: updatedBatch, tasks: updatedTasks };
}

/**
 * Resumes a paused or stopped batch queue:
 * - Verifies current website and task state.
 * - Avoids resubmitting a task that is already generating or has finished generating while paused.
 * - Restores suspended timeout countdowns.
 */
export async function resumeBatchQueue(
  batchId: string,
  adapter: PlatformAdapter,
  now = Date.now(),
  randomFn?: () => number
): Promise<{ batch: BatchRecord; tasks: TaskRecord[] }> {
  const batch = await getBatch(batchId);
  if (!batch) throw new Error(`Batch ${batchId} not found.`);
  const tasks = await getTasksByBatch(batchId);

  for (const task of tasks) {
    if (task.status === 'paused') {
      const restored = transitionTaskRecord(task, 'pending', {
        friendlyStatus: 'Ready to start.',
        now
      });
      await saveTask(restored);
    } else if (task.status === 'generating' && task.pausedElapsedMs !== undefined) {
      // Restore timeout countdown relative to `now`
      const maxTimeoutMs = computeMaxTimeoutMs(task.taskType, batch.timeoutSettings);
      const remainingMs = Math.max(10000, maxTimeoutMs - task.pausedElapsedMs);
      const restoredGen: TaskRecord = {
        ...task,
        timeoutAt: now + remainingMs,
        pausedElapsedMs: undefined,
        friendlyStatus: 'Generation is still in progress.',
        updatedAt: now
      };
      await saveTask(restoredGen);
    }
  }

  const runningBatch: BatchRecord = {
    ...batch,
    status: 'running',
    consecutiveFailureCount: 0,
    updatedAt: now
  };
  await saveBatch(runningBatch);

  await appendDiagnosticLog({
    level: 'info',
    scope: 'queue',
    batchId,
    message: 'Queue resumed.'
  });

  return stepBatchQueue(batchId, adapter, randomFn, now);
}

/**
 * Stops the batch queue:
 * - Prevents any additional tasks from starting.
 * - Preserves the queue and task records so the user can inspect or resume later.
 */
export async function stopBatchQueue(
  batchId: string,
  now = Date.now()
): Promise<{ batch: BatchRecord; tasks: TaskRecord[] }> {
  const batch = await getBatch(batchId);
  if (!batch) throw new Error(`Batch ${batchId} not found.`);
  const tasks = await getTasksByBatch(batchId);

  const updatedTasks: TaskRecord[] = [];
  for (const task of tasks) {
    if (task.status === 'preparing') {
      const pausedTask = transitionTaskRecord(task, 'paused', {
        friendlyStatus: 'Queue paused.',
        now
      });
      await saveTask(pausedTask);
      updatedTasks.push(pausedTask);
    } else {
      updatedTasks.push(task);
    }
  }

  const stoppedBatch: BatchRecord = {
    ...batch,
    status: 'stopped',
    activeTaskId: undefined,
    updatedAt: now
  };
  await saveBatch(stoppedBatch);

  await appendDiagnosticLog({
    level: 'info',
    scope: 'queue',
    batchId,
    message: 'Queue stopped by user. Pending tasks preserved.'
  });

  return { batch: stoppedBatch, tasks: updatedTasks };
}

/**
 * Marks a single task as skipped so the sequential queue can move past it.
 */
export async function skipTask(
  taskId: string,
  now = Date.now()
): Promise<TaskRecord> {
  const task = await getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found.`);
  if (task.status === 'completed') {
    return task;
  }
  const skipped = transitionTaskRecord(task, 'skipped', {
    friendlyStatus: 'Task skipped.',
    now
  });
  await saveTask(skipped);
  return skipped;
}

/**
 * Resets a single failed or needs_attention task for retry:
 * - Never reruns a `completed` task.
 * - Recomputes `finalPromptSnapshot` from `originalPrompt` so the global prefix is never prepended twice.
 * - Preserves `sequenceNumber`, `referenceIds`, `generationSettings`, and `taskType`.
 */
export async function prepareTaskForRetry(
  taskId: string,
  now = Date.now()
): Promise<TaskRecord> {
  const task = await getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found.`);
  if (task.status === 'completed') {
    return task; // Never rerun completed tasks
  }

  const batch = await getBatch(task.batchId);
  if (!batch) throw new Error(`Batch ${task.batchId} not found.`);

  const finalPromptSnapshot = composeFinalPrompt({
    originalPrompt: task.originalPrompt,
    globalPrefix: batch.globalPrefix,
    prefixEnabled: batch.prefixEnabled,
    separator: batch.prefixSeparator,
    taskSettings: task.generationSettings
  });

  const retried = transitionTaskRecord(task, 'pending', {
    friendlyStatus: 'Ready to start.',
    now
  });

  const updated: TaskRecord = {
    ...retried,
    finalPromptSnapshot,
    retryCount: task.retryCount + 1,
    submittedAt: undefined,
    timeoutAt: undefined,
    initialObservationUntil: undefined,
    pausedElapsedMs: undefined,
    lastError: undefined,
    updatedAt: now
  };

  await saveTask(updated);
  return updated;
}

/**
 * Retries a single failed task and steps the queue if the batch is running or ready.
 */
export async function retrySingleFailedTask(
  taskId: string,
  adapter?: PlatformAdapter
): Promise<TaskRecord> {
  const task = await prepareTaskForRetry(taskId);
  if (adapter) {
    const batch = await getBatch(task.batchId);
    if (batch && batch.status !== 'running') {
      await saveBatch({ ...batch, status: 'running', updatedAt: Date.now() });
    }
    await stepBatchQueue(task.batchId, adapter);
    return (await getTask(taskId)) || task;
  }
  return task;
}

/**
 * Retries a specific selection of failed tasks without touching completed tasks.
 */
export async function retrySelectedFailedTasks(
  batchId: string,
  selectedTaskIds: string[],
  adapter?: PlatformAdapter
): Promise<TaskRecord[]> {
  const selectedSet = new Set(selectedTaskIds);
  const tasks = await getTasksByBatch(batchId);
  const updated: TaskRecord[] = [];

  for (const t of tasks) {
    if (
      selectedSet.has(t.id) &&
      (t.status === 'failed' ||
        t.status === 'needs_attention' ||
        t.status === 'download_failed')
    ) {
      if (t.status === 'download_failed' && adapter) {
        const dlRetried = await retryTaskDownloadsOnly(t.id, adapter);
        updated.push(dlRetried);
      } else {
        const genRetried = await prepareTaskForRetry(t.id);
        updated.push(genRetried);
      }
    } else {
      updated.push(t);
    }
  }

  if (adapter) {
    const batch = await getBatch(batchId);
    if (batch && updated.some((t) => t.status === 'pending')) {
      await saveBatch({ ...batch, status: 'running', updatedAt: Date.now() });
      await stepBatchQueue(batchId, adapter);
    }
  }

  return getTasksByBatch(batchId);
}

/**
 * Re-adds all failed tasks in a batch to the queue while strictly preserving completed tasks.
 */
export async function retryAllFailedTasks(
  batchId: string,
  adapter?: PlatformAdapter
): Promise<TaskRecord[]> {
  const tasks = await getTasksByBatch(batchId);
  const failedIds = tasks
    .filter((t) => t.status === 'failed' || t.status === 'needs_attention')
    .map((t) => t.id);
  return retrySelectedFailedTasks(batchId, failedIds, adapter);
}

/**
 * Recovers queue state after service-worker suspension or browser restart:
 * - Inspects any task that was in an active state (`preparing`, `submitting`, `generating`, `downloading`).
 * - Never blindly resubmits a task in `submitting` or `generating` without first checking `adapter.recoverTask(task)`.
 */
export async function recoverQueueAfterRestart(
  batchId: string,
  adapter: PlatformAdapter,
  now = Date.now()
): Promise<{ batch: BatchRecord; tasks: TaskRecord[] }> {
  const batch = await getBatch(batchId);
  if (!batch) throw new Error(`Batch ${batchId} not found.`);
  const tasks = await getTasksByBatch(batchId);

  for (const task of tasks) {
    if (task.status === 'preparing') {
      // Never submitted yet; safe to return to pending
      const resetTask = transitionTaskRecord(task, 'paused', {
        friendlyStatus: 'Queue paused.',
        now
      });
      const backToPending = transitionTaskRecord(resetTask, 'pending', {
        friendlyStatus: 'Ready to start.',
        now
      });
      await saveTask(backToPending);
    } else if (task.status === 'submitting' || task.status === 'generating') {
      // Check actual observable state on the website before deciding!
      const inspection = await adapter.recoverTask(task);
      if (inspection.state === 'completed' && inspection.detectedAssets.length > 0) {
        await processTaskOutputsDownload({
          batch,
          task,
          assets: inspection.detectedAssets,
          adapter
        });
      } else if (inspection.state === 'active') {
        const genTask =
          task.status === 'generating'
            ? {
                ...task,
                friendlyStatus: 'Generation is still in progress.',
                updatedAt: now
              }
            : transitionTaskRecord(task, 'generating', {
                friendlyStatus: 'Generation is still in progress.',
                now
              });
        await saveTask(genTask);
      } else {
        // State is uncertain after restart: mark `needs_attention` to prevent duplicate submission
        const uncertainTask = transitionTaskRecord(task, 'needs_attention', {
          friendlyStatus: 'Generation took longer than expected.',
          now
        });
        uncertainTask.lastError = {
          code: 'DUPLICATE_SUBMISSION_RISK',
          userMessage:
            'The extension restarted while this task was being submitted or generated.',
          recommendedAction:
            'Check the website tab to see if the output already exists before clicking Retry.',
          retryableGeneration: true,
          retryableDownload: false,
          diagnostics: inspection.diagnostics,
          occurredAt: now
        };
        await saveTask(uncertainTask);
      }
    } else if (task.status === 'downloading') {
      const existingOutputs = await getOutputsByTask(task.id);
      if (existingOutputs.some((o) => o.status !== 'completed')) {
        await retryTaskDownloadsOnly(task.id, adapter);
      }
    }
  }

  return {
    batch: (await getBatch(batchId)) || batch,
    tasks: await getTasksByBatch(batchId)
  };
}

async function recordTaskSuccess(batch: BatchRecord): Promise<BatchRecord> {
  if (batch.consecutiveFailureCount && batch.consecutiveFailureCount > 0) {
    batch = {
      ...batch,
      consecutiveFailureCount: 0,
      updatedAt: Date.now()
    };
    await saveBatch(batch);
  }
  return batch;
}

async function recordTaskFailure(
  batch: BatchRecord,
  now: number
): Promise<{ batch: BatchRecord; tripped: boolean }> {
  const nextCount = (batch.consecutiveFailureCount || 0) + 1;
  const limit = batch.circuitBreakerLimit ?? 3;
  if (nextCount >= limit) {
    batch = {
      ...batch,
      consecutiveFailureCount: nextCount,
      status: 'paused',
      updatedAt: now
    };
    await saveBatch(batch);
    await appendDiagnosticLog({
      level: 'warn',
      scope: 'queue',
      batchId: batch.id,
      message: `Circuit breaker tripped: ${nextCount} consecutive tasks failed. Queue paused automatically to protect credits.`
    });
    return { batch, tripped: true };
  } else {
    batch = {
      ...batch,
      consecutiveFailureCount: nextCount,
      updatedAt: now
    };
    await saveBatch(batch);
    return { batch, tripped: false };
  }
}

/**
 * Core sequential / concurrent queue execution step.
 * - Supports configurable concurrency (`maxConcurrency`: 1 or 2).
 * - Allows multiple tasks to generate concurrently while serializing composer input.
 * - Enforces circuit breaker pausing if consecutive failures reach `circuitBreakerLimit`.
 * - Stops immediately if a task enters `needs_attention` or if the platform requires login/verification.
 */
export async function stepBatchQueue(
  batchId: string,
  adapter: PlatformAdapter,
  randomFn?: () => number,
  now = Date.now()
): Promise<{ batch: BatchRecord; tasks: TaskRecord[] }> {
  let batch = await getBatch(batchId);
  if (!batch) throw new Error(`Batch ${batchId} not found.`);

  if (batch.status === 'paused' || batch.status === 'stopped') {
    return { batch, tasks: await getTasksByBatch(batchId) };
  }

  let tasks = await getTasksByBatch(batchId);

  // 1. Process active tasks that are currently generating
  const generatingTasks = tasks.filter((t) => t.status === 'generating');
  for (const activeTask of generatingTasks) {
    const inspection: AdapterStatusInspection = await adapter.getTaskStatus(activeTask);
    const evalResult = evaluateGenerationObservation({
      task: activeTask,
      settings: batch.timeoutSettings,
      observableState: inspection.state,
      now,
      errorMessage: inspection.userMessage
    });

    if (evalResult.decision === 'wait_initial_window' || evalResult.decision === 'continue_generating') {
      const updatedTask: TaskRecord = {
        ...activeTask,
        friendlyStatus: evalResult.friendlyStatus,
        updatedAt: now
      };
      await saveTask(updatedTask);
      continue;
    }

    if (evalResult.decision === 'proceed_to_download') {
      const assets =
        inspection.detectedAssets.length > 0
          ? inspection.detectedAssets
          : await adapter.getResults(activeTask);

      if (assets.length === 0) {
        const noResultTask = transitionTaskRecord(activeTask, 'failed', {
          friendlyStatus: 'Failed task ready to retry.',
          now
        });
        noResultTask.lastError = {
          code: 'RESULT_NOT_IDENTIFIED',
          userMessage: 'Generation finished, but the output asset could not be identified on the page.',
          recommendedAction: 'Inspect the website tab or retry the task.',
          retryableGeneration: true,
          retryableDownload: true,
          occurredAt: now
        };
        await saveTask(noResultTask);
        const failRes = await recordTaskFailure(batch, now);
        if (failRes.tripped) {
          return { batch: failRes.batch, tasks: await getTasksByBatch(batchId) };
        }
        batch = failRes.batch;
      } else {
        const detectedTask = transitionTaskRecord(activeTask, 'result_detected', {
          friendlyStatus: `Detected ${assets.length} generated output(s).`,
          now
        });
        await saveTask(detectedTask);

        await processTaskOutputsDownload({
          batch,
          task: detectedTask,
          assets,
          adapter
        });

        const postTask = await getTask(detectedTask.id);
        if (postTask?.status === 'completed') {
          batch = await recordTaskSuccess(batch);
        } else if (postTask?.status === 'download_failed' || postTask?.status === 'failed') {
          const failRes = await recordTaskFailure(batch, now);
          if (failRes.tripped) {
            return { batch: failRes.batch, tasks: await getTasksByBatch(batchId) };
          }
          batch = failRes.batch;
        }
      }
      return stepBatchQueue(batchId, adapter, randomFn, Date.now());
    }

    if (evalResult.decision === 'auto_retry') {
      await prepareTaskForRetry(activeTask.id, now);
      return stepBatchQueue(batchId, adapter, randomFn, Date.now());
    }

    if (evalResult.decision === 'needs_attention') {
      const attnTask = transitionTaskRecord(activeTask, 'needs_attention', {
        friendlyStatus: evalResult.friendlyStatus,
        now
      });
      attnTask.lastError = {
        code: inspection.errorCode || 'GENERATION_TIMEOUT',
        userMessage:
          evalResult.reason ||
          'Generation took longer than expected and its status is uncertain.',
        recommendedAction:
          'Inspect the website tab. If generation completed, download it; if it stopped, click Retry.',
        retryableGeneration: true,
        retryableDownload: true,
        diagnostics: inspection.diagnostics,
        occurredAt: now
      };
      await saveTask(attnTask);
      batch = {
        ...batch,
        status: 'needs_attention',
        activeTaskId: attnTask.id,
        updatedAt: now
      };
      await saveBatch(batch);
      return { batch, tasks: await getTasksByBatch(batchId) };
    }

    // evalResult.decision === 'mark_failed'
    const failedTask = transitionTaskRecord(activeTask, 'failed', {
      friendlyStatus: 'Failed task ready to retry.',
      now
    });
    failedTask.lastError = {
      code: inspection.errorCode || 'GENERATION_FAILED',
      userMessage: evalResult.reason || inspection.userMessage || 'Generation failed.',
      recommendedAction:
        inspection.recommendedAction || 'Review the prompt or platform status and click Retry.',
      retryableGeneration: true,
      retryableDownload: false,
      diagnostics: inspection.diagnostics,
      occurredAt: now
    };
    await saveTask(failedTask);
    const failRes = await recordTaskFailure(batch, now);
    if (failRes.tripped) {
      return { batch: failRes.batch, tasks: await getTasksByBatch(batchId) };
    }
    batch = failRes.batch;
    return stepBatchQueue(batchId, adapter, randomFn, Date.now());
  }

  // Re-fetch current tasks after inspecting generating tasks
  tasks = await getTasksByBatch(batchId);
  const currentActiveTasks = tasks.filter((t) => isActiveTaskStatus(t.status));

  // Check if active tasks reached concurrency limit or if composer is busy
  const maxConcurrency = Math.max(1, batch.maxConcurrency || 1);
  const isComposerBusy = currentActiveTasks.some(
    (t) => t.status === 'preparing' || t.status === 'submitting' || t.status === 'downloading'
  );
  if (currentActiveTasks.length >= maxConcurrency || isComposerBusy) {
    return { batch, tasks };
  }

  // 2. If any task is currently in `needs_attention`, pause progression until the user resolves or skips it
  const attentionTask = tasks.find((t) => t.status === 'needs_attention');
  if (attentionTask) {
    batch = {
      ...batch,
      status: 'needs_attention',
      activeTaskId: attentionTask.id,
      updatedAt: now
    };
    await saveBatch(batch);
    return { batch, tasks };
  }

  // 3. Find the next `pending` task in sequence order
  const nextPending = tasks.find((t) => t.status === 'pending');
  if (!nextPending) {
    if (currentActiveTasks.length === 0) {
      // All tasks have reached terminal states!
      batch = {
        ...batch,
        status: 'completed',
        activeTaskId: undefined,
        updatedAt: now
      };
      await saveBatch(batch);
      await appendDiagnosticLog({
        level: 'info',
        scope: 'queue',
        batchId: batch.id,
        message: 'Batch completed.'
      });
    }
    return { batch, tasks };
  }

  // 4. Start preparing `nextPending`
  batch = {
    ...batch,
    status: 'running',
    activeTaskId: nextPending.id,
    updatedAt: now
  };
  await saveBatch(batch);

  // Re-compose finalPromptSnapshot from preserved originalPrompt so retries never double-prepend
  const freshFinalPrompt = composeFinalPrompt({
    originalPrompt: nextPending.originalPrompt,
    globalPrefix: batch.globalPrefix,
    prefixEnabled: batch.prefixEnabled,
    separator: batch.prefixSeparator,
    taskSettings: nextPending.generationSettings
  });

  let currentTask = transitionTaskRecord(
    { ...nextPending, finalPromptSnapshot: freshFinalPrompt },
    'preparing',
    {
      friendlyStatus: 'Preparing prompt.',
      now
    }
  );
  await saveTask(currentTask);

  // Validate Google Flow model capabilities if applicable
  if (batch.platform === 'google_flow') {
    const capCheck = validateFlowCapabilities(
      currentTask.taskType,
      currentTask.generationSettings
    );
    if (!capCheck.valid) {
      const unsupportedTask = transitionTaskRecord(currentTask, 'failed', {
        friendlyStatus: 'Failed task ready to retry.',
        now
      });
      unsupportedTask.lastError = {
        code: 'UNSUPPORTED_VIDEO_MODE',
        userMessage: capCheck.reason || 'Requested generation mode is unavailable for the selected model.',
        recommendedAction: 'Update the task or batch model settings and click Retry.',
        retryableGeneration: true,
        retryableDownload: false,
        occurredAt: now
      };
      await saveTask(unsupportedTask);
      const failRes = await recordTaskFailure(batch, now);
      if (failRes.tripped) {
        return { batch: failRes.batch, tasks: await getTasksByBatch(batchId) };
      }
      batch = failRes.batch;
      return stepBatchQueue(batchId, adapter, randomFn, Date.now());
    }
  }

  // 5. Resolve and validate all shared + task-specific reference images BEFORE touching the website
  let resolvedReferences;
  try {
    resolvedReferences = await resolveTaskReferences(
      batch.referenceIds,
      currentTask.referenceIds
    );
  } catch (err) {
    const refErrMsg =
      err instanceof ReferenceValidationError
        ? err.message
        : 'Failed to load required reference image from local storage.';
    const failedRefTask = transitionTaskRecord(currentTask, 'failed', {
      friendlyStatus: 'Failed task ready to retry.',
      now
    });
    failedRefTask.lastError = {
      code: 'REFERENCE_UPLOAD_FAILED',
      userMessage: refErrMsg,
      recommendedAction:
        'Re-upload the missing reference image or remove it from the task, then click Retry.',
      retryableGeneration: true,
      retryableDownload: false,
      occurredAt: now
    };
    await saveTask(failedRefTask);
    const failRes = await recordTaskFailure(batch, now);
    if (failRes.tripped) {
      return { batch: failRes.batch, tasks: await getTasksByBatch(batchId) };
    }
    batch = failRes.batch;
    return stepBatchQueue(batchId, adapter, randomFn, Date.now());
  }

  // 6. Check platform availability (correct tab open, authenticated, no CAPTCHA/verification challenge, mode available)
  await adapter.initialize();
  const availability = await adapter.checkAvailability(
    currentTask.taskType,
    currentTask.generationSettings
  );

  if (!availability.available) {
    const errorCode = availability.errorCode || 'WEBSITE_UNAVAILABLE';
    const isBlockerForWholeQueue =
      errorCode === 'LOGIN_REQUIRED' ||
      errorCode === 'VERIFICATION_REQUIRED' ||
      errorCode === 'WRONG_PAGE' ||
      errorCode === 'WEBSITE_UNAVAILABLE' ||
      errorCode === 'PAGE_CLOSED_OR_NAVIGATED' ||
      errorCode === 'TAB_NOT_FOUND' ||
      errorCode === 'TAB_LOADING' ||
      errorCode === 'CONTENT_SCRIPT_NOT_READY' ||
      errorCode === 'FLOW_NOT_READY' ||
      errorCode === 'PERMISSION_ERROR' ||
      errorCode === 'COMMUNICATION_ERROR';

    if (isBlockerForWholeQueue) {
      const attnTask = transitionTaskRecord(currentTask, 'needs_attention', {
        friendlyStatus: availability.friendlyMessage || 'Platform temporarily unavailable.',
        now
      });
      attnTask.lastError = {
        code: errorCode,
        userMessage: availability.friendlyMessage,
        recommendedAction:
          availability.recommendedAction ||
          'Open the platform website, sign in if prompted, and press Resume.',
        retryableGeneration: true,
        retryableDownload: false,
        diagnostics: availability.diagnostics,
        occurredAt: now
      };
      await saveTask(attnTask);
      batch = {
        ...batch,
        status: 'needs_attention',
        activeTaskId: attnTask.id,
        updatedAt: now
      };
      await saveBatch(batch);
      return { batch, tasks: await getTasksByBatch(batchId) };
    }

    const failedTask = transitionTaskRecord(currentTask, 'failed', {
      friendlyStatus: 'Failed task ready to retry.',
      now
    });
    failedTask.lastError = {
      code: errorCode,
      userMessage: availability.friendlyMessage,
      recommendedAction:
        availability.recommendedAction || 'Adjust task settings and click Retry.',
      retryableGeneration: true,
      retryableDownload: false,
      diagnostics: availability.diagnostics,
      occurredAt: now
    };
    await saveTask(failedTask);
    const failRes = await recordTaskFailure(batch, now);
    if (failRes.tripped) {
      return { batch: failRes.batch, tasks: await getTasksByBatch(batchId) };
    }
    batch = failRes.batch;
    return stepBatchQueue(batchId, adapter, randomFn, Date.now());
  }

  // 7. Transition to `submitting`, attach references if any, and submit prompt
  currentTask = transitionTaskRecord(currentTask, 'submitting', {
    friendlyStatus: 'Submitting prompt.',
    now
  });
  await saveTask(currentTask);

  if (resolvedReferences.length > 0) {
    const attachRes = await adapter.attachReferences(currentTask, resolvedReferences);
    if (!attachRes.attached) {
      // Never silently submit a task without its required references!
      const failedAttachTask = transitionTaskRecord(currentTask, 'failed', {
        friendlyStatus: 'Failed task ready to retry.',
        now
      });
      failedAttachTask.lastError = {
        code: attachRes.errorCode || 'REFERENCE_UPLOAD_FAILED',
        userMessage:
          attachRes.userMessage ||
          'Could not attach the required reference image(s) on the website interface.',
        recommendedAction:
          'Verify that the current model supports image attachments on the open tab, then click Retry.',
        retryableGeneration: true,
        retryableDownload: false,
        diagnostics: attachRes.diagnostics,
        occurredAt: now
      };
      await saveTask(failedAttachTask);
      const failRes = await recordTaskFailure(batch, now);
      if (failRes.tripped) {
        return { batch: failRes.batch, tasks: await getTasksByBatch(batchId) };
      }
      batch = failRes.batch;
      return stepBatchQueue(batchId, adapter, randomFn, Date.now());
    }
  }

  const submitRes = await adapter.submitTask(currentTask, resolvedReferences);
  if (!submitRes.submitted) {
    const targetState =
      submitRes.errorCode === 'SUBMISSION_UNCERTAIN' ? 'needs_attention' : 'failed';
    const failedSubTask = transitionTaskRecord(currentTask, targetState, {
      friendlyStatus:
        targetState === 'needs_attention'
          ? 'Submission needs attention.'
          : 'Failed task ready to retry.',
      now
    });
    const errorInfo: TaskErrorInfo = {
      code: submitRes.errorCode || 'CONTROLS_NOT_FOUND',
      userMessage:
        submitRes.userMessage || 'Could not submit the prompt to the website.',
      recommendedAction:
        submitRes.recommendedAction ||
        'Inspect the website tab to check if the prompt was submitted before retrying.',
      retryableGeneration: true,
      retryableDownload: false,
      diagnostics: submitRes.diagnostics,
      occurredAt: now
    };
    failedSubTask.lastError = errorInfo;
    await saveTask(failedSubTask);

    await appendDiagnosticLog({
      level: targetState === 'needs_attention' ? 'warn' : 'error',
      scope: 'adapter',
      batchId: batch.id,
      taskId: failedSubTask.id,
      message: `Prompt submission ${targetState === 'needs_attention' ? 'uncertain' : 'failed'}: ${errorInfo.userMessage}`,
      details: submitRes.diagnostics
    });

    if (targetState === 'needs_attention') {
      batch = {
        ...batch,
        status: 'needs_attention',
        activeTaskId: failedSubTask.id,
        updatedAt: now
      };
      await saveBatch(batch);
      return { batch, tasks: await getTasksByBatch(batchId) };
    }
    const failRes = await recordTaskFailure(batch, now);
    if (failRes.tripped) {
      return { batch: failRes.batch, tasks: await getTasksByBatch(batchId) };
    }
    batch = failRes.batch;
    return stepBatchQueue(batchId, adapter, randomFn, Date.now());
  }

  // 8. Submission succeeded! Enter `generating` with initial 10-15s observation window + max timeout
  const initialDelayMs = computeInitialObservationDelayMs(
    batch.timeoutSettings,
    randomFn
  );
  const maxTimeoutMs = computeMaxTimeoutMs(
    currentTask.taskType,
    batch.timeoutSettings
  );

  const generatingTask = transitionTaskRecord(currentTask, 'generating', {
    friendlyStatus: 'Waiting for generation.',
    now
  });
  generatingTask.submittedAt = now;
  generatingTask.initialObservationUntil = now + initialDelayMs;
  generatingTask.timeoutAt = now + maxTimeoutMs;
  await saveTask(generatingTask);

  await appendDiagnosticLog({
    level: 'info',
    scope: 'queue',
    batchId: batch.id,
    taskId: generatingTask.id,
    message: `Submitted task #${generatingTask.sequenceNumber}. Initial observation window: ${(
      initialDelayMs / 1000
    ).toFixed(1)}s, max timeout: ${Math.round(maxTimeoutMs / 1000)}s.`
  });

  return { batch, tasks: await getTasksByBatch(batchId) };
}
