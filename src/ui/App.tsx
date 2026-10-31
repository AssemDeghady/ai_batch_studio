import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  FileSpreadsheet,
  FolderOpen,
  Image as ImageIcon,
  Layers,
  ListChecks,
  Moon,
  Play,
  Plus,
  Sparkles,
  Sun,
  Trash2,
  Upload,
  Video
} from 'lucide-react';
import {
  buildOutputFilename,
  formatRelativeDownloadPath,
  validateFilenameTemplate
} from '../core/fileNaming';
import { composeFinalPrompt } from '../core/prefixComposer';
import {
  expandAllPromptLines,
  ParsedPromptDraft,
  parseCsvPrompts,
  parsePlainTextPrompts,
  PromptParseValidationError
} from '../core/promptParser';
import { playAttentionChime, playCompletionChime } from './soundEffects';
import {
  createBatchWithTasks,
  reorderBatchTasks,
  updateTaskPromptAndSettings
} from '../core/queueEngine';
import {
  addReferenceImage,
  deleteReference,
  getAllReferences,
  matchReferenceNamesToIds,
  reorderReferenceIds,
  updateReferenceType
} from '../core/referenceManager';
import { setCustomDirectoryHandle } from '../downloads/downloadManager';
import {
  deleteBatchCascade,
  getAllBatches,
  getBatch,
  getOutputsByBatch,
  getRecentDiagnosticLogs,
  getTasksByBatch
} from '../storage/db';
import {
  getActiveBatchId,
  getPreferences,
  savePreferences,
  setActiveBatchId
} from '../storage/preferences';
import {
  AspectRatio,
  BatchRecord,
  DEFAULT_DOWNLOAD_SETTINGS,
  DEFAULT_GENERATION_SETTINGS,
  DEFAULT_TIMEOUT_SETTINGS,
  DiagnosticLogEntry,
  DownloadSettings,
  FLOW_MODEL_CAPABILITIES,
  FlowModelId,
  FlowVideoMode,
  GenerationSettings,
  OutputCount,
  OutputRecord,
  PlatformId,
  REFERENCE_TYPE_LABELS,
  ReferenceRecord,
  ReferenceType,
  TaskRecord,
  TaskType,
  TimeoutPolicyAction,
  TimeoutSettings,
  VideoDurationSec
} from '../types/models';
import { dispatchBackgroundCommand } from './backgroundClient';
import { QueueView } from './components/QueueView';

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'studio' | 'queue'>('studio');
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  // Primary Studio Configuration State
  const [batchName, setBatchName] = useState('Desert_Story');
  const [platform, setPlatform] = useState<PlatformId>('chatgpt');
  const [taskType, setTaskType] = useState<TaskType>('image');
  const [generationSettings, setGenerationSettings] = useState<GenerationSettings>(
    DEFAULT_GENERATION_SETTINGS
  );

  // Prompt Management State
  const [promptDrafts, setPromptDrafts] = useState<ParsedPromptDraft[]>([]);
  const [taskRefsMap, setLinkTaskRefsMap] = useState<Record<number, string[]>>({});
  const [pasteModalOpen, setPasteModalOpen] = useState(true);
  const [rawPasteText, setRawPasteText] = useState('');
  const [importFeedback, setImportFeedback] = useState<{
    message: string;
    errors: PromptParseValidationError[];
  } | null>(null);
  const [editingDraftIndex, setEditingDraftIndex] = useState<number | null>(null);
  const [editingDraftText, setEditingDraftText] = useState('');

  // Shared Instructions / Global Prefix State
  const [globalPrefix, setGlobalPrefix] = useState('');
  const [prefixEnabled, setPrefixEnabled] = useState(true);
  const [prefixSeparator, setPrefixSeparator] = useState('\n\n');

  // Reference Images State
  const [allReferences, setAllReferences] = useState<ReferenceRecord[]>([]);
  const [sharedReferenceIds, setSharedReferenceIds] = useState<string[]>([]);
  const [refError, setRefError] = useState<string | null>(null);

  // Save Destination & File Naming State
  const [downloadSettings, setDownloadSettings] = useState<DownloadSettings>(
    DEFAULT_DOWNLOAD_SETTINGS
  );

  // Advanced Settings (Collapsed by default!)
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [timeoutSettings, setTimeoutSettings] = useState<TimeoutSettings>(
    DEFAULT_TIMEOUT_SETTINGS
  );
  const [circuitBreakerLimit, setCircuitBreakerLimit] = useState(3);
  const [maxConcurrency, setMaxConcurrency] = useState(1);
  const [soundEnabled, setSoundEnabled] = useState(true);

  // Queue & Saved Batches State
  const [recentBatches, setRecentBatches] = useState<BatchRecord[]>([]);
  const [activeBatch, setActiveBatch] = useState<BatchRecord | null>(null);
  const [activeTasks, setActiveTasks] = useState<TaskRecord[]>([]);
  const [outputsByTask, setOutputsByTask] = useState<Record<string, OutputRecord[]>>({});
  const [diagnosticLogs, setDiagnosticLogs] = useState<DiagnosticLogEntry[]>([]);
  const [bannerError, setBannerError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const jsonFileInputRef = useRef<HTMLInputElement | null>(null);
  const refUploadInputRef = useRef<HTMLInputElement | null>(null);
  const prevBatchStatusRef = useRef<string | undefined>(undefined);
  const feedbackTimerRef = useRef<NodeJS.Timeout | null>(null);

  const setFeedbackWithAutoDismiss = (
    fb: { message: string; errors: PromptParseValidationError[] } | null,
    autoDismissMs = 6000
  ) => {
    if (feedbackTimerRef.current) {
      clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = null;
    }
    setImportFeedback(fb);
    if (fb && fb.errors.length === 0 && autoDismissMs > 0) {
      feedbackTimerRef.current = setTimeout(() => {
        setImportFeedback(null);
        feedbackTimerRef.current = null;
      }, autoDismissMs);
    }
  };

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current) {
        clearTimeout(feedbackTimerRef.current);
      }
    };
  }, []);

  // Load initial preferences, references, and batches
  const refreshData = async () => {
    const [prefs, refs, batches, logs, savedActiveId] = await Promise.all([
      getPreferences(),
      getAllReferences(),
      getAllBatches(),
      getRecentDiagnosticLogs(60),
      getActiveBatchId()
    ]);

    setAllReferences(refs);
    setRecentBatches(batches);
    setDiagnosticLogs(logs);

    if (savedActiveId) {
      const b = await getBatch(savedActiveId);
      if (b) {
        const [tList, oList] = await Promise.all([
          getTasksByBatch(b.id),
          getOutputsByBatch(b.id)
        ]);
        setActiveBatch(b);
        setActiveTasks(tList);
        const grouped: Record<string, OutputRecord[]> = {};
        for (const o of oList) {
          if (!grouped[o.taskId]) grouped[o.taskId] = [];
          grouped[o.taskId].push(o);
        }
        setOutputsByTask(grouped);
      }
    }

    return prefs;
  };

  useEffect(() => {
    refreshData().then((prefs) => {
      const resolvedTheme = prefs.theme === 'light' ? 'light' : 'dark';
      setTheme(resolvedTheme);
      document.documentElement.setAttribute('data-theme', resolvedTheme);
      setPlatform(prefs.defaultPlatform);
      setTaskType(
        prefs.defaultPlatform === 'chatgpt' ? 'image' : prefs.defaultTaskType
      );
      setGlobalPrefix(prefs.sharedPrefix);
      setPrefixEnabled(prefs.prefixEnabled);
      setPrefixSeparator(prefs.prefixSeparator || '\n\n');
      setDownloadSettings(prefs.downloadPreferences);
      setTimeoutSettings(prefs.timeoutSettings);
      setCircuitBreakerLimit(prefs.circuitBreakerLimit ?? 3);
      setMaxConcurrency(prefs.maxConcurrency ?? 1);
      setSoundEnabled(prefs.soundEnabled ?? true);
      setGenerationSettings(prefs.defaultGenerationSettings);
    });
  }, []);

  // Listen for background state updates while Queue tab is open
  useEffect(() => {
    const interval = setInterval(() => {
      if (activeBatch) {
        refreshData().catch(() => {});
      }
    }, 2000);

    const listener = (msg: { type?: string }) => {
      if (msg && msg.type === 'BS_STATE_UPDATED') {
        refreshData().catch(() => {});
      }
    };
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener(listener);
    }
    return () => {
      clearInterval(interval);
      if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
        chrome.runtime.onMessage.removeListener(listener);
      }
    };
  }, [activeBatch?.id]);

  // Audio chime effect on batch completion or attention needed
  useEffect(() => {
    if (activeBatch) {
      if (
        prevBatchStatusRef.current === 'running' &&
        activeBatch.status === 'completed'
      ) {
        if (soundEnabled) playCompletionChime();
      } else if (
        prevBatchStatusRef.current === 'running' &&
        (activeBatch.status === 'needs_attention' ||
          (activeBatch.status === 'paused' &&
            (activeBatch.consecutiveFailureCount || 0) >=
              (activeBatch.circuitBreakerLimit ?? 3)))
      ) {
        if (soundEnabled) playAttentionChime();
      }
      prevBatchStatusRef.current = activeBatch.status;
    } else {
      prevBatchStatusRef.current = undefined;
    }
  }, [activeBatch?.status, activeBatch?.consecutiveFailureCount, soundEnabled]);

  const handleExportBatchJson = () => {
    const exportBatch = activeBatch || {
      name: batchName,
      platform,
      taskType,
      globalPrefix,
      prefixEnabled,
      prefixSeparator,
      defaultGenerationSettings: generationSettings,
      downloadSettings,
      timeoutSettings,
      circuitBreakerLimit,
      maxConcurrency
    };

    const promptsToExport =
      activeTasks.length > 0
        ? activeTasks.map((t) => ({
            sequenceNumber: t.sequenceNumber,
            prompt: t.originalPrompt,
            name: t.name,
            generationSettings: t.generationSettings
          }))
        : promptDrafts.map((d) => ({
            sequenceNumber: d.index,
            prompt: d.prompt,
            name: d.name,
            generationSettings: d.generationSettings
          }));

    const exportPayload = {
      version: 1,
      app: 'AI Batch Studio',
      exportedAt: new Date().toISOString(),
      batch: exportBatch,
      prompts: promptsToExport
    };

    const blob = new Blob([JSON.stringify(exportPayload, null, 2)], {
      type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeName = (exportBatch.name || 'batch').replace(/[^a-zA-Z0-9_-]/g, '_');
    a.download = `${safeName}_backup.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportBatchJson = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      if (!data.batch && !data.prompts) {
        throw new Error('Invalid Batch Studio JSON backup file format.');
      }

      if (data.batch) {
        if (data.batch.name) setBatchName(data.batch.name);
        if (data.batch.platform) setPlatform(data.batch.platform);
        if (data.batch.taskType) setTaskType(data.batch.taskType);
        if (data.batch.globalPrefix !== undefined) setGlobalPrefix(data.batch.globalPrefix);
        if (data.batch.prefixEnabled !== undefined) setPrefixEnabled(data.batch.prefixEnabled);
        if (data.batch.prefixSeparator) setPrefixSeparator(data.batch.prefixSeparator);
        if (data.batch.defaultGenerationSettings || data.batch.generationSettings) {
          setGenerationSettings(data.batch.defaultGenerationSettings || data.batch.generationSettings);
        }
        if (data.batch.downloadSettings) setDownloadSettings(data.batch.downloadSettings);
        if (data.batch.timeoutSettings) setTimeoutSettings(data.batch.timeoutSettings);
        if (data.batch.circuitBreakerLimit) setCircuitBreakerLimit(data.batch.circuitBreakerLimit);
        if (data.batch.maxConcurrency) setMaxConcurrency(data.batch.maxConcurrency);
      }

      if (Array.isArray(data.prompts)) {
        const drafts: ParsedPromptDraft[] = data.prompts
          .map((p: any, idx: number) => ({
            index: idx + 1,
            prompt: typeof p === 'string' ? p : p.prompt || '',
            name: typeof p === 'object' ? p.name : undefined,
            referenceNames: [],
            generationSettings:
              typeof p === 'object' && p.generationSettings
                ? p.generationSettings
                : {}
          }))
          .filter((d: ParsedPromptDraft) => d.prompt.trim().length > 0);

        setPromptDrafts(drafts);
        setFeedbackWithAutoDismiss({
          message: `Successfully imported batch "${data.batch?.name || file.name}" with ${drafts.length} prompt(s).`,
          errors: []
        });
      }

      setActiveTab('studio');
    } catch (err: any) {
      setFeedbackWithAutoDismiss(
        {
          message: err.message || 'Failed to parse JSON file.',
          errors: [{ row: 1, message: err.message || 'JSON parse error' }]
        },
        0
      );
    } finally {
      if (e.target) e.target.value = '';
    }
  };

  const toggleTheme = async () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    await savePreferences({ theme: next });
  };

  // Platform & Mode switching
  const handleSelectPlatform = async (nextPlatform: PlatformId) => {
    setPlatform(nextPlatform);
    let nextType = taskType;
    if (nextPlatform === 'chatgpt') {
      nextType = 'image';
      setTaskType('image');
    }
    await savePreferences({
      defaultPlatform: nextPlatform,
      defaultTaskType: nextType
    });
  };

  const handleSelectTaskType = async (nextType: TaskType) => {
    if (platform === 'chatgpt' && nextType === 'video') return;
    setTaskType(nextType);
    const defaultModel: FlowModelId =
      nextType === 'video' ? 'veo_2' : 'imagen_3';
    const cap = FLOW_MODEL_CAPABILITIES[defaultModel];
    setGenerationSettings((prev) => ({
      ...prev,
      model: defaultModel,
      videoMode: cap.supportedVideoModes[0] || 'text_to_video',
      aspectRatio: cap.supportedAspectRatios[0] || '16:9',
      durationSec: cap.supportedDurations[0] || 5,
      outputCount: cap.supportedOutputCounts[0] || 1
    }));
    await savePreferences({ defaultTaskType: nextType });
  };

  const handleSelectFlowModel = (modelId: FlowModelId) => {
    const cap = FLOW_MODEL_CAPABILITIES[modelId];
    if (!cap) return;
    setGenerationSettings((prev) => ({
      ...prev,
      model: modelId,
      videoMode:
        prev.videoMode && cap.supportedVideoModes.includes(prev.videoMode)
          ? prev.videoMode
          : cap.supportedVideoModes[0],
      aspectRatio:
        prev.aspectRatio && cap.supportedAspectRatios.includes(prev.aspectRatio)
          ? prev.aspectRatio
          : cap.supportedAspectRatios[0],
      durationSec:
        prev.durationSec && cap.supportedDurations.includes(prev.durationSec)
          ? prev.durationSec
          : cap.supportedDurations[0],
      outputCount:
        prev.outputCount && cap.supportedOutputCounts.includes(prev.outputCount)
          ? prev.outputCount
          : cap.supportedOutputCounts[0]
    }));
  };

  // Prompt Paste & File Import Handlers
  const handleAddPastedPrompts = () => {
    const parsed = parsePlainTextPrompts(rawPasteText);
    if (parsed.items.length === 0) {
      setFeedbackWithAutoDismiss({
        message: 'No non-empty prompts were found in the pasted text.',
        errors: []
      });
      return;
    }
    setPromptDrafts((prev) => {
      const combined = [...prev, ...parsed.items];
      return combined.map((item, idx) => ({ ...item, index: idx + 1 }));
    });
    setRawPasteText('');
    setPasteModalOpen(false);
    setFeedbackWithAutoDismiss({
      message: `Added ${parsed.items.length} prompt(s)${
        parsed.skippedBlankLines > 0
          ? ` (${parsed.skippedBlankLines} blank line(s) ignored)`
          : ''
      }.`,
      errors: []
    });
  };

  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const isCsv = file.name.toLowerCase().endsWith('.csv');
    const result = isCsv
      ? parseCsvPrompts(text)
      : parsePlainTextPrompts(text);

    if (result.items.length > 0) {
      const startOffset = promptDrafts.length;
      const newRefMap: Record<number, string[]> = { ...taskRefsMap };

      for (let i = 0; i < result.items.length; i++) {
        const draft = result.items[i];
        if (draft.referenceNames.length > 0) {
          const { matchedIds } = await matchReferenceNamesToIds(
            draft.referenceNames
          );
          if (matchedIds.length > 0) {
            newRefMap[startOffset + i] = matchedIds;
          }
        }
      }

      setLinkTaskRefsMap(newRefMap);
      setPromptDrafts((prev) =>
        [...prev, ...result.items].map((it, idx) => ({
          ...it,
          index: idx + 1
        }))
      );
    }

    setPasteModalOpen(false);
    setFeedbackWithAutoDismiss(
      {
        message: `Imported ${result.items.length} prompt(s) from "${file.name}"${
          result.skippedBlankLines > 0
            ? ` (${result.skippedBlankLines} blank row(s) skipped)`
            : ''
        }.`,
        errors: result.errors
      },
      result.errors.length === 0 ? 6000 : 0
    );
    e.target.value = '';
  };

  const handleRemoveDraft = (idx: number) => {
    setPromptDrafts((prev) =>
      prev
        .filter((_, i) => i !== idx)
        .map((item, i) => ({ ...item, index: i + 1 }))
    );
  };

  const handleMoveDraft = (fromIdx: number, toIdx: number) => {
    if (toIdx < 0 || toIdx >= promptDrafts.length) return;
    setPromptDrafts((prev) => {
      const copy = [...prev];
      const [moved] = copy.splice(fromIdx, 1);
      copy.splice(toIdx, 0, moved);
      return copy.map((item, i) => ({ ...item, index: i + 1 }));
    });
  };

  const toggleTaskSpecificRef = (draftIdx: number, refId: string) => {
    setLinkTaskRefsMap((prev) => {
      const current = prev[draftIdx] || [];
      const next = current.includes(refId)
        ? current.filter((id) => id !== refId)
        : [...current, refId];
      return { ...prev, [draftIdx]: next };
    });
  };

  // Reference Image Upload Handlers
  const handleUploadReferences = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    setRefError(null);
    const files = Array.from(e.target.files || []);
    for (const file of files) {
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = () => reject(new Error('Failed to read file'));
          reader.readAsDataURL(file);
        });
        const record = await addReferenceImage({
          name: file.name,
          mimeType: file.type,
          size: file.size,
          dataUrl,
          type: 'general'
        });
        setAllReferences((prev) => [...prev, record]);
        setSharedReferenceIds((prev) =>
          prev.includes(record.id) ? prev : [...prev, record.id]
        );
      } catch (err) {
        setRefError(
          err instanceof Error ? err.message : 'Failed to attach reference image.'
        );
      }
    }
    e.target.value = '';
  };

  const handleChooseCustomDirectory = async () => {
    try {
      const anyWin = window as unknown as {
        showDirectoryPicker?: (opts?: {
          mode?: 'readwrite';
        }) => Promise<FileSystemDirectoryHandle>;
      };
      if (typeof anyWin.showDirectoryPicker !== 'function') {
        setBannerError(
          'Browser Directory Picker is unavailable in this view. Using relative subfolder under your Chrome Downloads folder.'
        );
        return;
      }
      const handle = await anyWin.showDirectoryPicker({ mode: 'readwrite' });
      setCustomDirectoryHandle(handle);
      const nextDl: DownloadSettings = {
        ...downloadSettings,
        saveMode: 'filesystem_handle',
        customDirectoryName: handle.name
      };
      setDownloadSettings(nextDl);
      await savePreferences({ downloadPreferences: nextDl });
    } catch {
      // User cancelled picker
    }
  };

  // Create & Start Batch
  const handleCreateAndStartBatch = async (startImmediately: boolean) => {
    setBannerError(null);

    // If user typed prompts in paste textarea without clicking "Add Prompts", include them automatically
    let effectiveDrafts = [...promptDrafts];
    if (effectiveDrafts.length === 0 && rawPasteText.trim()) {
      const parsed = parsePlainTextPrompts(rawPasteText);
      effectiveDrafts = parsed.items;
      setPromptDrafts(effectiveDrafts);
      setRawPasteText('');
    }

    if (effectiveDrafts.length === 0) {
      setBannerError('Please enter or import at least one prompt before starting.');
      return;
    }

    const templateValidation = validateFilenameTemplate(
      downloadSettings.filenameTemplate,
      downloadSettings.autoNumbering.enabled
    );
    if (!templateValidation.valid) {
      setBannerError(templateValidation.errors[0]);
      return;
    }

    await savePreferences({
      defaultPlatform: platform,
      defaultTaskType: taskType,
      sharedPrefix: globalPrefix,
      prefixEnabled,
      prefixSeparator,
      downloadPreferences: downloadSettings,
      timeoutSettings,
      circuitBreakerLimit,
      maxConcurrency,
      soundEnabled,
      defaultGenerationSettings: generationSettings
    });

    const { batch, tasks } = await createBatchWithTasks({
      name: batchName,
      platform,
      taskType,
      prompts: effectiveDrafts,
      globalPrefix,
      prefixEnabled,
      prefixSeparator,
      sharedReferenceIds,
      taskReferenceIdsMap: taskRefsMap,
      defaultGenerationSettings: generationSettings,
      downloadSettings,
      timeoutSettings,
      circuitBreakerLimit,
      maxConcurrency
    });

    setActiveBatch(batch);
    setActiveTasks(tasks);
    setActiveTab('queue');

    // Auto-clear Studio drafts after successfully creating / adding batch in queue
    setPromptDrafts([]);
    setRawPasteText('');
    setFeedbackWithAutoDismiss(null);
    setPasteModalOpen(false);
    setLinkTaskRefsMap({});
    setEditingDraftIndex(null);
    setBannerError(null);

    if (startImmediately) {
      await dispatchBackgroundCommand({
        type: 'BS_BG_START_BATCH',
        batchId: batch.id
      });
    }
    await refreshData();
  };

  // Sample Preview Computations
  const samplePrompt =
    promptDrafts[0]?.prompt ||
    rawPasteText.split('\n').find((l) => l.trim()) ||
    'Camel at sunset in cinematic golden hour';

  const composedSamplePrompt = composeFinalPrompt({
    originalPrompt: samplePrompt,
    globalPrefix,
    prefixEnabled,
    separator: prefixSeparator,
    taskSettings: generationSettings
  });

  const templateCheck = validateFilenameTemplate(
    downloadSettings.filenameTemplate,
    downloadSettings.autoNumbering.enabled
  );

  const sampleFilename = templateCheck.valid
    ? buildOutputFilename({
        template: downloadSettings.filenameTemplate,
        projectName: batchName || 'Batch',
        prompt: samplePrompt,
        sequenceNumber: downloadSettings.autoNumbering.startNumber || 1,
        extension: taskType === 'video' ? 'mp4' : 'png',
        autoNumbering: downloadSettings.autoNumbering
      })
    : 'invalid_template';

  const sampleDestinationPath = formatRelativeDownloadPath(
    downloadSettings.subfolder,
    sampleFilename,
    { projectName: batchName }
  );

  // Determine available models and capabilities for Google Flow
  const availableFlowModels = Object.values(FLOW_MODEL_CAPABILITIES).filter(
    (m) => m.taskType === taskType
  );
  const selectedModelCap =
    FLOW_MODEL_CAPABILITIES[
      generationSettings.model ||
        (taskType === 'video' ? 'veo_2' : 'imagen_3')
    ] || availableFlowModels[0];

  const referencesMap: Record<string, ReferenceRecord> = {};
  for (const r of allReferences) {
    referencesMap[r.id] = r;
  }

  return (
    <div className="studio-shell">
      {/* Studio Header */}
      <header className="studio-header">
        <div className="brand-row">
          <img
            src="icons/icon-48.png"
            alt="AI Batch Studio"
            className="brand-logo-img"
          />
          <div>
            <h1 className="brand-title">AI Batch Studio</h1>
            <p className="brand-subtitle">
              AI Image & Video Queue for ChatGPT & Google Flow
            </p>
          </div>
        </div>

        <div className="header-actions">
          <button
            type="button"
            className="btn btn-icon"
            onClick={toggleTheme}
            title={`Switch to ${theme === 'dark' ? 'Light' : 'Dark'} theme`}
            aria-label="Toggle theme"
          >
            {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
          </button>
          <button
            type="button"
            className="btn btn-icon"
            onClick={() => {
              if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
                chrome.tabs.create({
                  url: chrome.runtime.getURL('index.html')
                });
              } else {
                window.open(window.location.href, '_blank');
              }
            }}
            title="Open AI Batch Studio in a full browser tab"
            aria-label="Open full browser tab"
          >
            <ExternalLink size={14} />
          </button>
        </div>
      </header>

      {/* Navigation Tabs */}
      <nav className="nav-tabs" aria-label="Main navigation">
        <button
          type="button"
          className={`nav-tab ${activeTab === 'studio' ? 'active' : ''}`}
          onClick={() => setActiveTab('studio')}
          data-testid="nav-tab-studio"
        >
          <Layers size={14} /> Batch Setup
        </button>
        <button
          type="button"
          className={`nav-tab ${activeTab === 'queue' ? 'active' : ''}`}
          onClick={() => setActiveTab('queue')}
          data-testid="nav-tab-queue"
        >
          <ListChecks size={14} /> Queue Monitor
          {activeBatch && (
            <span className="badge badge-info" style={{ marginLeft: '4px' }}>
              {activeTasks.filter((t) => t.status === 'completed').length}/
              {activeTasks.length}
            </span>
          )}
        </button>
      </nav>

      {/* Main Content */}
      <main className="studio-main">
        {bannerError && (
          <div className="alert-banner alert-error" role="alert">
            <strong>Attention needed:</strong> {bannerError}
          </div>
        )}

        {activeTab === 'studio' ? (
          <>
            {/* 1. Platform & Generation Mode Selector */}
            <section className="card">
              <div className="card-header">
                <div>
                  <h2 className="card-title">1. Platform & Generation Mode</h2>
                  <p className="card-subtitle">
                    Reuses your existing signed-in browser session
                  </p>
                </div>
                <span className="badge badge-neutral">
                  {platform === 'chatgpt' ? 'ChatGPT' : 'Google Flow'}
                </span>
              </div>

              <div className="grid-2" style={{ marginBottom: '10px' }}>
                <button
                  type="button"
                  className={`choice-pill ${
                    platform === 'chatgpt' ? 'selected' : ''
                  }`}
                  onClick={() => handleSelectPlatform('chatgpt')}
                  data-testid="select-platform-chatgpt"
                >
                  <span className="choice-pill-title">
                    <Sparkles size={14} /> ChatGPT
                  </span>
                  <span className="choice-pill-desc">
                    Batch image generation with reference attachments
                  </span>
                </button>

                <button
                  type="button"
                  className={`choice-pill ${
                    platform === 'google_flow' ? 'selected' : ''
                  }`}
                  onClick={() => handleSelectPlatform('google_flow')}
                  data-testid="select-platform-google-flow"
                >
                  <span className="choice-pill-title">
                    <Video size={14} /> Google Flow
                  </span>
                  <span className="choice-pill-desc">
                    Batch image & video generation (Imagen 3 & Veo)
                  </span>
                </button>
              </div>

              {/* Generation Type Selector */}
              <div className="grid-2">
                <button
                  type="button"
                  className={`choice-pill ${
                    taskType === 'image' ? 'selected' : ''
                  }`}
                  onClick={() => handleSelectTaskType('image')}
                  data-testid="select-mode-image"
                >
                  <span className="choice-pill-title">
                    <ImageIcon size={14} /> Image Generation
                  </span>
                  <span className="choice-pill-desc">
                    Sequential image batch & auto-download
                  </span>
                </button>

                <button
                  type="button"
                  className={`choice-pill ${
                    taskType === 'video' ? 'selected' : ''
                  }`}
                  disabled={platform === 'chatgpt'}
                  onClick={() => handleSelectTaskType('video')}
                  data-testid="select-mode-video"
                  style={
                    platform === 'chatgpt'
                      ? { opacity: 0.45, cursor: 'not-allowed' }
                      : undefined
                  }
                >
                  <span className="choice-pill-title">
                    <Video size={14} /> Video Generation
                  </span>
                  <span className="choice-pill-desc">
                    {platform === 'chatgpt'
                      ? 'Select Google Flow to enable video generation'
                      : 'Text-to-video, frame & ingredient workflows'}
                  </span>
                </button>
              </div>

              {/* Google Flow Dynamic Settings (Workflow, Aspect Ratio, Duration, Output Count) */}
              {platform === 'google_flow' && (
                <div
                  style={{
                    marginTop: '12px',
                    paddingTop: '10px',
                    borderTop: '1px solid var(--border-subtle)'
                  }}
                  data-testid="flow-model-controls"
                >
                  {taskType === 'video' && (
                    <div style={{ marginBottom: '8px' }}>
                      <div className="field-group">
                        <label
                          className="field-label"
                          htmlFor="flow-video-mode-select"
                        >
                          Video Workflow
                        </label>
                        <select
                          id="flow-video-mode-select"
                          className="select"
                          value={
                            generationSettings.videoMode || 'text_to_video'
                          }
                          onChange={(e) =>
                            setGenerationSettings((prev) => ({
                              ...prev,
                              videoMode: e.target.value as FlowVideoMode
                            }))
                          }
                        >
                          <option value="text_to_video">Text-to-Video</option>
                          <option value="image_to_video">Image-to-Video</option>
                          <option value="start_end_frame">Start & End Frame</option>
                          <option value="reference_ingredients">Reference Ingredients</option>
                        </select>
                      </div>
                    </div>
                  )}

                  <div className={taskType === 'video' ? 'grid-3' : 'grid-2'}>
                    <div className="field-group">
                      <label className="field-label" htmlFor="flow-aspect-select">
                        Aspect Ratio
                      </label>
                      <select
                        id="flow-aspect-select"
                        className="select"
                        value={
                          generationSettings.aspectRatio || '16:9'
                        }
                        onChange={(e) =>
                          setGenerationSettings((prev) => ({
                            ...prev,
                            aspectRatio: e.target.value as AspectRatio
                          }))
                        }
                      >
                        <option value="16:9">16:9</option>
                        <option value="9:16">9:16</option>
                        {taskType === 'image' && (
                          <>
                            <option value="1:1">1:1</option>
                            <option value="4:3">4:3</option>
                            <option value="3:4">3:4</option>
                          </>
                        )}
                      </select>
                    </div>

                    {taskType === 'video' && (
                      <div className="field-group">
                        <label
                          className="field-label"
                          htmlFor="flow-duration-select"
                        >
                          Duration
                        </label>
                        <select
                          id="flow-duration-select"
                          className="select"
                          value={
                            generationSettings.durationSec || 4
                          }
                          onChange={(e) =>
                            setGenerationSettings((prev) => ({
                              ...prev,
                              durationSec: Number(
                                e.target.value
                              ) as VideoDurationSec
                            }))
                          }
                        >
                          <option value={4}>4 seconds</option>
                          <option value={5}>5 seconds</option>
                          <option value={6}>6 seconds</option>
                          <option value={8}>8 seconds</option>
                          <option value={10}>10 seconds</option>
                        </select>
                      </div>
                    )}

                    <div className="field-group">
                      <label className="field-label" htmlFor="flow-count-select">
                        Outputs per Task
                      </label>
                      <select
                        id="flow-count-select"
                        className="select"
                        value={
                          generationSettings.outputCount || 1
                        }
                        onChange={(e) =>
                          setGenerationSettings((prev) => ({
                            ...prev,
                            outputCount: Number(e.target.value) as OutputCount
                          }))
                        }
                      >
                        <option value={1}>1 output</option>
                        <option value={2}>2 outputs</option>
                        <option value={3}>3 outputs</option>
                        <option value={4}>4 outputs</option>
                      </select>
                    </div>
                  </div>
                </div>
              )}
            </section>

            {/* 2. Batch Name & Prompt Manager */}
            <section className="card">
              <div className="card-header">
                <div>
                  <h2 className="card-title">2. Prompts</h2>
                  <p className="card-subtitle">
                    Import TXT (1 prompt per line), CSV, or paste multiple lines
                  </p>
                </div>
                <span className="badge badge-info" data-testid="prompt-count-badge">
                  {promptDrafts.length}{' '}
                  {promptDrafts.length === 1 ? 'prompt' : 'prompts'} queued
                </span>
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="batch-name-input">
                  Batch / Project Name
                </label>
                <input
                  id="batch-name-input"
                  className="input"
                  value={batchName}
                  onChange={(e) => setBatchName(e.target.value)}
                  placeholder="e.g. Desert_Story"
                />
              </div>

              {/* Import & Paste Controls */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '8px' }}>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".txt,.csv,text/plain,text/csv"
                  style={{ display: 'none' }}
                  onChange={handleFileImport}
                  data-testid="file-import-input"
                />
                <input
                  ref={jsonFileInputRef}
                  type="file"
                  accept=".json,application/json"
                  style={{ display: 'none' }}
                  onChange={handleImportBatchJson}
                  data-testid="json-import-input"
                />
                <button
                  type="button"
                  className="btn"
                  onClick={() => fileInputRef.current?.click()}
                  data-testid="import-prompts-btn"
                >
                  <FileSpreadsheet size={14} /> Import TXT / CSV
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => jsonFileInputRef.current?.click()}
                  data-testid="import-json-btn"
                >
                  <Upload size={14} /> Import Batch (.json)
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={handleExportBatchJson}
                  data-testid="export-json-btn"
                >
                  <Download size={14} /> Export Batch (.json)
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setPasteModalOpen(!pasteModalOpen)}
                  data-testid="paste-prompts-toggle-btn"
                >
                  <Plus size={14} /> Paste Prompts
                </button>
                {promptDrafts.length > 0 && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ marginLeft: 'auto' }}
                    onClick={() => {
                      setPromptDrafts([]);
                      setLinkTaskRefsMap({});
                      setFeedbackWithAutoDismiss(null);
                      setRawPasteText('');
                      setEditingDraftIndex(null);
                    }}
                  >
                    Clear All
                  </button>
                )}
              </div>

              {pasteModalOpen && (
                <div className="field-group">
                  <textarea
                    className="textarea"
                    placeholder={
                      'Paste one prompt per line (supports permutations like {red, blue} sports car on {beach, street}):\nA lone nomad crossing golden sand dunes at sunset\nClose-up portrait of the nomad looking toward a starry oasis'
                    }
                    value={rawPasteText}
                    onChange={(e) => setRawPasteText(e.target.value)}
                    rows={3}
                    data-testid="paste-prompts-textarea"
                  />
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: '8px',
                      marginTop: '4px'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span
                        style={{
                          fontSize: '11px',
                          color: 'var(--text-secondary)'
                        }}
                      >
                        Blank lines are automatically skipped.
                      </span>
                      {rawPasteText.includes('{') && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => {
                            const expanded = expandAllPromptLines(rawPasteText);
                            setRawPasteText(expanded);
                            const count = expanded.split('\n').filter((l) => l.trim()).length;
                            setFeedbackWithAutoDismiss({
                              message: `Expanded variations into ${count} prompts.`,
                              errors: []
                            });
                          }}
                          data-testid="expand-variations-btn"
                          title="Expand {option1, option2} permutations into separate prompt lines"
                        >
                          <Sparkles size={12} /> Expand Variations
                        </button>
                      )}
                    </div>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={handleAddPastedPrompts}
                      disabled={!rawPasteText.trim()}
                      data-testid="add-pasted-prompts-btn"
                    >
                      <Plus size={12} /> Add to Batch
                    </button>
                  </div>
                </div>
              )}

              {/* Import & Validation Feedback */}
              {importFeedback && (
                <div
                  className={
                    importFeedback.errors.length > 0
                      ? 'alert-banner alert-warning'
                      : 'alert-banner alert-info'
                  }
                  style={{
                    marginTop: '6px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start'
                  }}
                  data-testid="import-feedback-banner"
                >
                  <div style={{ flex: 1 }}>
                    <div>{importFeedback.message}</div>
                    {importFeedback.errors.map((err, i) => (
                      <div
                        key={i}
                        style={{ color: 'var(--status-danger)', fontSize: '11.5px' }}
                      >
                        • {err.message}
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    style={{
                      padding: '0 6px',
                      marginLeft: '8px',
                      background: 'none',
                      border: 'none',
                      color: 'inherit',
                      opacity: 0.7,
                      fontSize: '16px',
                      lineHeight: '1',
                      cursor: 'pointer'
                    }}
                    onClick={() => setFeedbackWithAutoDismiss(null)}
                    title="Dismiss"
                    aria-label="Dismiss message"
                  >
                    ×
                  </button>
                </div>
              )}

              {/* Parsed Prompts List Editor */}
              {promptDrafts.length > 0 && (
                <div className="prompt-list" data-testid="parsed-prompt-list">
                  {promptDrafts.map((item, idx) => (
                    <div key={idx} className="prompt-item">
                      <span className="prompt-item-num">#{idx + 1}</span>
                      <div className="prompt-item-body">
                        {editingDraftIndex === idx ? (
                          <div style={{ display: 'flex', gap: '6px' }}>
                            <input
                              className="input"
                              value={editingDraftText}
                              onChange={(e) => setEditingDraftText(e.target.value)}
                            />
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              onClick={() => {
                                if (editingDraftText.trim()) {
                                  setPromptDrafts((prev) =>
                                    prev.map((p, i) =>
                                      i === idx
                                        ? { ...p, prompt: editingDraftText.trim() }
                                        : p
                                    )
                                  );
                                }
                                setEditingDraftIndex(null);
                              }}
                            >
                              Save
                            </button>
                          </div>
                        ) : (
                          <div
                            style={{
                              fontSize: '12.5px',
                              wordBreak: 'break-word'
                            }}
                          >
                            {item.name && (
                              <strong style={{ marginRight: '6px' }}>
                                [{item.name}]
                              </strong>
                            )}
                            {item.prompt}
                          </div>
                        )}

                        {/* Per-task reference assignment pills */}
                        {allReferences.length > 0 && (
                          <div
                            style={{
                              display: 'flex',
                              flexWrap: 'wrap',
                              gap: '4px',
                              marginTop: '5px'
                            }}
                          >
                            {allReferences.map((ref) => {
                              const isTaskAttached = (
                                taskRefsMap[idx] || []
                              ).includes(ref.id);
                              return (
                                <button
                                  key={ref.id}
                                  type="button"
                                  className="token-chip"
                                  style={
                                    isTaskAttached
                                      ? {
                                          borderColor: 'var(--accent-primary)',
                                          color: 'var(--accent-primary)'
                                        }
                                      : undefined
                                  }
                                  onClick={() =>
                                    toggleTaskSpecificRef(idx, ref.id)
                                  }
                                  title="Toggle task-specific reference image"
                                >
                                  {isTaskAttached ? '✓ ' : '+ '}
                                  {ref.name}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      <div style={{ display: 'flex', gap: '4px' }}>
                        <button
                          type="button"
                          className="btn btn-icon btn-sm"
                          onClick={() => handleMoveDraft(idx, idx - 1)}
                          disabled={idx === 0}
                          title="Move up"
                        >
                          <ArrowUp size={11} />
                        </button>
                        <button
                          type="button"
                          className="btn btn-icon btn-sm"
                          onClick={() => handleMoveDraft(idx, idx + 1)}
                          disabled={idx === promptDrafts.length - 1}
                          title="Move down"
                        >
                          <ArrowDown size={11} />
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => {
                            setEditingDraftIndex(idx);
                            setEditingDraftText(item.prompt);
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-icon btn-sm"
                          onClick={() => handleRemoveDraft(idx)}
                          title="Remove prompt"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* 3. Shared Reference Images Manager */}
            <section className="card">
              <div className="card-header">
                <div>
                  <h2 className="card-title">3. Shared Reference Images</h2>
                  <p className="card-subtitle">
                    Attach character, style, or frame references reused across tasks
                  </p>
                </div>
                <div>
                  <input
                    ref={refUploadInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    multiple
                    style={{ display: 'none' }}
                    onChange={handleUploadReferences}
                    data-testid="reference-upload-input"
                  />
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => refUploadInputRef.current?.click()}
                    data-testid="upload-reference-btn"
                  >
                    <Upload size={12} /> Add Images
                  </button>
                </div>
              </div>

              {refError && (
                <div className="alert-banner alert-error" style={{ marginBottom: '8px' }}>
                  {refError}
                </div>
              )}

              {allReferences.length === 0 ? (
                <div className="preview-box" style={{ textAlign: 'center' }}>
                  No reference images attached yet. Optional: upload character,
                  art-style, or starting/ending frame references.
                </div>
              ) : (
                <div className="ref-grid">
                  {allReferences.map((ref, idx) => {
                    const isShared = sharedReferenceIds.includes(ref.id);
                    return (
                      <div key={ref.id} className="ref-card">
                        <img
                          src={ref.thumbnailDataUrl}
                          alt={ref.name}
                          className="ref-thumb"
                        />
                        <div
                          style={{
                            fontSize: '11px',
                            fontWeight: 600,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis'
                          }}
                          title={ref.name}
                        >
                          {ref.name}
                        </div>
                        <select
                          className="select"
                          style={{ padding: '3px 6px', fontSize: '11px' }}
                          value={ref.type}
                          onChange={async (e) => {
                            const updated = await updateReferenceType(
                              ref.id,
                              e.target.value as ReferenceType
                            );
                            setAllReferences((prev) =>
                              prev.map((r) => (r.id === ref.id ? updated : r))
                            );
                          }}
                        >
                          {Object.entries(REFERENCE_TYPE_LABELS).map(
                            ([val, label]) => (
                              <option key={val} value={val}>
                                {label}
                              </option>
                            )
                          )}
                        </select>
                        <label
                          className="checkbox-row"
                          style={{ fontSize: '11px' }}
                        >
                          <input
                            type="checkbox"
                            checked={isShared}
                            onChange={() =>
                              setSharedReferenceIds((prev) =>
                                prev.includes(ref.id)
                                  ? prev.filter((id) => id !== ref.id)
                                  : [...prev, ref.id]
                              )
                            }
                          />
                          Shared on all tasks
                        </label>
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            gap: '4px'
                          }}
                        >
                          <button
                            type="button"
                            className="btn btn-icon btn-sm"
                            disabled={idx === 0}
                            onClick={() => {
                              setSharedReferenceIds((prev) =>
                                reorderReferenceIds(prev, idx, idx - 1)
                              );
                            }}
                            title="Move earlier"
                          >
                            <ArrowUp size={10} />
                          </button>
                          <button
                            type="button"
                            className="btn btn-icon btn-sm"
                            onClick={async () => {
                              await deleteReference(ref.id);
                              setAllReferences((prev) =>
                                prev.filter((r) => r.id !== ref.id)
                              );
                              setSharedReferenceIds((prev) =>
                                prev.filter((id) => id !== ref.id)
                              );
                            }}
                            title="Delete reference"
                          >
                            <Trash2 size={11} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* 4. Global Prompt Prefix (Shared Instructions) */}
            <section className="card">
              <div className="card-header">
                <div>
                  <h2 className="card-title">
                    4. Shared Instructions (Global Prompt Prefix)
                  </h2>
                  <p className="card-subtitle">
                    Prepended once per submission without altering original prompts
                  </p>
                </div>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={prefixEnabled}
                    onChange={(e) => setPrefixEnabled(e.target.checked)}
                    data-testid="prefix-enabled-checkbox"
                  />
                  Enabled
                </label>
              </div>

              <div className="field-group">
                <textarea
                  className="textarea"
                  placeholder="Maintain consistent character appearance, use the attached reference images, preserve the established art style, and follow the specified composition."
                  value={globalPrefix}
                  onChange={(e) => setGlobalPrefix(e.target.value)}
                  disabled={!prefixEnabled}
                  rows={2}
                  data-testid="global-prefix-textarea"
                />
              </div>

              {prefixEnabled && globalPrefix.trim() && (
                <div className="preview-box" data-testid="final-prompt-preview">
                  <strong style={{ color: 'var(--text-primary)' }}>
                    Final Prompt Preview:
                  </strong>{' '}
                  {composedSamplePrompt}
                </div>
              )}
            </section>

            {/* 5. Save Destination, Custom File Naming & Optional Auto-Numbering */}
            <section className="card">
              <div className="card-header">
                <div>
                  <h2 className="card-title">5. Save Destination & File Naming</h2>
                  <p className="card-subtitle">
                    Configure output folder, filename template, and numbering
                  </p>
                </div>
                <span className="badge badge-neutral">
                  {downloadSettings.autoNumbering.enabled
                    ? 'Auto-Numbering On'
                    : 'Auto-Numbering Off'}
                </span>
              </div>

              <div className="grid-2">
                <div className="field-group">
                  <label className="field-label" htmlFor="subfolder-input">
                    Subfolder inside Chrome Downloads
                  </label>
                  <input
                    id="subfolder-input"
                    className="input"
                    value={downloadSettings.subfolder}
                    onChange={(e) =>
                      setDownloadSettings((prev) => ({
                        ...prev,
                        saveMode: 'downloads_subfolder',
                        subfolder: e.target.value
                      }))
                    }
                    placeholder="BatchStudio"
                  />
                </div>

                <div className="field-group">
                  <label className="field-label" htmlFor="filename-template-input">
                    Filename Template
                  </label>
                  <input
                    id="filename-template-input"
                    className="input"
                    value={downloadSettings.filenameTemplate}
                    onChange={(e) =>
                      setDownloadSettings((prev) => ({
                        ...prev,
                        filenameTemplate: e.target.value
                      }))
                    }
                    placeholder="{number}_{project}_{date}"
                  />
                </div>
              </div>

              {/* Variable Token Chips */}
              <div className="token-chips">
                {['{project}', '{number}', '{prompt}', '{date}', '{time}'].map(
                  (token) => (
                    <button
                      key={token}
                      type="button"
                      className="token-chip"
                      onClick={() =>
                        setDownloadSettings((prev) => ({
                          ...prev,
                          filenameTemplate: `${prev.filenameTemplate}_${token}`
                        }))
                      }
                    >
                      + {token}
                    </button>
                  )
                )}
              </div>

              {/* Independent Automatic Numbering Toggle & Controls */}
              <div
                style={{
                  marginTop: '10px',
                  paddingTop: '10px',
                  borderTop: '1px solid var(--border-subtle)'
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: '8px'
                  }}
                >
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={downloadSettings.autoNumbering.enabled}
                      onChange={(e) =>
                        setDownloadSettings((prev) => ({
                          ...prev,
                          autoNumbering: {
                            ...prev.autoNumbering,
                            enabled: e.target.checked
                          }
                        }))
                      }
                      data-testid="auto-numbering-checkbox"
                    />
                    <strong>Enable Automatic Sequential Numbering</strong>
                  </label>
                </div>

                {downloadSettings.autoNumbering.enabled && (
                  <div className="grid-3">
                    <div className="field-group">
                      <label className="field-label" htmlFor="start-num-input">
                        Start Number
                      </label>
                      <input
                        id="start-num-input"
                        type="number"
                        min={0}
                        className="input"
                        value={downloadSettings.autoNumbering.startNumber}
                        onChange={(e) =>
                          setDownloadSettings((prev) => ({
                            ...prev,
                            autoNumbering: {
                              ...prev.autoNumbering,
                              startNumber: Math.max(0, Number(e.target.value))
                            }
                          }))
                        }
                      />
                    </div>

                    <div className="field-group">
                      <label className="field-label" htmlFor="padding-input">
                        Digit Padding
                      </label>
                      <input
                        id="padding-input"
                        type="number"
                        min={1}
                        max={6}
                        className="input"
                        value={downloadSettings.autoNumbering.paddingDigits}
                        onChange={(e) =>
                          setDownloadSettings((prev) => ({
                            ...prev,
                            autoNumbering: {
                              ...prev.autoNumbering,
                              paddingDigits: Math.max(
                                1,
                                Math.min(6, Number(e.target.value))
                              )
                            }
                          }))
                        }
                      />
                    </div>

                    <div className="field-group">
                      <label className="field-label" htmlFor="sep-input">
                        Separator
                      </label>
                      <input
                        id="sep-input"
                        className="input"
                        maxLength={3}
                        value={downloadSettings.autoNumbering.separator}
                        onChange={(e) =>
                          setDownloadSettings((prev) => ({
                            ...prev,
                            autoNumbering: {
                              ...prev.autoNumbering,
                              separator: e.target.value
                            }
                          }))
                        }
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Template Validation & Live Filename Preview */}
              {!templateCheck.valid ? (
                <div
                  className="alert-banner alert-error"
                  style={{ marginTop: '8px' }}
                  data-testid="template-error-banner"
                >
                  {templateCheck.errors.join(' ')}
                </div>
              ) : (
                <div
                  className="preview-box"
                  style={{ marginTop: '8px' }}
                  data-testid="filename-preview-box"
                >
                  <div>
                    <strong style={{ color: 'var(--text-primary)' }}>
                      Save Destination Preview:
                    </strong>{' '}
                    <code>Downloads/{sampleDestinationPath}</code>
                  </div>
                  <div style={{ marginTop: '3px', fontSize: '11px' }}>
                    Chrome saves automatic downloads inside your browser&apos;s
                    configured Downloads folder (or a relative subfolder beneath
                    it). Existing files are never silently overwritten.
                  </div>
                </div>
              )}
            </section>

            {/* 6. Advanced Settings (Collapsed by Default) */}
            <section className="card">
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  cursor: 'pointer'
                }}
                onClick={() => setShowAdvanced(!showAdvanced)}
                data-testid="toggle-advanced-settings"
              >
                <span className="card-title">
                  {showAdvanced ? (
                    <ChevronDown size={15} />
                  ) : (
                    <ChevronRight size={15} />
                  )}
                  Advanced Timing, Timeout & Directory Options
                </span>
                <span className="badge badge-neutral">
                  {timeoutSettings.initialObservationMinSec}–
                  {timeoutSettings.initialObservationMaxSec}s initial window
                </span>
              </div>

              {showAdvanced && (
                <div
                  style={{
                    marginTop: '12px',
                    paddingTop: '10px',
                    borderTop: '1px solid var(--border-subtle)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px'
                  }}
                  data-testid="advanced-settings-panel"
                >
                  <div className="grid-2">
                    <div className="field-group">
                      <label className="field-label" htmlFor="obs-min-input">
                        Initial Observation Min (sec)
                      </label>
                      <input
                        id="obs-min-input"
                        type="number"
                        min={3}
                        max={120}
                        className="input"
                        value={timeoutSettings.initialObservationMinSec}
                        onChange={(e) =>
                          setTimeoutSettings((prev) => ({
                            ...prev,
                            initialObservationMinSec: Math.max(
                              3,
                              Number(e.target.value)
                            )
                          }))
                        }
                      />
                    </div>

                    <div className="field-group">
                      <label className="field-label" htmlFor="obs-max-input">
                        Initial Observation Max (sec)
                      </label>
                      <input
                        id="obs-max-input"
                        type="number"
                        min={5}
                        max={180}
                        className="input"
                        value={timeoutSettings.initialObservationMaxSec}
                        onChange={(e) =>
                          setTimeoutSettings((prev) => ({
                            ...prev,
                            initialObservationMaxSec: Math.max(
                              prev.initialObservationMinSec,
                              Number(e.target.value)
                            )
                          }))
                        }
                      />
                    </div>
                  </div>

                  <div className="grid-2">
                    <div className="field-group">
                      <label
                        className="field-label"
                        htmlFor="max-image-timeout-input"
                      >
                        Max Image Timeout (sec)
                      </label>
                      <input
                        id="max-image-timeout-input"
                        type="number"
                        min={30}
                        max={900}
                        className="input"
                        value={timeoutSettings.maxImageTimeoutSec}
                        onChange={(e) =>
                          setTimeoutSettings((prev) => ({
                            ...prev,
                            maxImageTimeoutSec: Math.max(
                              30,
                              Number(e.target.value)
                            )
                          }))
                        }
                      />
                    </div>

                    <div className="field-group">
                      <label
                        className="field-label"
                        htmlFor="max-video-timeout-input"
                      >
                        Max Video Timeout (sec)
                      </label>
                      <input
                        id="max-video-timeout-input"
                        type="number"
                        min={60}
                        max={1800}
                        className="input"
                        value={timeoutSettings.maxVideoTimeoutSec}
                        onChange={(e) =>
                          setTimeoutSettings((prev) => ({
                            ...prev,
                            maxVideoTimeoutSec: Math.max(
                              60,
                              Number(e.target.value)
                            )
                          }))
                        }
                      />
                    </div>
                  </div>

                  <div className="grid-2">
                    <div className="field-group">
                      <label
                        className="field-label"
                        htmlFor="timeout-policy-select"
                      >
                        When Max Timeout Elapses
                      </label>
                      <select
                        id="timeout-policy-select"
                        className="select"
                        value={timeoutSettings.timeoutPolicy}
                        onChange={(e) =>
                          setTimeoutSettings((prev) => ({
                            ...prev,
                            timeoutPolicy: e.target.value as TimeoutPolicyAction
                          }))
                        }
                      >
                        <option value="keep_waiting">
                          Keep waiting / Pause for inspection
                        </option>
                        <option value="mark_failed">
                          Mark failed & offer Retry (if idle)
                        </option>
                        <option value="auto_retry">
                          Auto-retry when safe (idle only)
                        </option>
                      </select>
                    </div>

                    <div className="field-group">
                      <label
                        className="field-label"
                        htmlFor="max-auto-retries-input"
                      >
                        Max Automatic Retries
                      </label>
                      <input
                        id="max-auto-retries-input"
                        type="number"
                        min={0}
                        max={5}
                        className="input"
                        value={timeoutSettings.maxAutoRetries}
                        onChange={(e) =>
                          setTimeoutSettings((prev) => ({
                            ...prev,
                            maxAutoRetries: Math.max(
                              0,
                              Math.min(5, Number(e.target.value))
                            )
                          }))
                        }
                      />
                    </div>
                  </div>

                  <div className="grid-2">
                    <div className="field-group">
                      <label
                        className="field-label"
                        htmlFor="circuit-breaker-limit-input"
                      >
                        Circuit Breaker Limit (Failures Before Pause)
                      </label>
                      <input
                        id="circuit-breaker-limit-input"
                        type="number"
                        min={1}
                        max={10}
                        className="input"
                        value={circuitBreakerLimit}
                        onChange={(e) =>
                          setCircuitBreakerLimit(Math.max(1, Math.min(10, Number(e.target.value))))
                        }
                        data-testid="circuit-breaker-input"
                      />
                    </div>

                    <div className="field-group">
                      <label
                        className="field-label"
                        htmlFor="max-concurrency-select"
                      >
                        Queue Concurrency
                      </label>
                      <select
                        id="max-concurrency-select"
                        className="select"
                        value={maxConcurrency}
                        onChange={(e) => setMaxConcurrency(Number(e.target.value))}
                        data-testid="concurrency-select"
                      >
                        <option value={1}>Sequential (1 task at a time)</option>
                        <option value={2}>Concurrent (up to 2 tasks)</option>
                      </select>
                    </div>
                  </div>

                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '4px 0'
                    }}
                  >
                    <input
                      id="sound-enabled-checkbox"
                      type="checkbox"
                      checked={soundEnabled}
                      onChange={(e) => setSoundEnabled(e.target.checked)}
                      data-testid="sound-enabled-checkbox"
                    />
                    <label
                      htmlFor="sound-enabled-checkbox"
                      className="field-label"
                      style={{ marginBottom: 0, cursor: 'pointer', userSelect: 'none' }}
                    >
                      Play synthesized audio chime on batch completion or attention needed
                    </label>
                  </div>

                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      paddingTop: '6px'
                    }}
                  >
                    <span
                      style={{
                        fontSize: '11.5px',
                        color: 'var(--text-secondary)'
                      }}
                    >
                      Optional File System Access API Directory (Full Studio Tab):
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={handleChooseCustomDirectory}
                    >
                      <FolderOpen size={12} /> Select Custom Folder
                    </button>
                  </div>
                </div>
              )}
            </section>

            {/* Primary Start Action */}
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                type="button"
                className="btn btn-primary btn-start-hero"
                onClick={() => handleCreateAndStartBatch(true)}
                data-testid="start-batch-btn"
              >
                <Play size={16} /> Start Batch Queue
              </button>
              <button
                type="button"
                className="btn"
                style={{ whiteSpace: 'nowrap' }}
                onClick={() => handleCreateAndStartBatch(false)}
                data-testid="save-draft-batch-btn"
              >
                Save Batch
              </button>
            </div>

            {/* Recent / Saved Batches Section */}
            {recentBatches.length > 0 && (
              <section className="card">
                <div className="card-header">
                  <h2 className="card-title">Recent & Saved Batches</h2>
                  <span className="badge badge-neutral">
                    {recentBatches.length} saved
                  </span>
                </div>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px'
                  }}
                >
                  {recentBatches.slice(0, 6).map((b) => (
                    <div
                      key={b.id}
                      className="prompt-item"
                      style={{ alignItems: 'center' }}
                    >
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600 }}>{b.name}</div>
                        <div
                          style={{
                            fontSize: '11px',
                            color: 'var(--text-secondary)'
                          }}
                        >
                          {b.platform === 'chatgpt' ? 'ChatGPT' : 'Google Flow'}{' '}
                          • {b.taskType} • {b.taskIds.length} tasks •{' '}
                          {b.status}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={async () => {
                          await setActiveBatchId(b.id);
                          await refreshData();
                          setActiveTab('queue');
                        }}
                        data-testid={`open-batch-${b.id}`}
                      >
                        Open Queue
                      </button>
                      <button
                        type="button"
                        className="btn btn-icon btn-sm"
                        onClick={async () => {
                          await deleteBatchCascade(b.id);
                          if (activeBatch?.id === b.id) {
                            setActiveBatch(null);
                            setActiveTasks([]);
                          }
                          await refreshData();
                        }}
                        title="Delete batch"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        ) : activeBatch ? (
          <QueueView
            batch={activeBatch}
            tasks={activeTasks}
            outputsByTask={outputsByTask}
            referencesMap={referencesMap}
            diagnosticLogs={diagnosticLogs}
            onStart={async () => {
              await dispatchBackgroundCommand({
                type: 'BS_BG_START_BATCH',
                batchId: activeBatch.id
              });
              await refreshData();
            }}
            onPause={async () => {
              await dispatchBackgroundCommand({
                type: 'BS_BG_PAUSE_BATCH',
                batchId: activeBatch.id
              });
              await refreshData();
            }}
            onResume={async () => {
              await dispatchBackgroundCommand({
                type: 'BS_BG_RESUME_BATCH',
                batchId: activeBatch.id
              });
              await refreshData();
            }}
            onStop={async () => {
              await dispatchBackgroundCommand({
                type: 'BS_BG_STOP_BATCH',
                batchId: activeBatch.id
              });
              await refreshData();
            }}
            onRetrySingleTask={async (taskId) => {
              await dispatchBackgroundCommand({
                type: 'BS_BG_RETRY_TASK',
                batchId: activeBatch.id,
                taskId
              });
              await refreshData();
            }}
            onRetrySelectedTasks={async (taskIds) => {
              await dispatchBackgroundCommand({
                type: 'BS_BG_RETRY_SELECTED',
                batchId: activeBatch.id,
                taskIds
              });
              await refreshData();
            }}
            onRetryAllFailed={async () => {
              await dispatchBackgroundCommand({
                type: 'BS_BG_RETRY_ALL_FAILED',
                batchId: activeBatch.id
              });
              await refreshData();
            }}
            onRetryDownloadOnly={async (taskId) => {
              await dispatchBackgroundCommand({
                type: 'BS_BG_RETRY_DOWNLOAD',
                batchId: activeBatch.id,
                taskId
              });
              await refreshData();
            }}
            onSkipTask={async (taskId) => {
              await dispatchBackgroundCommand({
                type: 'BS_BG_SKIP_TASK',
                batchId: activeBatch.id,
                taskId
              });
              await refreshData();
            }}
            onUpdateTaskPrompt={async (taskId, newPrompt) => {
              await updateTaskPromptAndSettings(taskId, {
                originalPrompt: newPrompt
              });
              await refreshData();
            }}
            onOpenPlatformTab={async () => {
              await dispatchBackgroundCommand({
                type: 'BS_BG_OPEN_OR_FOCUS_TAB',
                platformId: activeBatch.platform,
                batchId: activeBatch.id
              });
              await refreshData();
            }}
          />
        ) : (
          <div className="card" style={{ textAlign: 'center', padding: '32px 16px' }}>
            <h2 className="card-title" style={{ justifyContent: 'center' }}>
              No Active Batch Selected
            </h2>
            <p className="card-subtitle" style={{ marginBottom: '14px' }}>
              Create a new batch on the Batch Setup screen or open a saved batch.
            </p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setActiveTab('studio')}
            >
              Go to Batch Setup
            </button>
          </div>
        )}
      </main>
    </div>
  );
};
