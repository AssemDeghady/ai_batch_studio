import {
  AspectRatio,
  FlowModelId,
  FlowVideoMode,
  FLOW_MODEL_CAPABILITIES,
  GenerationSettings,
  OutputCount,
  VideoDurationSec
} from '../types/models';

export interface ParsedPromptDraft {
  index: number;
  prompt: string;
  name?: string;
  referenceNames: string[];
  generationSettings: GenerationSettings;
}

export interface PromptParseValidationError {
  row: number;
  message: string;
}

export interface PromptParseResult {
  items: ParsedPromptDraft[];
  errors: PromptParseValidationError[];
  skippedBlankLines: number;
}

/**
 * Parses multi-line plain text (or TXT file contents) using the convention of
 * one prompt per non-empty line. Blank or whitespace-only lines are skipped and
 * reported in `skippedBlankLines`.
 */
export function parsePlainTextPrompts(text: string): PromptParseResult {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const items: ParsedPromptDraft[] = [];
  let skippedBlankLines = 0;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      skippedBlankLines++;
      continue;
    }
    items.push({
      index: items.length + 1,
      prompt: trimmed,
      referenceNames: [],
      generationSettings: {}
    });
  }

  return {
    items,
    errors: [],
    skippedBlankLines
  };
}

interface RawCsvRow {
  lineNumber: number;
  cells: string[];
}

function tokenizeCsv(content: string): {
  rows: RawCsvRow[];
  errors: PromptParseValidationError[];
  skippedBlankLines: number;
} {
  const rows: RawCsvRow[] = [];
  const errors: PromptParseValidationError[] = [];
  let skippedBlankLines = 0;

  const text = content.replace(/^\uFEFF/, ''); // Strip UTF-8 BOM if present
  let i = 0;
  let lineNumber = 1;
  let rowStartLine = 1;
  let currentCell = '';
  let currentRow: string[] = [];
  let inQuotes = false;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          currentCell += '"';
          i += 2;
          continue;
        } else {
          inQuotes = false;
          i++;
          continue;
        }
      } else {
        if (ch === '\n') lineNumber++;
        currentCell += ch;
        i++;
        continue;
      }
    } else {
      if (ch === '"') {
        if (currentCell.trim().length > 0) {
          errors.push({
            row: rowStartLine,
            message: `Row ${rowStartLine}: Unexpected quote character inside unquoted field.`
          });
        }
        inQuotes = true;
        i++;
        continue;
      }

      if (ch === ',') {
        currentRow.push(currentCell.trim());
        currentCell = '';
        i++;
        continue;
      }

      if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && i + 1 < text.length && text[i + 1] === '\n') {
          i++;
        }
        currentRow.push(currentCell.trim());
        const isAllBlank = currentRow.every((c) => c === '');
        if (!isAllBlank) {
          rows.push({ lineNumber: rowStartLine, cells: currentRow });
        } else {
          skippedBlankLines++;
        }
        currentRow = [];
        currentCell = '';
        lineNumber++;
        rowStartLine = lineNumber;
        i++;
        continue;
      }

      currentCell += ch;
      i++;
    }
  }

  if (inQuotes) {
    errors.push({
      row: rowStartLine,
      message: `Row ${rowStartLine}: Unclosed quotation mark in CSV.`
    });
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell.trim());
    const isAllBlank = currentRow.every((c) => c === '');
    if (!isAllBlank) {
      rows.push({ lineNumber: rowStartLine, cells: currentRow });
    } else {
      skippedBlankLines++;
    }
  }

  return { rows, errors, skippedBlankLines };
}

const KNOWN_HEADERS = new Set([
  'prompt',
  'text',
  'description',
  'name',
  'task_name',
  'title',
  'references',
  'reference',
  'reference_images',
  'aspect_ratio',
  'aspectratio',
  'duration',
  'duration_sec',
  'model',
  'video_mode',
  'videomode',
  'output_count',
  'outputs',
  'prefix_override',
  'disable_prefix'
]);

const VALID_ASPECT_RATIOS: AspectRatio[] = ['16:9', '9:16', '1:1'];
const VALID_VIDEO_MODES: FlowVideoMode[] = [
  'text_to_video',
  'image_to_video',
  'start_end_frame',
  'reference_ingredients'
];

/**
 * Parses CSV content supporting both headered and headerless CSV files.
 * Supported columns:
 * - `prompt` (required)
 * - `name` / `task_name` / `title` (optional)
 * - `references` / `reference` (optional, semicolon or pipe separated reference names)
 * - `aspect_ratio` (`16:9`, `9:16`, `1:1`)
 * - `duration` (`5`, `8`)
 * - `model` (`imagen_3`, `imagen_3_fast`, `veo_2`, `veo_3_quality`, `veo_3_fast`)
 * - `video_mode` (`text_to_video`, `image_to_video`, `start_end_frame`, `reference_ingredients`)
 * - `output_count` (`1`, `2`, `4`)
 * - `prefix_override` (custom string)
 * - `disable_prefix` (`true` / `false`)
 */
export function parseCsvPrompts(csvContent: string): PromptParseResult {
  const { rows, errors, skippedBlankLines } = tokenizeCsv(csvContent);
  if (rows.length === 0) {
    if (errors.length === 0) {
      errors.push({ row: 1, message: 'The CSV file contains no rows.' });
    }
    return { items: [], errors, skippedBlankLines };
  }

  const firstRowNormalized = rows[0].cells.map((c) =>
    c.toLowerCase().replace(/\s+/g, '_').trim()
  );
  const hasHeader = firstRowNormalized.some((h) => KNOWN_HEADERS.has(h));

  let headerMap: Record<string, number> = {};
  let dataStartIdx = 0;

  if (hasHeader) {
    dataStartIdx = 1;
    firstRowNormalized.forEach((colName, idx) => {
      headerMap[colName] = idx;
    });
    const hasPromptCol =
      headerMap['prompt'] !== undefined ||
      headerMap['text'] !== undefined ||
      headerMap['description'] !== undefined;
    if (!hasPromptCol) {
      errors.push({
        row: rows[0].lineNumber,
        message:
          'CSV header row is missing a required "prompt" column (found: ' +
          rows[0].cells.join(', ') +
          ').'
      });
      return { items: [], errors, skippedBlankLines };
    }
  } else {
    headerMap = {
      prompt: 0,
      name: 1,
      references: 2,
      aspect_ratio: 3,
      duration: 4
    };
  }

  const items: ParsedPromptDraft[] = [];

  for (let r = dataStartIdx; r < rows.length; r++) {
    const row = rows[r];
    const getCol = (...names: string[]): string => {
      for (const n of names) {
        const idx = headerMap[n];
        if (idx !== undefined && idx < row.cells.length) {
          return row.cells[idx].trim();
        }
      }
      return '';
    };

    const promptText = getCol('prompt', 'text', 'description');
    if (!promptText) {
      errors.push({
        row: row.lineNumber,
        message: `Row ${row.lineNumber}: Missing prompt text.`
      });
      continue;
    }

    const name = getCol('name', 'task_name', 'title') || undefined;
    const rawRefs = getCol('references', 'reference', 'reference_images');
    const referenceNames = rawRefs
      ? rawRefs
          .split(/[;|]/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    const generationSettings: GenerationSettings = {};

    const rawAspect = getCol('aspect_ratio', 'aspectratio');
    if (rawAspect) {
      if (VALID_ASPECT_RATIOS.includes(rawAspect as AspectRatio)) {
        generationSettings.aspectRatio = rawAspect as AspectRatio;
      } else {
        errors.push({
          row: row.lineNumber,
          message: `Row ${row.lineNumber}: Invalid aspect_ratio "${rawAspect}". Expected one of: ${VALID_ASPECT_RATIOS.join(', ')}.`
        });
      }
    }

    const rawDuration = getCol('duration', 'duration_sec');
    if (rawDuration) {
      const numDur = Number(rawDuration.replace(/s$/i, ''));
      if (numDur === 5 || numDur === 8) {
        generationSettings.durationSec = numDur as VideoDurationSec;
      } else {
        errors.push({
          row: row.lineNumber,
          message: `Row ${row.lineNumber}: Invalid duration "${rawDuration}". Supported durations: 5 or 8 seconds.`
        });
      }
    }

    const rawModel = getCol('model');
    if (rawModel) {
      if (rawModel in FLOW_MODEL_CAPABILITIES) {
        generationSettings.model = rawModel as FlowModelId;
      } else {
        errors.push({
          row: row.lineNumber,
          message: `Row ${row.lineNumber}: Unknown model "${rawModel}".`
        });
      }
    }

    const rawVideoMode = getCol('video_mode', 'videomode');
    if (rawVideoMode) {
      if (VALID_VIDEO_MODES.includes(rawVideoMode as FlowVideoMode)) {
        generationSettings.videoMode = rawVideoMode as FlowVideoMode;
      } else {
        errors.push({
          row: row.lineNumber,
          message: `Row ${row.lineNumber}: Invalid video_mode "${rawVideoMode}".`
        });
      }
    }

    const rawOutputs = getCol('output_count', 'outputs');
    if (rawOutputs) {
      const count = Number(rawOutputs);
      if (count === 1 || count === 2 || count === 4) {
        generationSettings.outputCount = count as OutputCount;
      } else {
        errors.push({
          row: row.lineNumber,
          message: `Row ${row.lineNumber}: Invalid output_count "${rawOutputs}". Expected 1, 2, or 4.`
        });
      }
    }

    const prefixOverride = getCol('prefix_override');
    if (prefixOverride) {
      generationSettings.overridePrefix = prefixOverride;
    }

    const disablePrefix = getCol('disable_prefix');
    if (disablePrefix) {
      generationSettings.disableGlobalPrefix =
        disablePrefix.toLowerCase() === 'true' || disablePrefix === '1';
    }

    items.push({
      index: items.length + 1,
      prompt: promptText,
      name,
      referenceNames,
      generationSettings
    });
  }

  return {
    items,
    errors,
    skippedBlankLines
  };
}
