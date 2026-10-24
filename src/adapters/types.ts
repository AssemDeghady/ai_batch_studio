import {
  ErrorCode,
  GenerationSettings,
  PlatformId,
  TaskRecord,
  TaskType
} from '../types/models';
import { ResolvedReferenceAttachment } from '../core/referenceManager';
import { ObservablePlatformGenerationState } from '../core/timeoutPolicy';

export interface PlatformAvailabilityResult {
  available: boolean;
  authenticated: boolean;
  correctPage: boolean;
  requestedModeAvailable: boolean;
  friendlyMessage: string;
  errorCode?: ErrorCode;
  recommendedAction?: string;
  diagnostics?: string;
}

export interface AdapterSubmissionOptions {
  maxWaitMs?: number;
  simulateTypingPause?: boolean;
}

export interface AdapterSubmissionResult {
  submitted: boolean;
  errorCode?: ErrorCode;
  userMessage?: string;
  recommendedAction?: string;
  diagnostics?: string;
}

export interface DetectedPlatformAsset {
  index: number;
  type: TaskType;
  url?: string;
  extension: string;
  mimeType?: string;
  hasNativeDownloadButton: boolean;
  elementSelectorId?: string;
}

export interface AdapterStatusInspection {
  state: ObservablePlatformGenerationState;
  detectedAssets: DetectedPlatformAsset[];
  errorCode?: ErrorCode;
  userMessage?: string;
  recommendedAction?: string;
  diagnostics?: string;
}

export interface AdapterDownloadActionResult {
  initiated: boolean;
  method: 'chrome_downloads' | 'native_button' | 'manual_fallback';
  resolvedUrl?: string;
  errorCode?: ErrorCode;
  userMessage?: string;
}

export interface PlatformAdapter {
  readonly platformId: PlatformId;
  initialize(): Promise<void>;
  checkAvailability(
    taskType?: TaskType,
    settings?: GenerationSettings
  ): Promise<PlatformAvailabilityResult>;
  attachReferences(
    task: TaskRecord,
    references: ResolvedReferenceAttachment[]
  ): Promise<{ attached: boolean; errorCode?: ErrorCode; userMessage?: string; diagnostics?: string }>;
  submitTask(
    task: TaskRecord,
    references: ResolvedReferenceAttachment[],
    options?: AdapterSubmissionOptions
  ): Promise<AdapterSubmissionResult>;
  getTaskStatus(task: TaskRecord): Promise<AdapterStatusInspection>;
  getResults(task: TaskRecord): Promise<DetectedPlatformAsset[]>;
  downloadResult(
    asset: DetectedPlatformAsset,
    suggestedFilename: string
  ): Promise<AdapterDownloadActionResult>;
  recoverTask(task: TaskRecord): Promise<AdapterStatusInspection>;
  dispose(): Promise<void>;
}
