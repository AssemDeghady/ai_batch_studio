export type PlatformId = 'chatgpt' | 'google_flow';

export type TaskType = 'image' | 'video';

export type FlowVideoMode =
  | 'text_to_video'
  | 'image_to_video'
  | 'start_end_frame'
  | 'reference_ingredients';

export type AspectRatio = '16:9' | '9:16' | '1:1';

export type VideoDurationSec = 4 | 5 | 6 | 8 | 10;

export type OutputCount = 1 | 2 | 3 | 4;

export type FlowModelId =
  | 'imagen_3'
  | 'imagen_3_fast'
  | 'veo_2'
  | 'veo_3_quality'
  | 'veo_3_fast';

export interface FlowModelCapability {
  id: FlowModelId;
  label: string;
  taskType: TaskType;
  supportedVideoModes: FlowVideoMode[];
  supportedAspectRatios: AspectRatio[];
  supportedDurations: VideoDurationSec[];
  supportedOutputCounts: OutputCount[];
  supportsReferences: boolean;
}

export const FLOW_MODEL_CAPABILITIES: Record<FlowModelId, FlowModelCapability> = {
  imagen_3: {
    id: 'imagen_3',
    label: 'Imagen 3 (Quality)',
    taskType: 'image',
    supportedVideoModes: [],
    supportedAspectRatios: ['16:9', '9:16', '1:1'],
    supportedDurations: [],
    supportedOutputCounts: [1, 2, 4],
    supportsReferences: true
  },
  imagen_3_fast: {
    id: 'imagen_3_fast',
    label: 'Imagen 3 Fast',
    taskType: 'image',
    supportedVideoModes: [],
    supportedAspectRatios: ['16:9', '9:16', '1:1'],
    supportedDurations: [],
    supportedOutputCounts: [1, 2, 4],
    supportsReferences: true
  },
  veo_2: {
    id: 'veo_2',
    label: 'Veo 2',
    taskType: 'video',
    supportedVideoModes: ['text_to_video', 'image_to_video', 'start_end_frame'],
    supportedAspectRatios: ['16:9', '9:16'],
    supportedDurations: [4, 5, 6, 8, 10],
    supportedOutputCounts: [1, 2, 3, 4],
    supportsReferences: true
  },
  veo_3_quality: {
    id: 'veo_3_quality',
    label: 'Veo 3 (Quality)',
    taskType: 'video',
    supportedVideoModes: [
      'text_to_video',
      'image_to_video',
      'start_end_frame',
      'reference_ingredients'
    ],
    supportedAspectRatios: ['16:9', '9:16'],
    supportedDurations: [8],
    supportedOutputCounts: [1, 2],
    supportsReferences: true
  },
  veo_3_fast: {
    id: 'veo_3_fast',
    label: 'Veo 3 Fast',
    taskType: 'video',
    supportedVideoModes: ['text_to_video', 'image_to_video', 'reference_ingredients'],
    supportedAspectRatios: ['16:9', '9:16'],
    supportedDurations: [5, 8],
    supportedOutputCounts: [1, 2, 4],
    supportsReferences: true
  }
};

export type ReferenceType =
  | 'character'
  | 'art_style'
  | 'environment'
  | 'start_frame'
  | 'end_frame'
  | 'general';

export const REFERENCE_TYPE_LABELS: Record<ReferenceType, string> = {
  character: 'Character reference',
  art_style: 'Art-style reference',
  environment: 'Environment reference',
  start_frame: 'Starting frame',
  end_frame: 'Ending frame',
  general: 'General reference'
};

export type TaskStatus =
  | 'pending'
  | 'queued'
  | 'connecting'
  | 'inspecting'
  | 'preparing'
  | 'composer_verified'
  | 'prompt_entered'
  | 'submitting'
  | 'submitted'
  | 'awaiting_generation'
  | 'generating'
  | 'result_detected'
  | 'downloading'
  | 'completed'
  | 'submission_failed'
  | 'generation_failed'
  | 'download_failed'
  | 'failed'
  | 'paused'
  | 'needs_attention'
  | 'cancelled'
  | 'skipped';

export type BatchStatus =
  | 'draft'
  | 'ready'
  | 'running'
  | 'paused'
  | 'completed'
  | 'stopped'
  | 'needs_attention';

export type OutputStatus =
  | 'pending'
  | 'requested'
  | 'in_progress'
  | 'completed'
  | 'interrupted'
  | 'cancelled'
  | 'needs_attention';

export type ErrorCode =
  | 'WEBSITE_UNAVAILABLE'
  | 'WRONG_PAGE'
  | 'LOGIN_REQUIRED'
  | 'VERIFICATION_REQUIRED'
  | 'CONTROLS_NOT_FOUND'
  | 'REFERENCE_UPLOAD_FAILED'
  | 'SUBMISSION_UNCERTAIN'
  | 'GENERATION_TIMEOUT'
  | 'GENERATION_FAILED'
  | 'RESULT_NOT_IDENTIFIED'
  | 'DOWNLOAD_UNAVAILABLE'
  | 'DOWNLOAD_INTERRUPTED'
  | 'SAVE_DESTINATION_UNAVAILABLE'
  | 'PERMISSION_REVOKED'
  | 'STORAGE_QUOTA_EXCEEDED'
  | 'BROWSER_RESTART'
  | 'SERVICE_WORKER_RESTART'
  | 'DUPLICATE_SUBMISSION_RISK'
  | 'INTERFACE_CHANGED'
  | 'UNSUPPORTED_VIDEO_MODE'
  | 'PAGE_CLOSED_OR_NAVIGATED'
  | 'TAB_NOT_FOUND'
  | 'TAB_LOADING'
  | 'CONTENT_SCRIPT_NOT_READY'
  | 'FLOW_NOT_READY'
  | 'PERMISSION_ERROR'
  | 'COMMUNICATION_ERROR'
  | 'FLOW_TAB_NOT_FOUND'
  | 'FLOW_CONTENT_SCRIPT_UNAVAILABLE'
  | 'FLOW_COMPOSER_NOT_FOUND'
  | 'FLOW_COMPOSER_NOT_EDITABLE'
  | 'FLOW_PROMPT_ENTRY_FAILED'
  | 'FLOW_SUBMIT_CONTROL_NOT_FOUND'
  | 'FLOW_SUBMIT_CONTROL_AMBIGUOUS'
  | 'FLOW_SUBMISSION_UNCONFIRMED';

export type TabConnectionState =
  | 'tab_not_found'
  | 'tab_loading'
  | 'content_script_not_ready'
  | 'flow_not_ready'
  | 'ready'
  | 'permission_error'
  | 'communication_error';

export interface PlatformTabDiagnostics {
  platformId: PlatformId;
  connectionState: TabConnectionState;
  tabFound: boolean;
  tabId?: number;
  tabUrl?: string;
  tabHostname?: string;
  tabStatus?: 'loading' | 'complete' | string;
  windowId?: number;
  hasHostPermission: boolean;
  contentScriptResponding: boolean;
  lastErrorMessage?: string;
  checkedAt: number;
}

export interface TaskErrorInfo {
  code: ErrorCode;
  userMessage: string;
  recommendedAction: string;
  retryableGeneration: boolean;
  retryableDownload: boolean;
  diagnostics?: string;
  occurredAt: number;
}

export interface AutoNumberingSettings {
  enabled: boolean;
  startNumber: number;
  paddingDigits: number;
  separator: string;
}

export type SaveDestinationMode = 'downloads_subfolder' | 'filesystem_handle';

export interface DownloadSettings {
  saveMode: SaveDestinationMode;
  subfolder: string;
  customDirectoryName?: string;
  filenameTemplate: string;
  autoNumbering: AutoNumberingSettings;
  conflictAction: 'uniquify' | 'prompt';
}

export type TimeoutPolicyAction = 'keep_waiting' | 'mark_failed' | 'auto_retry';

export interface TimeoutSettings {
  initialObservationMinSec: number;
  initialObservationMaxSec: number;
  maxImageTimeoutSec: number;
  maxVideoTimeoutSec: number;
  pollIntervalSec: number;
  timeoutPolicy: TimeoutPolicyAction;
  maxAutoRetries: number;
}

export interface GenerationSettings {
  model?: FlowModelId;
  videoMode?: FlowVideoMode;
  aspectRatio?: AspectRatio;
  durationSec?: VideoDurationSec;
  outputCount?: OutputCount;
  overridePrefix?: string | null;
  disableGlobalPrefix?: boolean;
}

export interface ReferenceRecord {
  id: string;
  name: string;
  type: ReferenceType;
  mimeType: string;
  size: number;
  storageKey: string;
  thumbnailDataUrl: string;
  createdAt: number;
}

export interface ReferenceBlobRecord {
  storageKey: string;
  dataUrl: string;
  mimeType: string;
  size: number;
  createdAt: number;
}

export interface OutputRecord {
  id: string;
  batchId: string;
  taskId: string;
  platform: PlatformId;
  type: TaskType;
  index: number;
  assignedSequenceNumber?: number;
  originalPrompt: string;
  finalSubmittedPrompt: string;
  generationStatus: 'completed' | 'failed' | 'unknown';
  status: OutputStatus;
  filename: string;
  sourceUrl?: string;
  previewUrl?: string;
  thumbnailDataUrl?: string;
  downloadMethod?: 'chrome_downloads' | 'native_button' | 'filesystem_api';
  downloadId?: number;
  retryCount: number;
  createdAt: number;
  completedAt?: number;
  error?: string;
}

export interface TaskRecord {
  id: string;
  batchId: string;
  sequenceNumber: number;
  name?: string;
  originalPrompt: string;
  finalPromptSnapshot: string;
  platform: PlatformId;
  taskType: TaskType;
  status: TaskStatus;
  friendlyStatus: string;
  referenceIds: string[];
  generationSettings: GenerationSettings;
  createdAt: number;
  updatedAt: number;
  submittedAt?: number;
  completedAt?: number;
  pausedElapsedMs?: number;
  retryCount: number;
  timeoutAt?: number;
  initialObservationUntil?: number;
  outputIds: string[];
  lastError?: TaskErrorInfo;
}

export interface BatchRecord {
  id: string;
  name: string;
  platform: PlatformId;
  taskType: TaskType;
  status: BatchStatus;
  globalPrefix: string;
  prefixEnabled: boolean;
  prefixSeparator: string;
  referenceIds: string[];
  taskIds: string[];
  defaultGenerationSettings: GenerationSettings;
  downloadSettings: DownloadSettings;
  timeoutSettings: TimeoutSettings;
  activeTaskId?: string;
  targetTabId?: number;
  nextOutputSequenceNumber: number;
  circuitBreakerLimit?: number;
  consecutiveFailureCount?: number;
  maxConcurrency?: number;
  createdAt: number;
  updatedAt: number;
}

export interface PreferencesRecord {
  defaultPlatform: PlatformId;
  defaultTaskType: TaskType;
  sharedPrefix: string;
  prefixEnabled: boolean;
  prefixSeparator: string;
  downloadPreferences: DownloadSettings;
  timeoutSettings: TimeoutSettings;
  defaultGenerationSettings: GenerationSettings;
  theme: 'light' | 'dark' | 'system';
  notificationsEnabled: boolean;
  soundEnabled: boolean;
  circuitBreakerLimit: number;
  maxConcurrency: number;
  globalOutputCounter: number;
}

export interface DiagnosticLogEntry {
  id: string;
  timestamp: number;
  level: 'info' | 'warn' | 'error';
  scope: 'queue' | 'adapter' | 'download' | 'storage' | 'background';
  message: string;
  batchId?: string;
  taskId?: string;
  details?: string;
}

export const DEFAULT_DOWNLOAD_SETTINGS: DownloadSettings = {
  saveMode: 'downloads_subfolder',
  subfolder: 'BatchStudio',
  filenameTemplate: '{number}_{project}_{date}',
  autoNumbering: {
    enabled: true,
    startNumber: 1,
    paddingDigits: 3,
    separator: '_'
  },
  conflictAction: 'uniquify'
};

export const DEFAULT_TIMEOUT_SETTINGS: TimeoutSettings = {
  initialObservationMinSec: 10,
  initialObservationMaxSec: 15,
  maxImageTimeoutSec: 180,
  maxVideoTimeoutSec: 420,
  pollIntervalSec: 3,
  timeoutPolicy: 'keep_waiting',
  maxAutoRetries: 2
};

export const DEFAULT_GENERATION_SETTINGS: GenerationSettings = {
  model: 'imagen_3',
  videoMode: 'text_to_video',
  aspectRatio: '16:9',
  durationSec: 5,
  outputCount: 1,
  overridePrefix: null,
  disableGlobalPrefix: false
};

export const DEFAULT_PREFERENCES: PreferencesRecord = {
  defaultPlatform: 'chatgpt',
  defaultTaskType: 'image',
  sharedPrefix: '',
  prefixEnabled: true,
  prefixSeparator: '\n\n',
  downloadPreferences: DEFAULT_DOWNLOAD_SETTINGS,
  timeoutSettings: DEFAULT_TIMEOUT_SETTINGS,
  defaultGenerationSettings: DEFAULT_GENERATION_SETTINGS,
  theme: 'dark',
  notificationsEnabled: true,
  soundEnabled: true,
  circuitBreakerLimit: 3,
  maxConcurrency: 1,
  globalOutputCounter: 1
};
