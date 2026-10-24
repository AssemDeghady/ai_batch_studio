import { TaskRecord, TaskType, TimeoutSettings } from '../types/models';

export type ObservablePlatformGenerationState =
  | 'active'      // Platform shows spinner/progress bar/streaming indicator
  | 'completed'   // Platform shows generated output asset(s)
  | 'failed'      // Platform shows explicit error banner/rejection
  | 'idle'        // Platform is idle with no active generation and no output for this prompt
  | 'unknown';    // Cannot reliably determine state (e.g., DOM changed or tab busy)

export interface TimeoutEvaluationDecision {
  decision:
    | 'wait_initial_window'
    | 'continue_generating'
    | 'proceed_to_download'
    | 'mark_failed'
    | 'auto_retry'
    | 'needs_attention';
  friendlyStatus: string;
  reason?: string;
}

/**
 * Computes the randomized or deterministic initial observation delay in milliseconds
 * within [initialObservationMinSec, initialObservationMaxSec].
 */
export function computeInitialObservationDelayMs(
  settings: TimeoutSettings,
  randomFn: () => number = Math.random
): number {
  const minMs = Math.max(1, settings.initialObservationMinSec) * 1000;
  const maxMs = Math.max(minMs, settings.initialObservationMaxSec * 1000);
  if (minMs === maxMs) return minMs;
  return Math.round(minMs + randomFn() * (maxMs - minMs));
}

export function computeMaxTimeoutMs(
  taskType: TaskType,
  settings: TimeoutSettings
): number {
  const sec =
    taskType === 'video'
      ? Math.max(30, settings.maxVideoTimeoutSec)
      : Math.max(20, settings.maxImageTimeoutSec);
  return sec * 1000;
}

/**
 * Evaluates a generating task against the initial observation window, maximum timeout,
 * observable platform state, and configured timeout policy.
 *
 * Critical safety guarantee:
 * - Never marks an actively generating task as failed merely because the 10-15s initial window elapsed.
 * - Never auto-retries when the platform state is 'active' or 'unknown' (prevents duplicate submissions).
 */
export function evaluateGenerationObservation(params: {
  task: TaskRecord;
  settings: TimeoutSettings;
  observableState: ObservablePlatformGenerationState;
  now?: number;
  errorMessage?: string;
}): TimeoutEvaluationDecision {
  const { task, settings, observableState, now = Date.now(), errorMessage } = params;

  // 1. If a completed output is already observable on the page, proceed immediately to download
  if (observableState === 'completed') {
    return {
      decision: 'proceed_to_download',
      friendlyStatus: task.taskType === 'video' ? 'Video generated.' : 'Image generated.'
    };
  }

  // 2. If the platform explicitly reported an error (e.g. policy block, quota, generation error)
  if (observableState === 'failed') {
    return {
      decision: 'mark_failed',
      friendlyStatus: 'Failed task ready to retry.',
      reason: errorMessage || 'The platform reported a generation error.'
    };
  }

  // 3. Check if we are still within the initial 10-15s observation window
  const initialUntil = task.initialObservationUntil ?? (task.submittedAt ?? now) + 10000;
  if (now < initialUntil) {
    return {
      decision: 'wait_initial_window',
      friendlyStatus: 'Waiting for generation.'
    };
  }

  // 4. Past initial observation window: check if maximum timeout has been reached
  const maxTimeoutAt =
    task.timeoutAt ??
    (task.submittedAt ?? now) + computeMaxTimeoutMs(task.taskType, settings);
  const isTimedOut = now >= maxTimeoutAt;

  if (!isTimedOut) {
    // Still within maximum allowed generation time
    if (observableState === 'active') {
      return {
        decision: 'continue_generating',
        friendlyStatus: 'Generation is still in progress.'
      };
    }

    // If platform is idle after initial window has elapsed:
    // Allow a brief grace window (up to 15s past initial window) in case the spinner is slow to mount,
    // but if still completely idle after that, do NOT leave the user stuck forever in "Generating"!
    if (observableState === 'idle') {
      const idleGraceUntil = initialUntil + 15000;
      if (now > idleGraceUntil) {
        return {
          decision: 'needs_attention',
          friendlyStatus: 'No active generation detected on the page.',
          reason:
            'The initial observation window elapsed and the platform is idle with no active generation indicator. Please inspect the website tab.'
        };
      }
      return {
        decision: 'continue_generating',
        friendlyStatus: 'Waiting for generation to begin.'
      };
    }

    // observableState === 'unknown' before max timeout: keep polling cautiously
    return {
      decision: 'continue_generating',
      friendlyStatus: 'Generation is still in progress.'
    };
  }

  // 5. Maximum timeout has been exceeded!
  // Safety check: if the platform is still visibly generating or state is uncertain ('unknown'),
  // DO NOT blindly resubmit.
  if (observableState === 'active' || observableState === 'unknown') {
    if (settings.timeoutPolicy === 'keep_waiting' && observableState === 'active') {
      return {
        decision: 'continue_generating',
        friendlyStatus: 'Generation took longer than expected.'
      };
    }

    return {
      decision: 'needs_attention',
      friendlyStatus: 'Generation took longer than expected.',
      reason:
        observableState === 'active'
          ? 'The platform is still actively generating past the configured timeout. Inspect the tab or keep waiting to avoid duplicate submission.'
          : 'Could not confirm whether generation finished or is still running. Set to Needs Attention to prevent duplicate submission.'
    };
  }

  // Here observableState === 'idle' (generation stopped with no result produced after max timeout)
  if (settings.timeoutPolicy === 'keep_waiting') {
    return {
      decision: 'needs_attention',
      friendlyStatus: 'Generation took longer than expected.',
      reason:
        'Maximum generation wait time elapsed and no output was detected on the page.'
    };
  }

  if (
    settings.timeoutPolicy === 'auto_retry' &&
    task.retryCount < settings.maxAutoRetries
  ) {
    return {
      decision: 'auto_retry',
      friendlyStatus: 'Failed task ready to retry.',
      reason: `Generation timed out with platform idle; automatically retrying (${
        task.retryCount + 1
      }/${settings.maxAutoRetries}).`
    };
  }

  return {
    decision: 'mark_failed',
    friendlyStatus: 'Failed task ready to retry.',
    reason: 'Generation timed out without producing a result.'
  };
}
