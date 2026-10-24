import React, { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  ExternalLink,
  FileText,
  Pause,
  Play,
  RefreshCw,
  SkipForward,
  Square,
  Terminal,
  XCircle
} from 'lucide-react';
import {
  BatchRecord,
  DiagnosticLogEntry,
  OutputRecord,
  PlatformTabDiagnostics,
  ReferenceRecord,
  TaskRecord,
  TaskStatus
} from '../../types/models';
import { dispatchBackgroundCommand } from '../backgroundClient';

export interface QueueViewProps {
  batch: BatchRecord;
  tasks: TaskRecord[];
  outputsByTask: Record<string, OutputRecord[]>;
  referencesMap: Record<string, ReferenceRecord>;
  diagnosticLogs: DiagnosticLogEntry[];
  onStart: () => Promise<void>;
  onPause: () => Promise<void>;
  onResume: () => Promise<void>;
  onStop: () => Promise<void>;
  onRetrySingleTask: (taskId: string) => Promise<void>;
  onRetrySelectedTasks: (taskIds: string[]) => Promise<void>;
  onRetryAllFailed: () => Promise<void>;
  onRetryDownloadOnly: (taskId: string) => Promise<void>;
  onSkipTask: (taskId: string) => Promise<void>;
  onUpdateTaskPrompt: (taskId: string, newPrompt: string) => Promise<void>;
  onOpenPlatformTab: () => void;
}

function getStatusBadgeClass(status: TaskStatus): string {
  switch (status) {
    case 'completed':
      return 'badge badge-success';
    case 'preparing':
    case 'submitting':
    case 'generating':
    case 'downloading':
      return 'badge badge-info';
    case 'failed':
      return 'badge badge-danger';
    case 'download_failed':
    case 'needs_attention':
    case 'paused':
      return 'badge badge-warning';
    default:
      return 'badge badge-neutral';
  }
}

function formatDuration(task: TaskRecord, now: number): string {
  if (!task.submittedAt) return '—';
  const end = task.completedAt || now;
  const sec = Math.max(0, Math.round((end - task.submittedAt) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m ${rem}s`;
}

export const QueueView: React.FC<QueueViewProps> = ({
  batch,
  tasks,
  outputsByTask,
  referencesMap,
  diagnosticLogs,
  onStart,
  onPause,
  onResume,
  onStop,
  onRetrySingleTask,
  onRetrySelectedTasks,
  onRetryAllFailed,
  onRetryDownloadOnly,
  onSkipTask,
  onUpdateTaskPrompt,
  onOpenPlatformTab
}) => {
  const [selectedFailedIds, setSelectedFailedIds] = useState<Set<string>>(new Set());
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [expandedTaskIds, setExpandedTaskIds] = useState<Set<string>>(new Set());
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editPromptValue, setEditPromptValue] = useState('');
  const [tabDiagnostics, setTabDiagnostics] = useState<PlatformTabDiagnostics | null>(null);
  const [loadingTabDiag, setLoadingTabDiag] = useState(false);

  const refreshTabDiagnostics = async () => {
    setLoadingTabDiag(true);
    try {
      const diag = await dispatchBackgroundCommand<PlatformTabDiagnostics>({
        type: 'BS_BG_DIAGNOSE_TAB',
        platformId: batch.platform,
        batchId: batch.id
      });
      setTabDiagnostics(diag);
    } catch {
      // Non-fatal
    } finally {
      setLoadingTabDiag(false);
    }
  };

  const now = Date.now();
  const totalCount = tasks.length;
  const completedCount = tasks.filter((t) => t.status === 'completed').length;
  const runningCount = tasks.filter(
    (t) =>
      t.status === 'preparing' ||
      t.status === 'submitting' ||
      t.status === 'generating' ||
      t.status === 'downloading'
  ).length;
  const pendingCount = tasks.filter(
    (t) => t.status === 'pending' || t.status === 'paused'
  ).length;
  const failedCount = tasks.filter(
    (t) =>
      t.status === 'failed' ||
      t.status === 'download_failed' ||
      t.status === 'needs_attention'
  ).length;

  const progressPct =
    totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  const currentTask =
    tasks.find((t) => t.id === batch.activeTaskId) ||
    tasks.find(
      (t) =>
        t.status === 'preparing' ||
        t.status === 'submitting' ||
        t.status === 'generating' ||
        t.status === 'downloading' ||
        t.status === 'needs_attention'
    );

  const toggleSelectFailed = (taskId: string) => {
    setSelectedFailedIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const toggleExpandTask = (taskId: string) => {
    setExpandedTaskIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const platformLabel =
    batch.platform === 'chatgpt' ? 'ChatGPT' : 'Google Flow';
  const taskTypeLabel =
    batch.taskType === 'video' ? 'Video Generation' : 'Image Generation';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {/* Batch Overview Card */}
      <div className="card">
        <div className="card-header">
          <div>
            <h2 className="card-title" data-testid="queue-batch-name">
              {batch.name}
            </h2>
            <p className="card-subtitle">
              {platformLabel} • {taskTypeLabel}
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span
              className={
                batch.status === 'completed'
                  ? 'badge badge-success'
                  : batch.status === 'running'
                  ? 'badge badge-info'
                  : batch.status === 'needs_attention'
                  ? 'badge badge-warning'
                  : 'badge badge-neutral'
              }
              data-testid="queue-batch-status"
            >
              {batch.status === 'completed'
                ? 'Batch completed.'
                : batch.status === 'paused'
                ? 'Queue paused.'
                : batch.status === 'running'
                ? 'Queue running'
                : batch.status === 'needs_attention'
                ? 'Needs attention'
                : batch.status === 'stopped'
                ? 'Queue stopped'
                : 'Ready to start.'}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={onOpenPlatformTab}
              title={`Open ${platformLabel} tab`}
            >
              <ExternalLink size={12} />
              Open {platformLabel}
            </button>
          </div>
        </div>

        {/* Overall Progress Bar */}
        <div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: '11.5px',
              color: 'var(--text-secondary)'
            }}
          >
            <span>
              Overall Progress ({completedCount} of {totalCount} completed)
            </span>
            <span style={{ fontWeight: 700 }}>{progressPct}%</span>
          </div>
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>

        {/* Counters Grid */}
        <div className="grid-4" style={{ marginTop: '10px' }}>
          <div className="stat-box">
            <div
              className="stat-value"
              style={{ color: 'var(--status-success)' }}
              data-testid="count-completed"
            >
              {completedCount}
            </div>
            <div className="stat-label">Completed</div>
          </div>
          <div className="stat-box">
            <div
              className="stat-value"
              style={{ color: 'var(--status-info)' }}
              data-testid="count-running"
            >
              {runningCount}
            </div>
            <div className="stat-label">Running</div>
          </div>
          <div className="stat-box">
            <div className="stat-value" data-testid="count-pending">
              {pendingCount}
            </div>
            <div className="stat-label">Pending</div>
          </div>
          <div className="stat-box">
            <div
              className="stat-value"
              style={{ color: 'var(--status-danger)' }}
              data-testid="count-failed"
            >
              {failedCount}
            </div>
            <div className="stat-label">Failed / Attn</div>
          </div>
        </div>

        {/* Current Active Task Banner */}
        {currentTask && (
          <div
            className="alert-banner alert-info"
            style={{ marginTop: '10px' }}
            data-testid="current-task-banner"
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center'
              }}
            >
              <strong>
                Current Task #{currentTask.sequenceNumber}:{' '}
                {currentTask.friendlyStatus}
              </strong>
              <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                <Clock size={11} style={{ verticalAlign: 'middle' }} />{' '}
                {formatDuration(currentTask, now)}
              </span>
            </div>
            <div
              style={{
                fontSize: '11.5px',
                color: 'var(--text-secondary)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}
            >
              {currentTask.originalPrompt}
            </div>
          </div>
        )}

        {/* Primary Queue Controls */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '8px',
            marginTop: '12px'
          }}
        >
          {(batch.status === 'ready' || batch.status === 'draft') && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={onStart}
              data-testid="queue-start-btn"
            >
              <Play size={14} /> Start Queue
            </button>
          )}

          {batch.status === 'running' && (
            <button
              type="button"
              className="btn btn-warning"
              onClick={onPause}
              data-testid="queue-pause-btn"
            >
              <Pause size={14} /> Pause
            </button>
          )}

          {(batch.status === 'paused' ||
            batch.status === 'stopped' ||
            batch.status === 'needs_attention') && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={onResume}
              data-testid="queue-resume-btn"
            >
              <Play size={14} /> Resume Queue
            </button>
          )}

          {(batch.status === 'running' || batch.status === 'paused') &&
            !confirmingStop && (
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  if (pendingCount > 0 || runningCount > 0) {
                    setConfirmingStop(true);
                  } else {
                    onStop();
                  }
                }}
                data-testid="queue-stop-btn"
              >
                <Square size={13} /> Stop
              </button>
            )}

          {failedCount > 0 && (
            <button
              type="button"
              className="btn"
              onClick={onRetryAllFailed}
              data-testid="queue-retry-all-btn"
            >
              <RefreshCw size={13} /> Retry All Failed ({failedCount})
            </button>
          )}

          {selectedFailedIds.size > 0 && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={async () => {
                const ids = Array.from(selectedFailedIds);
                setSelectedFailedIds(new Set());
                await onRetrySelectedTasks(ids);
              }}
              data-testid="queue-retry-selected-btn"
            >
              <RefreshCw size={13} /> Retry Selected ({selectedFailedIds.size})
            </button>
          )}
        </div>

        {/* Stop Confirmation Warning */}
        {confirmingStop && (
          <div
            className="alert-banner alert-warning"
            style={{ marginTop: '10px' }}
            data-testid="stop-confirm-banner"
          >
            <strong>Stop the batch queue?</strong>
            <span>
              Stopping prevents any additional pending tasks from starting, though
              it may not cancel a generation already submitted to the website.
              Your queue and completed outputs will be preserved so you can
              resume later.
            </span>
            <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={async () => {
                  setConfirmingStop(false);
                  await onStop();
                }}
                data-testid="confirm-stop-yes-btn"
              >
                Confirm Stop
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setConfirmingStop(false)}
              >
                Keep Running
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Task Cards List */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {tasks.map((task) => {
          const taskOutputs = outputsByTask[task.id] || [];
          const combinedRefIds = Array.from(
            new Set([...batch.referenceIds, ...task.referenceIds])
          );
          const resolvedRefs = combinedRefIds
            .map((id) => referencesMap[id])
            .filter(Boolean);

          const isRetrySelectable =
            task.status === 'failed' ||
            task.status === 'download_failed' ||
            task.status === 'needs_attention';
          const isExpanded = expandedTaskIds.has(task.id);
          const isEditing = editingTaskId === task.id;

          return (
            <div
              key={task.id}
              className={`task-card ${
                batch.activeTaskId === task.id ? 'active-task' : ''
              } ${task.status === 'failed' ? 'failed-task' : ''} ${
                task.status === 'needs_attention' ||
                task.status === 'download_failed'
                  ? 'attention-task'
                  : ''
              }`}
              data-testid={`task-card-${task.sequenceNumber}`}
            >
              {/* Top Row: Task #, Prompt Preview, Status Badge */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: '8px'
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '7px',
                    flex: 1,
                    minWidth: 0
                  }}
                >
                  {isRetrySelectable && (
                    <input
                      type="checkbox"
                      aria-label={`Select task #${task.sequenceNumber} for retry`}
                      checked={selectedFailedIds.has(task.id)}
                      onChange={() => toggleSelectFailed(task.id)}
                      style={{ marginTop: '3px' }}
                    />
                  )}
                  <span className="prompt-item-num">#{task.sequenceNumber}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {task.name && (
                      <div
                        style={{
                          fontSize: '11.5px',
                          fontWeight: 700,
                          color: 'var(--text-primary)'
                        }}
                      >
                        {task.name}
                      </div>
                    )}
                    {isEditing ? (
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '6px',
                          marginTop: '4px'
                        }}
                      >
                        <textarea
                          className="textarea"
                          value={editPromptValue}
                          onChange={(e) => setEditPromptValue(e.target.value)}
                          rows={2}
                        />
                        <div style={{ display: 'flex', gap: '6px' }}>
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            onClick={async () => {
                              if (editPromptValue.trim()) {
                                await onUpdateTaskPrompt(
                                  task.id,
                                  editPromptValue.trim()
                                );
                              }
                              setEditingTaskId(null);
                            }}
                          >
                            Save Prompt
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => setEditingTaskId(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div
                        style={{
                          fontSize: '12.5px',
                          color: 'var(--text-primary)',
                          wordBreak: 'break-word'
                        }}
                      >
                        {task.originalPrompt}
                      </div>
                    )}
                  </div>
                </div>

                <span
                  className={getStatusBadgeClass(task.status)}
                  data-testid={`task-status-${task.sequenceNumber}`}
                >
                  {task.status === 'completed' && <CheckCircle2 size={11} />}
                  {task.status === 'failed' && <XCircle size={11} />}
                  {(task.status === 'needs_attention' ||
                    task.status === 'download_failed') && (
                    <AlertTriangle size={11} />
                  )}
                  {task.friendlyStatus}
                </span>
              </div>

              {/* Reference Thumbnails Strip */}
              {resolvedRefs.length > 0 && (
                <div className="task-thumb-strip">
                  {resolvedRefs.map((ref) => (
                    <img
                      key={ref.id}
                      src={ref.thumbnailDataUrl}
                      alt={ref.name}
                      title={`${ref.name} (${ref.type})`}
                      className="task-mini-thumb"
                    />
                  ))}
                  <span
                    style={{
                      fontSize: '11px',
                      color: 'var(--text-secondary)'
                    }}
                  >
                    {resolvedRefs.length} reference
                    {resolvedRefs.length === 1 ? '' : 's'}
                  </span>
                </div>
              )}

              {/* Metadata Row: Duration, Download Status, Output Filenames */}
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '8px',
                  fontSize: '11.5px',
                  color: 'var(--text-secondary)'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span>Duration: {formatDuration(task, now)}</span>
                  {task.retryCount > 0 && (
                    <span>Retries: {task.retryCount}</span>
                  )}
                  {taskOutputs.length > 0 && (
                    <span>
                      Download:{' '}
                      {taskOutputs.every((o) => o.status === 'completed')
                        ? `Saved (${taskOutputs.map((o) => o.filename).join(', ')})`
                        : taskOutputs.map((o) => `${o.filename} [${o.status}]`).join(', ')}
                    </span>
                  )}
                </div>

                {/* Per-Task Actions */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => toggleExpandTask(task.id)}
                  >
                    <FileText size={11} />{' '}
                    {isExpanded ? 'Hide Details' : 'Prompt Preview'}
                  </button>

                  {(task.status === 'pending' ||
                    task.status === 'paused' ||
                    task.status === 'failed') &&
                    !isEditing && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => {
                          setEditingTaskId(task.id);
                          setEditPromptValue(task.originalPrompt);
                        }}
                      >
                        Edit
                      </button>
                    )}

                  {task.status === 'download_failed' && (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => onRetryDownloadOnly(task.id)}
                      data-testid={`retry-download-btn-${task.sequenceNumber}`}
                    >
                      <Download size={11} /> Retry Download
                    </button>
                  )}

                  {(task.status === 'failed' ||
                    task.status === 'needs_attention' ||
                    task.status === 'download_failed') && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => onRetrySingleTask(task.id)}
                      data-testid={`retry-task-btn-${task.sequenceNumber}`}
                    >
                      <RefreshCw size={11} /> Retry Generation
                    </button>
                  )}

                  {(task.status === 'pending' ||
                    task.status === 'needs_attention' ||
                    task.status === 'failed') && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => onSkipTask(task.id)}
                      title="Skip this task"
                    >
                      <SkipForward size={11} /> Skip
                    </button>
                  )}
                </div>
              </div>

              {/* Error Explanation & Recommended Recovery Action */}
              {task.lastError && (
                <div
                  className={
                    task.status === 'failed'
                      ? 'alert-banner alert-error'
                      : 'alert-banner alert-warning'
                  }
                  data-testid={`task-error-${task.sequenceNumber}`}
                >
                  <div>
                    <strong>{task.lastError.userMessage}</strong>
                  </div>
                  <div style={{ color: 'var(--text-secondary)' }}>
                    Recommended action: {task.lastError.recommendedAction}
                  </div>
                  {task.lastError.diagnostics && (
                    <div
                      style={{
                        marginTop: '4px',
                        fontSize: '11px',
                        fontFamily: 'monospace',
                        color: 'var(--text-muted)'
                      }}
                      data-testid={`task-error-diag-${task.sequenceNumber}`}
                    >
                      Technical diagnostic: {task.lastError.diagnostics}
                    </div>
                  )}
                </div>
              )}

              {/* Expanded Final Prompt Snapshot */}
              {isExpanded && (
                <div className="preview-box">
                  <div
                    style={{
                      fontWeight: 600,
                      marginBottom: '3px',
                      color: 'var(--text-primary)'
                    }}
                  >
                    Final Prompt Submitted to {platformLabel}:
                  </div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>
                    {task.finalPromptSnapshot}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Separate Technical Diagnostics Drawer */}
      <div className="card">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            cursor: 'pointer'
          }}
          onClick={() => {
            const next = !showDiagnostics;
            setShowDiagnostics(next);
            if (next && !tabDiagnostics) {
              refreshTabDiagnostics().catch(() => {});
            }
          }}
        >
          <span className="card-title">
            <Terminal size={14} /> Technical Diagnostics & Background Notes
          </span>
          <span className="badge badge-neutral">
            {showDiagnostics ? 'Hide' : `Show (${diagnosticLogs.length})`}
          </span>
        </div>

        {showDiagnostics && (
          <div
            style={{
              marginTop: '10px',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px'
            }}
          >
            <div className="preview-box">
              <strong>Background Operation & Limitations:</strong> Batch Studio
              runs your queue in a persistent Manifest V3 service worker so you
              can close this popup or switch tabs. Note that generation pauses if
              the browser is completely closed, the computer sleeps, your
              platform session expires, or the website requests human
              verification.
            </div>

            {/* Live Tab Connection Diagnostics */}
            <div
              style={{
                padding: '10px',
                borderRadius: '8px',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-subtle)',
                fontSize: '11.5px',
                display: 'flex',
                flexDirection: 'column',
                gap: '5px'
              }}
              data-testid="tab-diagnostics-panel"
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  fontWeight: 600,
                  color: 'var(--text-primary)'
                }}
              >
                <span>Live Browser Tab & Connection Diagnostics</span>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={refreshTabDiagnostics}
                  disabled={loadingTabDiag}
                  data-testid="refresh-tab-diag-btn"
                >
                  <RefreshCw size={11} /> {loadingTabDiag ? 'Checking...' : 'Check Tab Status'}
                </button>
              </div>

              {tabDiagnostics ? (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginTop: '4px' }}>
                  <div>
                    <span style={{ color: 'var(--text-secondary)' }}>Matching Tab: </span>
                    <strong style={{ color: tabDiagnostics.tabFound ? 'var(--status-success)' : 'var(--status-danger)' }}>
                      {tabDiagnostics.tabFound ? `Found (ID: ${tabDiagnostics.tabId})` : 'Not Found'}
                    </strong>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-secondary)' }}>Host / Domain: </span>
                    <strong>{tabDiagnostics.tabHostname || '—'}</strong>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-secondary)' }}>Tab State: </span>
                    <strong>{tabDiagnostics.tabStatus || '—'}</strong>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-secondary)' }}>Content Script: </span>
                    <strong style={{ color: tabDiagnostics.contentScriptResponding ? 'var(--status-success)' : 'var(--status-warning)' }}>
                      {tabDiagnostics.contentScriptResponding ? 'Responding (Ping OK)' : 'Not Responding'}
                    </strong>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-secondary)' }}>Connection State: </span>
                    <span className="badge badge-neutral">{tabDiagnostics.connectionState}</span>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-secondary)' }}>Host Permission: </span>
                    <strong style={{ color: tabDiagnostics.hasHostPermission ? 'var(--status-success)' : 'var(--status-danger)' }}>
                      {tabDiagnostics.hasHostPermission ? 'Granted' : 'Missing'}
                    </strong>
                  </div>
                  {tabDiagnostics.lastErrorMessage && (
                    <div style={{ gridColumn: 'span 2', color: 'var(--status-warning)' }}>
                      Note: {tabDiagnostics.lastErrorMessage}
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ color: 'var(--text-muted)' }}>
                  Click &quot;Check Tab Status&quot; to inspect live tab discovery, hostname, loading state, and content-script communication.
                </div>
              )}
            </div>
            <div
              style={{
                maxHeight: '160px',
                overflowY: 'auto',
                fontFamily: 'monospace',
                fontSize: '11px',
                background: 'var(--bg-input)',
                padding: '8px',
                borderRadius: '6px',
                border: '1px solid var(--border-subtle)'
              }}
            >
              {diagnosticLogs.length === 0 ? (
                <div style={{ color: 'var(--text-muted)' }}>
                  No diagnostic events recorded yet.
                </div>
              ) : (
                diagnosticLogs.map((log) => (
                  <div key={log.id} style={{ marginBottom: '4px' }}>
                    <span style={{ color: 'var(--text-muted)' }}>
                      [{new Date(log.timestamp).toLocaleTimeString()}]
                    </span>{' '}
                    <span style={{ fontWeight: 600 }}>[{log.scope}]</span>{' '}
                    {log.message}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
