import { TaskRecord, TaskStatus, TaskType } from '../types/models';

export const VALID_TASK_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  pending: new Set<TaskStatus>([
    'queued',
    'connecting',
    'inspecting',
    'preparing',
    'paused',
    'skipped',
    'cancelled'
  ]),
  queued: new Set<TaskStatus>([
    'connecting',
    'inspecting',
    'preparing',
    'paused',
    'skipped',
    'cancelled',
    'failed',
    'needs_attention'
  ]),
  connecting: new Set<TaskStatus>([
    'inspecting',
    'preparing',
    'submitting',
    'failed',
    'submission_failed',
    'needs_attention',
    'paused',
    'skipped',
    'cancelled'
  ]),
  inspecting: new Set<TaskStatus>([
    'preparing',
    'composer_verified',
    'submitting',
    'failed',
    'submission_failed',
    'needs_attention',
    'paused',
    'skipped',
    'cancelled'
  ]),
  preparing: new Set<TaskStatus>([
    'composer_verified',
    'prompt_entered',
    'submitting',
    'failed',
    'submission_failed',
    'paused',
    'needs_attention',
    'skipped',
    'cancelled'
  ]),
  composer_verified: new Set<TaskStatus>([
    'prompt_entered',
    'submitting',
    'failed',
    'submission_failed',
    'needs_attention',
    'paused',
    'skipped',
    'cancelled'
  ]),
  prompt_entered: new Set<TaskStatus>([
    'submitting',
    'submitted',
    'failed',
    'submission_failed',
    'needs_attention',
    'paused',
    'skipped',
    'cancelled'
  ]),
  submitting: new Set<TaskStatus>([
    'submitted',
    'awaiting_generation',
    'generating',
    'failed',
    'submission_failed',
    'paused',
    'needs_attention',
    'skipped',
    'cancelled'
  ]),
  submitted: new Set<TaskStatus>([
    'awaiting_generation',
    'generating',
    'failed',
    'generation_failed',
    'needs_attention',
    'paused',
    'skipped',
    'cancelled'
  ]),
  awaiting_generation: new Set<TaskStatus>([
    'generating',
    'result_detected',
    'downloading',
    'completed',
    'failed',
    'generation_failed',
    'needs_attention',
    'paused',
    'skipped',
    'cancelled'
  ]),
  generating: new Set<TaskStatus>([
    'generating',
    'result_detected',
    'downloading',
    'completed',
    'download_failed',
    'failed',
    'generation_failed',
    'paused',
    'needs_attention',
    'skipped',
    'cancelled'
  ]),
  result_detected: new Set<TaskStatus>([
    'downloading',
    'completed',
    'download_failed',
    'failed',
    'needs_attention',
    'paused',
    'skipped',
    'cancelled'
  ]),
  downloading: new Set<TaskStatus>([
    'downloading',
    'completed',
    'download_failed',
    'paused',
    'needs_attention',
    'failed'
  ]),
  completed: new Set<TaskStatus>([]), // Completed tasks are terminal and never automatically rerun
  submission_failed: new Set<TaskStatus>(['pending', 'queued', 'preparing', 'skipped', 'cancelled']),
  generation_failed: new Set<TaskStatus>(['pending', 'queued', 'preparing', 'skipped', 'cancelled']),
  download_failed: new Set<TaskStatus>([
    'downloading', // Retry download independently without regenerating
    'preparing',   // Explicit full task regeneration if user chooses
    'pending',
    'queued',
    'skipped',
    'cancelled'
  ]),
  failed: new Set<TaskStatus>(['pending', 'queued', 'preparing', 'skipped', 'cancelled']),
  paused: new Set<TaskStatus>([
    'pending',
    'queued',
    'connecting',
    'inspecting',
    'preparing',
    'composer_verified',
    'prompt_entered',
    'submitting',
    'submitted',
    'awaiting_generation',
    'generating',
    'result_detected',
    'downloading',
    'failed',
    'submission_failed',
    'generation_failed',
    'needs_attention',
    'skipped',
    'cancelled'
  ]),
  needs_attention: new Set<TaskStatus>([
    'pending',
    'queued',
    'connecting',
    'inspecting',
    'preparing',
    'composer_verified',
    'prompt_entered',
    'submitting',
    'submitted',
    'awaiting_generation',
    'generating',
    'result_detected',
    'downloading',
    'completed',
    'download_failed',
    'failed',
    'submission_failed',
    'generation_failed',
    'paused',
    'skipped',
    'cancelled'
  ]),
  cancelled: new Set<TaskStatus>(['pending', 'queued']),
  skipped: new Set<TaskStatus>(['pending', 'queued'])
};

export class InvalidStateTransitionError extends Error {
  public readonly from: TaskStatus;
  public readonly to: TaskStatus;

  constructor(from: TaskStatus, to: TaskStatus, taskId?: string) {
    super(
      `Invalid task state transition from "${from}" to "${to}"${
        taskId ? ` for task ${taskId}` : ''
      }.`
    );
    this.name = 'InvalidStateTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function canTransitionTaskStatus(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  return VALID_TASK_TRANSITIONS[from]?.has(to) ?? false;
}

export function assertValidTaskTransition(
  from: TaskStatus,
  to: TaskStatus,
  taskId?: string
): void {
  if (!canTransitionTaskStatus(from, to)) {
    throw new InvalidStateTransitionError(from, to, taskId);
  }
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'submission_failed' ||
    status === 'generation_failed' ||
    status === 'download_failed' ||
    status === 'cancelled' ||
    status === 'skipped'
  );
}

export function isActiveTaskStatus(status: TaskStatus): boolean {
  return (
    status === 'connecting' ||
    status === 'inspecting' ||
    status === 'preparing' ||
    status === 'composer_verified' ||
    status === 'prompt_entered' ||
    status === 'submitting' ||
    status === 'submitted' ||
    status === 'awaiting_generation' ||
    status === 'generating' ||
    status === 'result_detected' ||
    status === 'downloading'
  );
}

export function getDefaultFriendlyStatus(
  status: TaskStatus,
  taskType: TaskType = 'image',
  pastInitialWindow = false
): string {
  const assetWord = taskType === 'video' ? 'video' : 'image';
  switch (status) {
    case 'pending':
    case 'queued':
      return 'Ready to start.';
    case 'connecting':
      return 'Connecting to tab.';
    case 'inspecting':
      return 'Inspecting page controls.';
    case 'preparing':
      return 'Preparing prompt.';
    case 'composer_verified':
      return 'Prompt composer verified.';
    case 'prompt_entered':
      return 'Prompt entered and verified.';
    case 'submitting':
      return 'Submitting prompt.';
    case 'submitted':
      return 'Prompt submitted.';
    case 'awaiting_generation':
      return 'Awaiting generation start.';
    case 'generating':
      return pastInitialWindow
        ? 'Generation is still in progress.'
        : 'Waiting for generation.';
    case 'result_detected':
      return `New ${assetWord} detected.`;
    case 'downloading':
      return `Downloading ${assetWord}.`;
    case 'completed':
      return `Completed (${assetWord} saved).`;
    case 'submission_failed':
      return 'Submission failed.';
    case 'generation_failed':
      return 'Generation failed.';
    case 'download_failed':
      return 'Download failed (retryable).';
    case 'failed':
      return 'Failed task ready to retry.';
    case 'paused':
      return 'Paused.';
    case 'needs_attention':
      return 'Needs attention.';
    case 'cancelled':
      return 'Cancelled.';
    case 'skipped':
      return 'Skipped.';
  }
}

export function transitionTaskRecord(
  task: TaskRecord,
  nextStatus: TaskStatus,
  options?: {
    friendlyStatus?: string;
    pastInitialWindow?: boolean;
    now?: number;
  }
): TaskRecord {
  assertValidTaskTransition(task.status, nextStatus, task.id);
  const now = options?.now ?? Date.now();
  const friendlyStatus =
    options?.friendlyStatus ??
    getDefaultFriendlyStatus(nextStatus, task.taskType, options?.pastInitialWindow);

  const updated: TaskRecord = {
    ...task,
    status: nextStatus,
    friendlyStatus,
    updatedAt: now
  };

  if (nextStatus === 'submitting' && !updated.submittedAt) {
    updated.submittedAt = now;
  }

  if (nextStatus === 'completed') {
    updated.completedAt = now;
    updated.lastError = undefined;
  }

  return updated;
}
