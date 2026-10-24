import {
  deleteReference,
  getAllReferences,
  getReference,
  getReferenceBlob,
  saveReference,
  StorageQuotaError,
  updateReferenceMetadata
} from '../storage/db';
import {
  ReferenceBlobRecord,
  ReferenceRecord,
  ReferenceType
} from '../types/models';

export const ALLOWED_REFERENCE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif'
]);

export const MAX_REFERENCE_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

export class ReferenceValidationError extends Error {
  public readonly code:
    | 'UNSUPPORTED_FORMAT'
    | 'FILE_TOO_LARGE'
    | 'CORRUPT_FILE'
    | 'STORAGE_QUOTA_EXCEEDED'
    | 'MISSING_REFERENCE';

  constructor(
    code:
      | 'UNSUPPORTED_FORMAT'
      | 'FILE_TOO_LARGE'
      | 'CORRUPT_FILE'
      | 'STORAGE_QUOTA_EXCEEDED'
      | 'MISSING_REFERENCE',
    message: string
  ) {
    super(message);
    this.name = 'ReferenceValidationError';
    this.code = code;
  }
}

export interface CreateReferenceInput {
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
  type?: ReferenceType;
  thumbnailDataUrl?: string;
}

function isValidImageDataUrl(dataUrl: string): boolean {
  if (!dataUrl || typeof dataUrl !== 'string') return false;
  const match = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!match) return false;
  const base64Payload = match[2].replace(/\s+/g, '');
  if (base64Payload.length < 16) return false;
  return true;
}

export async function addReferenceImage(input: CreateReferenceInput): Promise<ReferenceRecord> {
  const normalizedMime = input.mimeType.toLowerCase().trim();
  if (!ALLOWED_REFERENCE_MIME_TYPES.has(normalizedMime)) {
    throw new ReferenceValidationError(
      'UNSUPPORTED_FORMAT',
      `Unsupported image format "${input.mimeType || 'unknown'}". Supported formats: PNG, JPEG, WEBP, GIF.`
    );
  }

  if (input.size <= 0) {
    throw new ReferenceValidationError(
      'CORRUPT_FILE',
      `File "${input.name}" appears to be empty or corrupt.`
    );
  }

  if (input.size > MAX_REFERENCE_FILE_SIZE_BYTES) {
    const mb = (input.size / (1024 * 1024)).toFixed(1);
    throw new ReferenceValidationError(
      'FILE_TOO_LARGE',
      `File "${input.name}" (${mb} MB) exceeds the 20 MB maximum size per reference image.`
    );
  }

  if (!isValidImageDataUrl(input.dataUrl)) {
    throw new ReferenceValidationError(
      'CORRUPT_FILE',
      `File "${input.name}" could not be decoded as a valid image.`
    );
  }

  const now = Date.now();
  const id = `ref_${now}_${Math.random().toString(36).slice(2, 9)}`;
  const storageKey = `blob_${id}`;

  const metadata: ReferenceRecord = {
    id,
    name: input.name.trim() || 'reference.png',
    type: input.type || 'general',
    mimeType: normalizedMime === 'image/jpg' ? 'image/jpeg' : normalizedMime,
    size: input.size,
    storageKey,
    thumbnailDataUrl: input.thumbnailDataUrl || input.dataUrl,
    createdAt: now
  };

  const blobRecord: ReferenceBlobRecord = {
    storageKey,
    dataUrl: input.dataUrl,
    mimeType: metadata.mimeType,
    size: input.size,
    createdAt: now
  };

  try {
    await saveReference(metadata, blobRecord);
  } catch (err) {
    if (err instanceof StorageQuotaError) {
      throw new ReferenceValidationError('STORAGE_QUOTA_EXCEEDED', err.message);
    }
    throw err;
  }

  return metadata;
}

export async function updateReferenceType(
  referenceId: string,
  newType: ReferenceType
): Promise<ReferenceRecord> {
  const existing = await getReference(referenceId);
  if (!existing) {
    throw new ReferenceValidationError(
      'MISSING_REFERENCE',
      `Reference "${referenceId}" was not found in local storage.`
    );
  }
  const updated: ReferenceRecord = {
    ...existing,
    type: newType
  };
  await updateReferenceMetadata(updated);
  return updated;
}

export function reorderReferenceIds(
  referenceIds: string[],
  fromIndex: number,
  toIndex: number
): string[] {
  const copy = [...referenceIds];
  if (
    fromIndex < 0 ||
    fromIndex >= copy.length ||
    toIndex < 0 ||
    toIndex >= copy.length ||
    fromIndex === toIndex
  ) {
    return copy;
  }
  const [moved] = copy.splice(fromIndex, 1);
  copy.splice(toIndex, 0, moved);
  return copy;
}

export interface ResolvedReferenceAttachment {
  metadata: ReferenceRecord;
  dataUrl: string;
}

/**
 * Resolves and verifies all shared + task-specific reference images for a task.
 * Deduplicates while preserving order (shared references first, then task-specific references).
 * Throws `ReferenceValidationError('MISSING_REFERENCE')` if any required reference metadata or blob is missing,
 * ensuring a task is never silently submitted without its required references.
 */
export async function resolveTaskReferences(
  sharedReferenceIds: string[],
  taskReferenceIds: string[]
): Promise<ResolvedReferenceAttachment[]> {
  const combinedIds: string[] = [];
  const seen = new Set<string>();

  for (const id of [...sharedReferenceIds, ...taskReferenceIds]) {
    if (id && !seen.has(id)) {
      seen.add(id);
      combinedIds.push(id);
    }
  }

  const resolved: ResolvedReferenceAttachment[] = [];

  for (const refId of combinedIds) {
    const metadata = await getReference(refId);
    if (!metadata) {
      throw new ReferenceValidationError(
        'MISSING_REFERENCE',
        `Required reference image (ID: ${refId}) is missing from storage. Please remove or re-attach the reference before retrying.`
      );
    }

    const blob = await getReferenceBlob(metadata.storageKey);
    if (!blob || !blob.dataUrl) {
      throw new ReferenceValidationError(
        'MISSING_REFERENCE',
        `Binary image data for reference "${metadata.name}" is missing or unreadable. Please re-upload "${metadata.name}".`
      );
    }

    resolved.push({
      metadata,
      dataUrl: blob.dataUrl
    });
  }

  return resolved;
}

/**
 * Matches reference names from a CSV import against stored ReferenceRecords (case-insensitive).
 */
export async function matchReferenceNamesToIds(
  referenceNames: string[]
): Promise<{ matchedIds: string[]; unmatchedNames: string[] }> {
  if (referenceNames.length === 0) {
    return { matchedIds: [], unmatchedNames: [] };
  }
  const allRefs = await getAllReferences();
  const matchedIds: string[] = [];
  const unmatchedNames: string[] = [];

  for (const rawName of referenceNames) {
    const target = rawName.toLowerCase().trim();
    const match = allRefs.find(
      (r) =>
        r.name.toLowerCase() === target ||
        r.name.toLowerCase().replace(/\.[^.]+$/, '') === target
    );
    if (match) {
      if (!matchedIds.includes(match.id)) {
        matchedIds.push(match.id);
      }
    } else {
      unmatchedNames.push(rawName);
    }
  }

  return { matchedIds, unmatchedNames };
}

export { deleteReference, getAllReferences, getReference };
