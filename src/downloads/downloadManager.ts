import {
  buildOutputFilename,
  formatRelativeDownloadPath,
  sanitizeSubfolderPath
} from '../core/fileNaming';
import {
  appendDiagnosticLog,
  getBatch,
  getOutput,
  getOutputByDownloadId,
  getOutputsByBatch,
  getOutputsByTask,
  getTask,
  saveBatch,
  saveOutput,
  saveTask
} from '../storage/db';
import { transitionTaskRecord } from '../core/stateMachine';
import {
  BatchRecord,
  OutputRecord,
  OutputStatus,
  TaskRecord
} from '../types/models';
import { DetectedPlatformAsset, PlatformAdapter } from '../adapters/types';

// Optional in-memory reference for an active File System Access API DirectoryHandle (when opened in full Studio tab)
let activeDirectoryHandle: FileSystemDirectoryHandle | null = null;

export function setCustomDirectoryHandle(handle: FileSystemDirectoryHandle | null): void {
  activeDirectoryHandle = handle;
}

export function getCustomDirectoryHandle(): FileSystemDirectoryHandle | null {
  return activeDirectoryHandle;
}

export async function verifyCustomDirectoryPermission(): Promise<{
  granted: boolean;
  directoryName?: string;
  reason?: string;
}> {
  if (!activeDirectoryHandle) {
    return {
      granted: false,
      reason: 'No custom directory handle is currently active in this session.'
    };
  }
  try {
    const anyHandle = activeDirectoryHandle as unknown as {
      name: string;
      queryPermission?: (desc: { mode: 'readwrite' }) => Promise<PermissionState>;
    };
    if (typeof anyHandle.queryPermission === 'function') {
      const state = await anyHandle.queryPermission({ mode: 'readwrite' });
      if (state !== 'granted') {
        return {
          granted: false,
          directoryName: activeDirectoryHandle.name,
          reason: 'Permission to write to the selected folder was revoked or requires re-approval.'
        };
      }
    }
    return { granted: true, directoryName: activeDirectoryHandle.name };
  } catch (err) {
    return {
      granted: false,
      reason: err instanceof Error ? err.message : 'Directory handle unavailable.'
    };
  }
}

// Pending filename override for native-button triggered downloads intercepted by chrome.downloads.onDeterminingFilename
interface PendingNativeDownloadExpectation {
  outputId: string;
  taskId: string;
  batchId: string;
  relativePath: string;
  expiresAt: number;
}

// Pending filename override for direct chrome.downloads.download calls so onDeterminingFilename
// always enforces our exact target filename and never lets Windows Chrome rename image/jpeg to .jfif
interface PendingDirectDownloadExpectation {
  downloadId?: number;
  url: string;
  relativePath: string;
  conflictAction: 'uniquify' | 'prompt';
  expiresAt: number;
}

let pendingNativeDownload: PendingNativeDownloadExpectation | null = null;
const pendingDirectDownloads: PendingDirectDownloadExpectation[] = [];

export function getPendingNativeDownload(): PendingNativeDownloadExpectation | null {
  if (pendingNativeDownload && Date.now() > pendingNativeDownload.expiresAt) {
    pendingNativeDownload = null;
  }
  return pendingNativeDownload;
}

export function clearPendingNativeDownload(): void {
  pendingNativeDownload = null;
}

export function consumePendingDirectDownload(
  downloadId?: number,
  url?: string,
  finalUrl?: string,
  byExtensionId?: string
): PendingDirectDownloadExpectation | null {
  const now = Date.now();
  for (let i = pendingDirectDownloads.length - 1; i >= 0; i--) {
    if (pendingDirectDownloads[i].expiresAt < now) {
      pendingDirectDownloads.splice(i, 1);
    }
  }

  let idx = pendingDirectDownloads.findIndex(
    (entry) =>
      (typeof downloadId === 'number' && entry.downloadId === downloadId) ||
      (Boolean(url) && entry.url === url) ||
      (Boolean(finalUrl) && entry.url === finalUrl)
  );

  if (
    idx < 0 &&
    pendingDirectDownloads.length > 0 &&
    byExtensionId &&
    typeof chrome !== 'undefined' &&
    chrome.runtime?.id &&
    byExtensionId === chrome.runtime.id
  ) {
    idx = 0;
  }

  if (idx >= 0) {
    const [matched] = pendingDirectDownloads.splice(idx, 1);
    return matched;
  }
  return null;
}

function hasChromeDownloadsApi(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.downloads && chrome.downloads.download);
}

function executeChromeDownloadCall(
  targetUrl: string,
  relativePath: string,
  conflictAction: 'uniquify' | 'prompt'
): Promise<{ downloadId: number; status: OutputStatus; error?: string }> {
  const expectation: PendingDirectDownloadExpectation = {
    url: targetUrl,
    relativePath,
    conflictAction,
    expiresAt: Date.now() + 30000
  };
  pendingDirectDownloads.push(expectation);

  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: targetUrl,
        filename: relativePath,
        conflictAction,
        saveAs: conflictAction === 'prompt'
      },
      (downloadId) => {
        const lastErr = chrome.runtime?.lastError;
        if (lastErr || typeof downloadId !== 'number') {
          const idx = pendingDirectDownloads.indexOf(expectation);
          if (idx >= 0) pendingDirectDownloads.splice(idx, 1);
          reject(new Error(lastErr?.message || 'chrome.downloads.download failed to start'));
          return;
        }

        expectation.downloadId = downloadId;

        // Query initial state in case data: or fast local download completed synchronously
        chrome.downloads.search({ id: downloadId }, (items) => {
          const item = items?.[0];
          if (!item) {
            resolve({ downloadId, status: 'in_progress' });
            return;
          }
          if (item.state === 'complete') {
            resolve({ downloadId, status: 'completed' });
          } else if (item.state === 'interrupted') {
            const isCancelled = item.error === 'USER_CANCELED' || item.error === 'USER_SHUTDOWN';
            resolve({
              downloadId,
              status: isCancelled ? 'cancelled' : 'interrupted',
              error: item.error || 'Download interrupted'
            });
          } else {
            resolve({ downloadId, status: 'in_progress' });
          }
        });
      }
    );
  });
}

/**
 * Initiates a Chrome download and waits for initial downloadId assignment + completion/interruption.
 */
async function triggerChromeDownload(
  url: string,
  relativePath: string,
  conflictAction: 'uniquify' | 'prompt' = 'uniquify'
): Promise<{ downloadId: number; status: OutputStatus; error?: string }> {
  if (!hasChromeDownloadsApi()) {
    throw new Error('Chrome Downloads API is unavailable in this environment.');
  }

  return await executeChromeDownloadCall(url, relativePath, conflictAction);
}

/**
 * Processes all detected output assets for a task that has completed generation,
 * creating or reusing OutputRecords, assigning sequential numbers deterministically,
 * starting downloads, and updating the task's state (`completed` vs `download_failed`).
 */
export async function processTaskOutputsDownload(params: {
  batch: BatchRecord;
  task: TaskRecord;
  assets: DetectedPlatformAsset[];
  adapter?: PlatformAdapter;
}): Promise<{
  task: TaskRecord;
  batch: BatchRecord;
  outputs: OutputRecord[];
  allSucceeded: boolean;
}> {
  const { batch, task, assets, adapter } = params;

  const existingBatchOutputs = await getOutputsByBatch(batch.id);
  const existingTaskOutputs = await getOutputsByTask(task.id);
  const existingFilenames = new Set<string>(
    existingBatchOutputs.map((o) => o.filename.toLowerCase())
  );

  let currentBatch = { ...batch };
  let currentTask =
    task.status === 'downloading'
      ? { ...task }
      : transitionTaskRecord(task, 'downloading', {
          friendlyStatus:
            task.taskType === 'video' ? 'Downloading video.' : 'Downloading image.'
        });
  await saveTask(currentTask);

  const processedOutputs: OutputRecord[] = [];

  for (const asset of assets) {
    // Deduplication check: if this task already has a completed output for this asset index, do not re-download
    let outputRecord = existingTaskOutputs.find((o) => o.index === asset.index);
    if (outputRecord && outputRecord.status === 'completed') {
      processedOutputs.push(outputRecord);
      continue;
    }

    // Assign sequence number once per output and persist across retries
    let assignedNumber = outputRecord?.assignedSequenceNumber;
    if (assignedNumber === undefined) {
      assignedNumber = currentBatch.nextOutputSequenceNumber;
      currentBatch = {
        ...currentBatch,
        nextOutputSequenceNumber: currentBatch.nextOutputSequenceNumber + 1,
        updatedAt: Date.now()
      };
      await saveBatch(currentBatch);
    }

    // Build deterministic filename
    const filename =
      outputRecord?.filename ||
      buildOutputFilename({
        template: currentBatch.downloadSettings.filenameTemplate,
        projectName: currentBatch.name,
        prompt: currentTask.originalPrompt,
        sequenceNumber: assignedNumber,
        extension: asset.extension || (currentTask.taskType === 'video' ? 'mp4' : 'png'),
        autoNumbering: currentBatch.downloadSettings.autoNumbering,
        existingFilenames
      });

    const now = Date.now();
    if (!outputRecord) {
      outputRecord = {
        id: `out_${ currentTask.id }_${ asset.index }`,
        batchId: currentBatch.id,
        taskId: currentTask.id,
        platform: currentTask.platform,
        type: asset.type || currentTask.taskType,
        index: asset.index,
        assignedSequenceNumber: assignedNumber,
        originalPrompt: currentTask.originalPrompt,
        finalSubmittedPrompt: currentTask.finalPromptSnapshot,
        generationStatus: 'completed',
        status: 'requested',
        filename,
        sourceUrl: asset.url,
        previewUrl: asset.url,
        retryCount: 0,
        createdAt: now
      };
    } else {
      outputRecord = {
        ...outputRecord,
        status: 'requested',
        sourceUrl: asset.url || outputRecord.sourceUrl,
        previewUrl: asset.url || outputRecord.previewUrl,
        error: undefined
      };
    }

    await saveOutput(outputRecord);

    if (!currentTask.outputIds.includes(outputRecord.id)) {
      currentTask = {
        ...currentTask,
        outputIds: [...currentTask.outputIds, outputRecord.id],
        updatedAt: Date.now()
      };
      await saveTask(currentTask);
    }

    // Execute the download for this output
    const updatedOutput = await executeSingleOutputDownload({
      batch: currentBatch,
      task: currentTask,
      output: outputRecord,
      asset,
      adapter
    });
    processedOutputs.push(updatedOutput);
  }

  const finalTaskState = await reconcileTaskDownloadState(currentTask.id);
  return {
    task: finalTaskState.task,
    batch: currentBatch,
    outputs: processedOutputs,
    allSucceeded: finalTaskState.allCompleted
  };
}

/**
 * Executes or retries the download for a single OutputRecord without regenerating the asset.
 */
export async function executeSingleOutputDownload(params: {
  batch: BatchRecord;
  task: TaskRecord;
  output: OutputRecord;
  asset?: DetectedPlatformAsset;
  adapter?: PlatformAdapter;
}): Promise<OutputRecord> {
  const { batch, task, output, asset, adapter } = params;
  const relativePath = formatRelativeDownloadPath(
    batch.downloadSettings.subfolder,
    output.filename,
    { projectName: batch.name }
  );

  // 1. Check if user explicitly configured a File System Access API handle and if it is still valid
  if (batch.downloadSettings.saveMode === 'filesystem_handle') {
    const perm = await verifyCustomDirectoryPermission();
    if (!perm.granted) {
      const failedOut: OutputRecord = {
        ...output,
        status: 'needs_attention',
        error:
          perm.reason ||
          'Custom folder permission was revoked. Re-authorize folder access or switch to Downloads Subfolder mode.'
      };
      await saveOutput(failedOut);
      return failedOut;
    }
  }

  // 2. If we have a permitted direct URL (https: or data:) and chrome.downloads is available, use chrome.downloads
  // UNLESS this is a Google Flow or ChatGPT asset with an official platform download button (`asset.hasNativeDownloadButton`),
  // in which case we prefer Step 3 (`adapter.downloadResult`) to click the platform's official Download button.
  const directUrl = asset?.url || output.sourceUrl;
  const preferOfficialPlatformDownloadButton =
    (task.platform === 'google_flow' || task.platform === 'chatgpt') &&
    Boolean(adapter) &&
    Boolean(asset?.hasNativeDownloadButton);

  const canUseDirectChromeDownload =
    !preferOfficialPlatformDownloadButton &&
    Boolean(directUrl) &&
    hasChromeDownloadsApi() &&
    (directUrl!.startsWith('https://') ||
      directUrl!.startsWith('http://') ||
      directUrl!.startsWith('data:'));

  if (canUseDirectChromeDownload && directUrl) {
    try {
      const dlResult = await triggerChromeDownload(
        directUrl,
        relativePath,
        batch.downloadSettings.conflictAction
      );
      const nextOut: OutputRecord = {
        ...output,
        downloadId: dlResult.downloadId,
        downloadMethod: 'chrome_downloads',
        status: dlResult.status,
        completedAt: dlResult.status === 'completed' ? Date.now() : undefined,
        error: dlResult.error
      };
      await saveOutput(nextOut);
      await appendDiagnosticLog({
        level: dlResult.status === 'completed' || dlResult.status === 'in_progress' ? 'info' : 'warn',
        scope: 'download',
        batchId: batch.id,
        taskId: task.id,
        message: `Download ${dlResult.status} for ${output.filename} (downloadId=${dlResult.downloadId})`
      });
      return nextOut;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Chrome download failed';
      // Fall through to adapter native download button if available
      await appendDiagnosticLog({
        level: 'warn',
        scope: 'download',
        batchId: batch.id,
        taskId: task.id,
        message: `Direct chrome.downloads failed (${errMsg}); attempting platform download control.`
      });
    }
  }

  // 3. Use platform adapter's downloadResult (e.g. native download button click or blob extraction)
  if (adapter) {
    const targetAsset: DetectedPlatformAsset = asset || {
      index: output.index,
      type: output.type,
      url: output.sourceUrl,
      extension: output.filename.split('.').pop() || 'png',
      hasNativeDownloadButton: true
    };

    pendingNativeDownload = {
      outputId: output.id,
      taskId: task.id,
      batchId: batch.id,
      relativePath,
      expiresAt: Date.now() + 15000
    };

    try {
      const adapterDl = await adapter.downloadResult(targetAsset, relativePath);
      if (adapterDl.initiated) {
        // If the adapter resolved a data:/https: URL for us to pass to chrome.downloads
        if (
          adapterDl.method === 'chrome_downloads' &&
          adapterDl.resolvedUrl &&
          hasChromeDownloadsApi()
        ) {
          clearPendingNativeDownload();
          const dlRes = await triggerChromeDownload(
            adapterDl.resolvedUrl,
            relativePath,
            batch.downloadSettings.conflictAction
          );
          const nextOut: OutputRecord = {
            ...output,
            downloadId: dlRes.downloadId,
            downloadMethod: 'chrome_downloads',
            status: dlRes.status,
            completedAt: dlRes.status === 'completed' ? Date.now() : undefined,
            previewUrl: adapterDl.resolvedUrl || output.previewUrl || output.sourceUrl,
            error: dlRes.error
          };
          await saveOutput(nextOut);
          return nextOut;
        }

        // Native button click initiated download
        const nextOut: OutputRecord = {
          ...output,
          downloadMethod: 'native_button',
          status: 'completed',
          completedAt: Date.now(),
          error: undefined
        };
        await saveOutput(nextOut);
        return nextOut;
      } else {
        clearPendingNativeDownload();
        // Fallback: If platform button could not be activated, but direct URL is available,
        // use direct Chrome download rather than leaving the output undownloaded!
        if (
          directUrl &&
          hasChromeDownloadsApi() &&
          (directUrl.startsWith('https://') || directUrl.startsWith('http://') || directUrl.startsWith('blob:'))
        ) {
          try {
            const dlRes = await triggerChromeDownload(
              directUrl,
              relativePath,
              batch.downloadSettings.conflictAction
            );
            const nextOut: OutputRecord = {
              ...output,
              downloadId: dlRes.downloadId,
              downloadMethod: 'chrome_downloads',
              status: dlRes.status,
              completedAt: dlRes.status === 'completed' ? Date.now() : undefined,
              previewUrl: directUrl || output.previewUrl || output.sourceUrl,
              error: dlRes.error
            };
            await saveOutput(nextOut);
            return nextOut;
          } catch {}
        }

        const failedOut: OutputRecord = {
          ...output,
          status: 'needs_attention',
          error:
            adapterDl.userMessage ||
            'Platform download button was unavailable. You can save the generated output manually from the tab.'
        };
        await saveOutput(failedOut);
        return failedOut;
      }
    } catch (err) {
      clearPendingNativeDownload();
      const failedOut: OutputRecord = {
        ...output,
        status: 'interrupted',
        error: err instanceof Error ? err.message : 'Adapter download action failed'
      };
      await saveOutput(failedOut);
      return failedOut;
    }
  }

  const failedOut: OutputRecord = {
    ...output,
    status: 'needs_attention',
    error: 'No supported automatic download path was available for this output.'
  };
  await saveOutput(failedOut);
  return failedOut;
}

/**
 * Reconciles the parent TaskRecord status based on all of its OutputRecords.
 * Guarantees:
 * - Task is only marked `completed` when all outputs have `status === 'completed'`.
 * - If any output failed/interrupted/cancelled/needs_attention, task is marked `download_failed`
 *   with friendlyStatus: "Generation complete, but the download needs attention."
 */
export async function reconcileTaskDownloadState(taskId: string): Promise<{
  task: TaskRecord;
  allCompleted: boolean;
  anyFailed: boolean;
}> {
  const task = await getTask(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found during download state reconciliation`);
  }

  const outputs = await getOutputsByTask(taskId);
  if (outputs.length === 0) {
    const failedTask = transitionTaskRecord(task, 'download_failed', {
      friendlyStatus: 'Generation complete, but the download needs attention.'
    });
    failedTask.lastError = {
      code: 'DOWNLOAD_UNAVAILABLE',
      userMessage: 'Generation complete, but the download needs attention.',
      recommendedAction: 'Click Retry Download or save the generated asset directly from the website tab.',
      retryableGeneration: false,
      retryableDownload: true,
      occurredAt: Date.now()
    };
    await saveTask(failedTask);
    return { task: failedTask, allCompleted: false, anyFailed: true };
  }

  const allCompleted = outputs.every((o) => o.status === 'completed');
  const anyFailed = outputs.some(
    (o) =>
      o.status === 'interrupted' ||
      o.status === 'cancelled' ||
      o.status === 'needs_attention'
  );

  if (allCompleted) {
    const completedTask =
      task.status === 'completed'
        ? task
        : transitionTaskRecord(task, 'completed', {
            friendlyStatus: 'Download complete.'
          });
    await saveTask(completedTask);
    return { task: completedTask, allCompleted: true, anyFailed: false };
  }

  if (anyFailed) {
    const failedOutput = outputs.find((o) => o.status !== 'completed');
    const dlFailedTask =
      task.status === 'download_failed'
        ? { ...task }
        : transitionTaskRecord(task, 'download_failed', {
            friendlyStatus: 'Generation complete, but the download needs attention.'
          });
    dlFailedTask.lastError = {
      code:
        failedOutput?.status === 'interrupted' || failedOutput?.status === 'cancelled'
          ? 'DOWNLOAD_INTERRUPTED'
          : 'DOWNLOAD_UNAVAILABLE',
      userMessage: 'Generation complete, but the download needs attention.',
      recommendedAction:
        'Click "Retry Download" to save the generated output without re-running generation.',
      retryableGeneration: false,
      retryableDownload: true,
      diagnostics: failedOutput?.error,
      occurredAt: Date.now()
    };
    await saveTask(dlFailedTask);
    return { task: dlFailedTask, allCompleted: false, anyFailed: true };
  }

  // Still in progress
  return { task, allCompleted: false, anyFailed: false };
}

/**
 * Handles Chrome's `chrome.downloads.onChanged` event in the background service worker.
 */
export async function handleChromeDownloadChanged(
  delta: chrome.downloads.DownloadDelta
): Promise<{ updatedOutput?: OutputRecord; updatedTask?: TaskRecord }> {
  if (!delta.state && !delta.error) return {};

  let output = await getOutputByDownloadId(delta.id);
  if (!output) {
    await new Promise((r) => setTimeout(r, 150));
    output = await getOutputByDownloadId(delta.id);
  }
  if (!output) return {};

  let nextStatus: OutputStatus = output.status;
  let errorMsg = output.error;

  if (delta.state?.current === 'complete') {
    nextStatus = 'completed';
    errorMsg = undefined;
  } else if (delta.state?.current === 'interrupted') {
    const errCode = delta.error?.current || 'NETWORK_FAILED';
    nextStatus =
      errCode === 'USER_CANCELED' || errCode === 'USER_SHUTDOWN'
        ? 'cancelled'
        : 'interrupted';
    errorMsg = `Browser download interrupted (${errCode})`;
  }

  const updatedOutput: OutputRecord = {
    ...output,
    status: nextStatus,
    completedAt: nextStatus === 'completed' ? Date.now() : output.completedAt,
    error: errorMsg
  };
  await saveOutput(updatedOutput);

  const reconciled = await reconcileTaskDownloadState(output.taskId);
  return {
    updatedOutput,
    updatedTask: reconciled.task
  };
}

/**
 * Retries failed downloads for a task WITHOUT re-submitting or regenerating the prompt.
 */
export async function retryTaskDownloadsOnly(
  taskId: string,
  adapter?: PlatformAdapter
): Promise<TaskRecord> {
  const task = await getTask(taskId);
  if (!task) {
    throw new Error(`Task "${taskId}" not found.`);
  }
  const batch = await getBatch(task.batchId);
  if (!batch) {
    throw new Error(`Batch "${task.batchId}" not found.`);
  }

  const outputs = await getOutputsByTask(taskId);
  const downloadingTask = transitionTaskRecord(task, 'downloading', {
    friendlyStatus:
      task.taskType === 'video' ? 'Downloading video.' : 'Downloading image.'
  });
  await saveTask(downloadingTask);

  if (outputs.length === 0 && adapter) {
    // Re-inspect the page for existing generated outputs without submitting
    const detected = await adapter.getResults(downloadingTask);
    if (detected.length > 0) {
      const res = await processTaskOutputsDownload({
        batch,
        task: downloadingTask,
        assets: detected,
        adapter
      });
      return res.task;
    }
  }

  for (const out of outputs) {
    if (out.status === 'completed') continue;
    const retryOut: OutputRecord = {
      ...out,
      retryCount: out.retryCount + 1,
      status: 'requested',
      error: undefined
    };
    await saveOutput(retryOut);
    await executeSingleOutputDownload({
      batch,
      task: downloadingTask,
      output: retryOut,
      adapter
    });
  }

  const reconciled = await reconcileTaskDownloadState(taskId);
  return reconciled.task;
}

export async function retrySingleOutputDownload(
  outputId: string,
  adapter?: PlatformAdapter
): Promise<OutputRecord> {
  const output = await getOutput(outputId);
  if (!output) throw new Error(`Output "${outputId}" not found.`);
  const task = await getTask(output.taskId);
  if (!task) throw new Error(`Task "${output.taskId}" not found.`);
  const batch = await getBatch(output.batchId);
  if (!batch) throw new Error(`Batch "${output.batchId}" not found.`);

  if (task.status === 'download_failed') {
    const dlTask = transitionTaskRecord(task, 'downloading', {
      friendlyStatus:
        task.taskType === 'video' ? 'Downloading video.' : 'Downloading image.'
    });
    await saveTask(dlTask);
  }

  const nextOut: OutputRecord = {
    ...output,
    retryCount: output.retryCount + 1,
    status: 'requested',
    error: undefined
  };
  await saveOutput(nextOut);

  const updated = await executeSingleOutputDownload({
    batch,
    task,
    output: nextOut,
    adapter
  });
  await reconcileTaskDownloadState(task.id);
  return updated;
}
