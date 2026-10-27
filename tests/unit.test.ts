import { describe, expect, it } from 'vitest';
import {
  buildOutputFilename,
  formatRelativeDownloadPath,
  interpolateSubfolderPath,
  sanitizeFilenameSegment,
  sanitizeSubfolderPath,
  validateFilenameTemplate
} from '../src/core/fileNaming';
import { composeFinalPrompt } from '../src/core/prefixComposer';
import {
  expandAllPromptLines,
  expandPromptVariations,
  parseCsvPrompts,
  parsePlainTextPrompts
} from '../src/core/promptParser';
import { calculateBatchEta } from '../src/ui/components/QueueView';
import {
  assertValidTaskTransition,
  canTransitionTaskStatus,
  InvalidStateTransitionError,
  transitionTaskRecord
} from '../src/core/stateMachine';
import {
  computeInitialObservationDelayMs,
  evaluateGenerationObservation
} from '../src/core/timeoutPolicy';
import {
  DEFAULT_TIMEOUT_SETTINGS,
  TaskRecord
} from '../src/types/models';

describe('Prompt Parsing & CSV Validation', () => {
  it('parses plain text prompts one per line and skips blank lines while preserving order', () => {
    const raw = `\n  First prompt in desert  \r\n\r\nSecond prompt at oasis\n   \nThird prompt under stars\n`;
    const result = parsePlainTextPrompts(raw);

    expect(result.errors).toHaveLength(0);
    expect(result.skippedBlankLines).toBe(4);
    expect(result.items.map((i) => i.prompt)).toEqual([
      'First prompt in desert',
      'Second prompt at oasis',
      'Third prompt under stars'
    ]);
    expect(result.items.map((i) => i.index)).toEqual([1, 2, 3]);
  });

  it('parses headered CSV with task names, references, and generation settings', () => {
    const csv = [
      'prompt,name,references,aspect_ratio,duration,model,video_mode,output_count',
      '"A camel walking, golden hour",Scene 1,hero.png;style.webp,16:9,8,veo_3_quality,image_to_video,2',
      '"Oasis at night",Scene 2,,9:16,5,veo_2,text_to_video,1'
    ].join('\n');

    const res = parseCsvPrompts(csv);
    expect(res.errors).toHaveLength(0);
    expect(res.items).toHaveLength(2);
    expect(res.items[0]).toMatchObject({
      index: 1,
      prompt: 'A camel walking, golden hour',
      name: 'Scene 1',
      referenceNames: ['hero.png', 'style.webp'],
      generationSettings: {
        aspectRatio: '16:9',
        durationSec: 8,
        model: 'veo_3_quality',
        videoMode: 'image_to_video',
        outputCount: 2
      }
    });
    expect(res.items[1].prompt).toBe('Oasis at night');
  });

  it('reports helpful validation errors for malformed CSV rows, missing prompts, and invalid settings', () => {
    const malformedCsv = [
      'prompt,aspect_ratio,duration,model',
      ',16:9,5,veo_2',
      'Valid prompt,21:9,12,unknown_model'
    ].join('\n');

    const res = parseCsvPrompts(malformedCsv);
    expect(res.items).toHaveLength(1);
    expect(res.errors.length).toBeGreaterThanOrEqual(4);
    expect(res.errors.some((e) => e.message.includes('Missing prompt text'))).toBe(true);
    expect(res.errors.some((e) => e.message.includes('Invalid aspect_ratio'))).toBe(true);
    expect(res.errors.some((e) => e.message.includes('Invalid duration'))).toBe(true);
    expect(res.errors.some((e) => e.message.includes('Unknown model'))).toBe(true);
  });

  it('detects unclosed quotes and missing prompt header in CSV', () => {
    const unclosed = 'prompt,name\n"Unclosed quote prompt,Scene 1';
    const res1 = parseCsvPrompts(unclosed);
    expect(res1.errors.some((e) => e.message.includes('Unclosed quotation mark'))).toBe(true);

    const missingPromptHeader = 'title,references\nScene 1,ref.png';
    const res2 = parseCsvPrompts(missingPromptHeader);
    expect(
      res2.errors.some((e) => e.message.includes('missing a required "prompt" column'))
    ).toBe(true);
  });
});

describe('Global Prompt Prefix Composition', () => {
  it('prepends the shared prefix exactly once and preserves original prompt unchanged', () => {
    const original = 'Camel at sunset';
    const prefix = 'Maintain consistent character appearance and cinematic lighting.';

    const composed = composeFinalPrompt({
      originalPrompt: original,
      globalPrefix: prefix,
      prefixEnabled: true,
      separator: '\n\n'
    });

    expect(composed).toBe(
      'Maintain consistent character appearance and cinematic lighting.\n\nCamel at sunset'
    );
    expect(original).toBe('Camel at sunset');

    // Passing an already-prefixed string should NOT double-prepend
    const recomposed = composeFinalPrompt({
      originalPrompt: composed,
      globalPrefix: prefix,
      prefixEnabled: true,
      separator: '\n\n'
    });
    expect(recomposed).toBe(composed);
  });

  it('respects prefixEnabled=false and per-task prefix overrides', () => {
    const original = 'A futuristic city';
    const prefix = 'Global watercolor style.';

    expect(
      composeFinalPrompt({
        originalPrompt: original,
        globalPrefix: prefix,
        prefixEnabled: false
      })
    ).toBe(original);

    expect(
      composeFinalPrompt({
        originalPrompt: original,
        globalPrefix: prefix,
        prefixEnabled: true,
        taskSettings: { disableGlobalPrefix: true }
      })
    ).toBe(original);

    expect(
      composeFinalPrompt({
        originalPrompt: original,
        globalPrefix: prefix,
        prefixEnabled: true,
        taskSettings: { overridePrefix: 'Cyberpunk neon style.' }
      })
    ).toBe('Cyberpunk neon style.\n\nA futuristic city');
  });
});

describe('Custom File Naming & Optional Automatic Numbering', () => {
  it('interpolates {project}, {number}, {prompt}, {date}, {time} accurately', () => {
    const fixedDate = new Date(2026, 9, 20, 14, 5, 9); // 2026-10-20 14:05:09
    const filename = buildOutputFilename({
      template: '{project}_{number}_{prompt}_{date}_{time}',
      projectName: 'Desert Story',
      prompt: 'Camel At Sunset!',
      sequenceNumber: 1,
      extension: 'png',
      autoNumbering: {
        enabled: true,
        startNumber: 1,
        paddingDigits: 3,
        separator: '_'
      },
      timestamp: fixedDate
    });

    expect(filename).toBe('Desert_Story_001_Camel_At_Sunset!_2026-10-20_14-05-09.png');
  });

  it('injects sequential number when autoNumbering is enabled even if {number} is omitted from template', () => {
    const filename = buildOutputFilename({
      template: '{project}_{prompt}',
      projectName: 'image',
      prompt: 'portrait',
      sequenceNumber: 2,
      extension: 'png',
      autoNumbering: {
        enabled: true,
        startNumber: 1,
        paddingDigits: 3,
        separator: '_'
      }
    });
    expect(filename).toBe('image_portrait_002.png');
  });

  it('generates filename using default template {number}_{project}_{date}', () => {
    const fixedDate = new Date(2026, 9, 20);
    const filename = buildOutputFilename({
      template: '{number}_{project}_{date}',
      projectName: 'Desert_Story',
      prompt: 'Camel at sunset',
      sequenceNumber: 1,
      extension: 'png',
      autoNumbering: {
        enabled: true,
        startNumber: 1,
        paddingDigits: 3,
        separator: '_'
      },
      timestamp: fixedDate
    });
    expect(filename).toBe('001_Desert_Story_2026-10-20.png');

    // Also verify when template string is empty, it falls back to {number}_{project}_{date}
    const fallbackFilename = buildOutputFilename({
      template: '',
      projectName: 'Desert_Story',
      prompt: 'Camel at sunset',
      sequenceNumber: 2,
      extension: 'png',
      autoNumbering: {
        enabled: true,
        startNumber: 1,
        paddingDigits: 3,
        separator: '_'
      },
      timestamp: fixedDate
    });
    expect(fallbackFilename).toBe('002_Desert_Story_2026-10-20.png');
  });

  it('omits automatic sequential number when autoNumbering is disabled', () => {
    const filename = buildOutputFilename({
      template: '{project}_{number}_{prompt}',
      projectName: 'Desert_Story',
      prompt: 'Camel_At_Sunset',
      sequenceNumber: 1,
      extension: 'png',
      autoNumbering: {
        enabled: false,
        startNumber: 1,
        paddingDigits: 3,
        separator: '_'
      }
    });
    expect(filename).toBe('Desert_Story_Camel_At_Sunset.png');
  });

  it('sanitizes invalid filesystem characters, reserved Windows names, and resolves collisions', () => {
    expect(sanitizeFilenameSegment('CON')).toBe('_CON');
    expect(sanitizeFilenameSegment('bad:name*with?chars<>|"\\')).toBe(
      'bad_name_with_chars'
    );
    expect(sanitizeSubfolderPath('../BatchStudio//Sub/..')).toBe('BatchStudio/Sub');
    expect(formatRelativeDownloadPath('BatchStudio', 'img_001.png')).toBe(
      'BatchStudio/img_001.png'
    );

    const existing = new Set<string>();
    const f1 = buildOutputFilename({
      template: '{project}_{prompt}',
      projectName: 'Test',
      prompt: 'Same Prompt',
      sequenceNumber: 1,
      extension: 'png',
      autoNumbering: { enabled: false, startNumber: 1, paddingDigits: 3, separator: '_' },
      existingFilenames: existing
    });
    const f2 = buildOutputFilename({
      template: '{project}_{prompt}',
      projectName: 'Test',
      prompt: 'Same Prompt',
      sequenceNumber: 2,
      extension: 'png',
      autoNumbering: { enabled: false, startNumber: 1, paddingDigits: 3, separator: '_' },
      existingFilenames: existing
    });

    expect(f1).toBe('Test_Same_Prompt.png');
    expect(f2).toBe('Test_Same_Prompt_2.png');
  });

  it('validates filename templates and reports unknown variables or mismatched braces', () => {
    expect(validateFilenameTemplate('{project}_{number}_{prompt}', true).valid).toBe(true);
    expect(validateFilenameTemplate('{unknown_var}', true).valid).toBe(false);
    expect(validateFilenameTemplate('{project', true).valid).toBe(false);
    expect(validateFilenameTemplate('   ', true).valid).toBe(false);
  });
});

describe('Queue State Machine & Timeout Policy', () => {
  it('enforces valid state transitions and rejects invalid transitions (e.g. rerunning completed task)', () => {
    expect(canTransitionTaskStatus('pending', 'preparing')).toBe(true);
    expect(canTransitionTaskStatus('preparing', 'submitting')).toBe(true);
    expect(canTransitionTaskStatus('submitting', 'generating')).toBe(true);
    expect(canTransitionTaskStatus('generating', 'downloading')).toBe(true);
    expect(canTransitionTaskStatus('downloading', 'completed')).toBe(true);
    expect(canTransitionTaskStatus('downloading', 'download_failed')).toBe(true);
    expect(canTransitionTaskStatus('download_failed', 'downloading')).toBe(true);

    // Completed tasks cannot transition back to pending/submitting
    expect(canTransitionTaskStatus('completed', 'pending')).toBe(false);
    expect(() => assertValidTaskTransition('completed', 'preparing', 'task_1')).toThrow(
      InvalidStateTransitionError
    );

    const dummyTask: TaskRecord = {
      id: 't1',
      batchId: 'b1',
      sequenceNumber: 1,
      originalPrompt: 'Test',
      finalPromptSnapshot: 'Test',
      platform: 'chatgpt',
      taskType: 'image',
      status: 'pending',
      friendlyStatus: 'Ready to start.',
      referenceIds: [],
      generationSettings: {},
      createdAt: 1000,
      updatedAt: 1000,
      retryCount: 0,
      outputIds: []
    };

    const prep = transitionTaskRecord(dummyTask, 'preparing', { now: 2000 });
    expect(prep.status).toBe('preparing');
    expect(prep.friendlyStatus).toBe('Preparing prompt.');
  });

  it('computes initial observation window within 10-15s default range and does not fail active tasks after 15s', () => {
    const delayMin = computeInitialObservationDelayMs(DEFAULT_TIMEOUT_SETTINGS, () => 0);
    const delayMax = computeInitialObservationDelayMs(DEFAULT_TIMEOUT_SETTINGS, () => 1);
    expect(delayMin).toBe(10000);
    expect(delayMax).toBe(15000);

    const submittedAt = 100000;
    const generatingTask: TaskRecord = {
      id: 't_gen',
      batchId: 'b1',
      sequenceNumber: 1,
      originalPrompt: 'Slow detailed painting',
      finalPromptSnapshot: 'Slow detailed painting',
      platform: 'chatgpt',
      taskType: 'image',
      status: 'generating',
      friendlyStatus: 'Waiting for generation.',
      referenceIds: [],
      generationSettings: {},
      createdAt: submittedAt,
      updatedAt: submittedAt,
      submittedAt,
      initialObservationUntil: submittedAt + 12000,
      timeoutAt: submittedAt + 180000,
      retryCount: 0,
      outputIds: []
    };

    // At +8s (within 10-15s window): wait_initial_window
    const at8s = evaluateGenerationObservation({
      task: generatingTask,
      settings: DEFAULT_TIMEOUT_SETTINGS,
      observableState: 'active',
      now: submittedAt + 8000
    });
    expect(at8s.decision).toBe('wait_initial_window');
    expect(at8s.friendlyStatus).toBe('Waiting for generation.');

    // At +25s (past 15s initial window, still actively generating): MUST continue_generating, NOT mark failed!
    const at25s = evaluateGenerationObservation({
      task: generatingTask,
      settings: DEFAULT_TIMEOUT_SETTINGS,
      observableState: 'active',
      now: submittedAt + 25000
    });
    expect(at25s.decision).toBe('continue_generating');
    expect(at25s.friendlyStatus).toBe('Generation is still in progress.');

    // At +200s (past max timeout, state is 'unknown'): MUST set to needs_attention, never blindly auto_retry!
    const at200sUnknown = evaluateGenerationObservation({
      task: generatingTask,
      settings: { ...DEFAULT_TIMEOUT_SETTINGS, timeoutPolicy: 'auto_retry' },
      observableState: 'unknown',
      now: submittedAt + 200000
    });
    expect(at200sUnknown.decision).toBe('needs_attention');
  });
});

describe('Prompt Matrix Permutation & Variations Expansion', () => {
  it('expands single and multiple permutation brackets into Cartesian products', () => {
    const prompt = 'A {red, blue} sports car on a {beach, city street}';
    const variations = expandPromptVariations(prompt);

    expect(variations).toEqual([
      'A red sports car on a beach',
      'A red sports car on a city street',
      'A blue sports car on a beach',
      'A blue sports car on a city street'
    ]);
  });

  it('supports semicolon delimiters and trims whitespace around options', () => {
    const prompt = 'A cute { cat ; dog ; bird }';
    const variations = expandPromptVariations(prompt);

    expect(variations).toEqual(['A cute cat', 'A cute dog', 'A cute bird']);
  });

  it('returns untouched prompt when no permutation brackets are present', () => {
    const prompt = 'A peaceful mountain landscape';
    expect(expandPromptVariations(prompt)).toEqual(['A peaceful mountain landscape']);
  });

  it('expands multiline prompt batches via expandAllPromptLines', () => {
    const text = 'Photo of {sun, moon}\nA simple forest\n{Fast, Slow} running river';
    const expanded = expandAllPromptLines(text);

    expect(expanded.split('\n')).toEqual([
      'Photo of sun',
      'Photo of moon',
      'A simple forest',
      'Fast running river',
      'Slow running river'
    ]);
  });
});

describe('Dynamic Subfolder Path Token Interpolation', () => {
  it('interpolates {project}, {date}, and {time} tokens into sanitized relative subfolder paths', () => {
    const fixedDate = new Date(2026, 9, 27, 14, 30, 15);
    const interpolated = interpolateSubfolderPath('BatchStudio/{project}/{date}', {
      projectName: 'Desert Oasis',
      timestamp: fixedDate
    });

    expect(interpolated).toBe('BatchStudio/Desert_Oasis/2026-10-27');
  });

  it('safely rejects path traversal sequences in subfolder templates', () => {
    const fixedDate = new Date(2026, 9, 27, 14, 30, 15);
    const interpolated = interpolateSubfolderPath('../../secret/{project}', {
      projectName: 'Test',
      timestamp: fixedDate
    });

    expect(interpolated).toBe('secret/Test');
  });

  it('formats relative download path with interpolated subfolder tokens', () => {
    const fixedDate = new Date(2026, 9, 27, 14, 30, 15);
    const relative = formatRelativeDownloadPath(
      'Outputs/{project}',
      '001_output.png',
      { projectName: 'Hero Render', timestamp: fixedDate }
    );

    expect(relative).toBe('Outputs/Hero_Render/001_output.png');
  });
});

describe('Batch ETA Estimation & Rolling Average', () => {
  it('calculates ETA based on completed task durations and pending count', () => {
    const now = 100000;
    const tasks: TaskRecord[] = [
      {
        id: 't1',
        batchId: 'b1',
        sequenceNumber: 1,
        originalPrompt: 'P1',
        finalPromptSnapshot: 'P1',
        platform: 'chatgpt',
        taskType: 'image',
        status: 'completed',
        friendlyStatus: 'Completed',
        referenceIds: [],
        generationSettings: {},
        createdAt: 10000,
        updatedAt: 40000,
        submittedAt: 10000,
        completedAt: 40000, // 30s duration
        retryCount: 0,
        outputIds: []
      },
      {
        id: 't2',
        batchId: 'b1',
        sequenceNumber: 2,
        originalPrompt: 'P2',
        finalPromptSnapshot: 'P2',
        platform: 'chatgpt',
        taskType: 'image',
        status: 'pending',
        friendlyStatus: 'Pending',
        referenceIds: [],
        generationSettings: {},
        createdAt: 10000,
        updatedAt: 10000,
        retryCount: 0,
        outputIds: []
      },
      {
        id: 't3',
        batchId: 'b1',
        sequenceNumber: 3,
        originalPrompt: 'P3',
        finalPromptSnapshot: 'P3',
        platform: 'chatgpt',
        taskType: 'image',
        status: 'pending',
        friendlyStatus: 'Pending',
        referenceIds: [],
        generationSettings: {},
        createdAt: 10000,
        updatedAt: 10000,
        retryCount: 0,
        outputIds: []
      }
    ];

    // Avg duration = 30s. 2 pending tasks => 60s => ~1m 0s
    const eta = calculateBatchEta(tasks, now);
    expect(eta).toBe('~1m 0s');
  });

  it('returns 0s when all tasks have reached completion', () => {
    const tasks: TaskRecord[] = [
      {
        id: 't1',
        batchId: 'b1',
        sequenceNumber: 1,
        originalPrompt: 'P1',
        finalPromptSnapshot: 'P1',
        platform: 'chatgpt',
        taskType: 'image',
        status: 'completed',
        friendlyStatus: 'Completed',
        referenceIds: [],
        generationSettings: {},
        createdAt: 10000,
        updatedAt: 40000,
        submittedAt: 10000,
        completedAt: 40000,
        retryCount: 0,
        outputIds: []
      }
    ];

    expect(calculateBatchEta(tasks, 50000)).toBe('0s');
  });
});
