import { GenerationSettings } from '../types/models';

export interface PrefixCompositionOptions {
  originalPrompt: string;
  globalPrefix: string;
  prefixEnabled: boolean;
  separator?: string;
  taskSettings?: GenerationSettings;
}

export const DEFAULT_PREFIX_SEPARATOR = '\n\n';

/**
 * Composes the final prompt to be submitted to the target platform.
 * - Always derives from `originalPrompt` so retries never double-prepend.
 * - Supports per-task prefix disable (`disableGlobalPrefix`) or custom override (`overridePrefix`).
 * - Prevents duplicate prepending if `originalPrompt` already starts with the exact prefix.
 */
export function composeFinalPrompt(options: PrefixCompositionOptions): string {
  const {
    originalPrompt,
    globalPrefix,
    prefixEnabled,
    separator = DEFAULT_PREFIX_SEPARATOR,
    taskSettings
  } = options;

  const trimmedOriginal = originalPrompt.trim();
  if (!trimmedOriginal) {
    return '';
  }

  if (taskSettings?.disableGlobalPrefix) {
    return trimmedOriginal;
  }

  const rawPrefix =
    taskSettings?.overridePrefix !== undefined && taskSettings?.overridePrefix !== null
      ? taskSettings.overridePrefix
      : prefixEnabled
      ? globalPrefix
      : '';

  const trimmedPrefix = rawPrefix.trim();
  if (!trimmedPrefix) {
    return trimmedOriginal;
  }

  // Guard against accidental duplicate prefix if user pasted an already-prefixed prompt
  if (
    trimmedOriginal === trimmedPrefix ||
    trimmedOriginal.startsWith(`${trimmedPrefix}${separator}`) ||
    trimmedOriginal.startsWith(`${trimmedPrefix}\n`) ||
    trimmedOriginal.startsWith(`${trimmedPrefix} `)
  ) {
    return trimmedOriginal;
  }

  return `${trimmedPrefix}${separator}${trimmedOriginal}`;
}
