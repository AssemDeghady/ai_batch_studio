import { AutoNumberingSettings } from '../types/models';

const WINDOWS_RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9'
]);

const ALLOWED_VARIABLES = new Set(['project', 'number', 'prompt', 'date', 'time']);

export interface TemplateValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateFilenameTemplate(
  template: string,
  autoNumberingEnabled: boolean
): TemplateValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const trimmed = template.trim();
  if (!trimmed) {
    errors.push('Filename template cannot be empty.');
    return { valid: false, errors, warnings };
  }

  // Check for unclosed braces
  let depth = 0;
  for (const ch of trimmed) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth < 0 || depth > 1) {
      errors.push('Filename template contains mismatched or nested curly braces.');
      break;
    }
  }
  if (depth !== 0 && errors.length === 0) {
    errors.push('Filename template contains an unclosed "{" brace.');
  }

  // Extract variables
  const tokenRegex = /\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(trimmed)) !== null) {
    const varName = match[1].trim();
    if (!ALLOWED_VARIABLES.has(varName)) {
      errors.push(
        `Unknown template variable "{${varName}}". Supported variables: {project}, {number}, {prompt}, {date}, {time}.`
      );
    }
  }

  if (!autoNumberingEnabled && trimmed === '{number}') {
    warnings.push(
      'Template only contains {number} while automatic numbering is disabled; fallback name "output" will be used.'
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Sanitizes a segment (such as project name or shortened prompt) for safe cross-platform filesystem usage.
 */
export function sanitizeFilenameSegment(raw: string, maxLength = 48): string {
  if (!raw) return '';

  // Remove control chars and forbidden filesystem characters: < > : " / \ | ? *
  let cleaned = raw
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');

  if (cleaned.length > maxLength) {
    cleaned = cleaned.slice(0, maxLength).replace(/[._-]+$/g, '');
  }

  if (WINDOWS_RESERVED_NAMES.has(cleaned.toUpperCase())) {
    cleaned = `_${cleaned}`;
  }

  return cleaned;
}

/**
 * Sanitizes a relative subfolder path under Chrome's Downloads directory.
 * Rejects path traversal ("..") and leading/trailing slashes.
 */
export function sanitizeSubfolderPath(subfolder: string): string {
  if (!subfolder) return '';
  const parts = subfolder
    .split(/[/\\]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part !== '.' && part !== '..')
    .map((part) => sanitizeFilenameSegment(part, 40))
    .filter(Boolean);

  return parts.join('/');
}

export interface SubfolderInterpolationContext {
  projectName?: string;
  timestamp?: Date;
}

export function interpolateSubfolderPath(
  subfolder: string,
  context?: SubfolderInterpolationContext
): string {
  if (!subfolder) return '';
  const dateStr = formatDateToken(context?.timestamp || new Date());
  const timeStr = formatTimeToken(context?.timestamp || new Date());
  const safeProject = sanitizeFilenameSegment(context?.projectName || 'Batch', 36) || 'Batch';

  const interpolated = subfolder
    .replace(/\{project\}/g, safeProject)
    .replace(/\{date\}/g, dateStr)
    .replace(/\{time\}/g, timeStr);

  return sanitizeSubfolderPath(interpolated);
}

export function formatRelativeDownloadPath(
  subfolder: string,
  filename: string,
  context?: SubfolderInterpolationContext
): string {
  const cleanSubfolder = interpolateSubfolderPath(subfolder, context);
  return cleanSubfolder ? `${cleanSubfolder}/${filename}` : filename;
}

export function formatSequenceNumber(num: number, paddingDigits: number): string {
  const safeNum = Math.max(0, Math.floor(num));
  const safePad = Math.max(1, Math.min(10, Math.floor(paddingDigits)));
  return String(safeNum).padStart(safePad, '0');
}

export function formatDateToken(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function formatTimeToken(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${hh}-${min}-${ss}`;
}

export interface BuildFilenameParams {
  template: string;
  projectName: string;
  prompt: string;
  sequenceNumber: number;
  extension: string;
  autoNumbering: AutoNumberingSettings;
  timestamp?: Date;
  existingFilenames?: Set<string>;
  maxBaseLength?: number;
}

/**
 * Generates a deterministic, sanitized filename from template + numbering settings,
 * resolving any collisions against `existingFilenames`.
 */
export function buildOutputFilename(params: BuildFilenameParams): string {
  const {
    template,
    projectName,
    prompt,
    sequenceNumber,
    extension,
    autoNumbering,
    timestamp = new Date(),
    existingFilenames,
    maxBaseLength = 110
  } = params;

  const cleanExt = extension.replace(/^\.+/, '').toLowerCase() || 'png';
  const safeProject = sanitizeFilenameSegment(projectName, 36) || 'Batch';
  const safePrompt = sanitizeFilenameSegment(prompt, 48) || 'Prompt';
  const dateStr = formatDateToken(timestamp);
  const timeStr = formatTimeToken(timestamp);
  const sep = sanitizeFilenameSegment(autoNumbering.separator || '_', 3) || '_';

  const formattedNum = autoNumbering.enabled
    ? formatSequenceNumber(sequenceNumber, autoNumbering.paddingDigits)
    : '';

  const effectiveTemplate = template.trim() || '{number}_{project}_{date}';
  const hasNumberToken = effectiveTemplate.includes('{number}');

  let interpolated = effectiveTemplate
    .replace(/\{project\}/g, safeProject)
    .replace(/\{prompt\}/g, safePrompt)
    .replace(/\{date\}/g, dateStr)
    .replace(/\{time\}/g, timeStr)
    .replace(/\{number\}/g, formattedNum);

  // If auto-numbering is enabled and the user's template didn't include {number}, append it
  if (autoNumbering.enabled && !hasNumberToken) {
    interpolated = `${interpolated}${sep}${formattedNum}`;
  }

  // Clean up any duplicate separators or stray characters left by removed tokens
  let baseName = interpolated
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/-+/g, '-')
    .replace(/^[_.-]+|[_.-]+$/g, '');

  if (!baseName) {
    baseName = autoNumbering.enabled ? `output_${formattedNum}` : 'output';
  }

  if (WINDOWS_RESERVED_NAMES.has(baseName.toUpperCase())) {
    baseName = `_${baseName}`;
  }

  if (baseName.length > maxBaseLength) {
    if (autoNumbering.enabled && !baseName.slice(0, maxBaseLength).includes(formattedNum)) {
      const keepLen = Math.max(16, maxBaseLength - formattedNum.length - 1);
      baseName = `${baseName.slice(0, keepLen).replace(/[_.-]+$/g, '')}_${formattedNum}`;
    } else {
      baseName = baseName.slice(0, maxBaseLength).replace(/[_.-]+$/g, '');
    }
  }

  let candidate = `${baseName}.${cleanExt}`;
  if (existingFilenames) {
    let collisionIdx = 2;
    while (existingFilenames.has(candidate.toLowerCase())) {
      candidate = `${baseName}_${collisionIdx}.${cleanExt}`;
      collisionIdx++;
    }
    existingFilenames.add(candidate.toLowerCase());
  }

  return candidate;
}
