import {
  BatchRecord,
  DiagnosticLogEntry,
  OutputRecord,
  ReferenceBlobRecord,
  ReferenceRecord,
  TaskRecord
} from '../types/models';

export const DB_NAME = 'BatchStudioDB';
export const DB_VERSION = 1;

export class StorageQuotaError extends Error {
  public readonly code = 'STORAGE_QUOTA_EXCEEDED';
  constructor(message = 'Local browser storage quota exceeded. Please delete old batches or large reference images.') {
    super(message);
    this.name = 'StorageQuotaError';
  }
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      if (!db.objectStoreNames.contains('batches')) {
        const batchStore = db.createObjectStore('batches', { keyPath: 'id' });
        batchStore.createIndex('by_updatedAt', 'updatedAt', { unique: false });
      }

      if (!db.objectStoreNames.contains('tasks')) {
        const taskStore = db.createObjectStore('tasks', { keyPath: 'id' });
        taskStore.createIndex('by_batchId', 'batchId', { unique: false });
      }

      if (!db.objectStoreNames.contains('outputs')) {
        const outputStore = db.createObjectStore('outputs', { keyPath: 'id' });
        outputStore.createIndex('by_taskId', 'taskId', { unique: false });
        outputStore.createIndex('by_batchId', 'batchId', { unique: false });
        outputStore.createIndex('by_downloadId', 'downloadId', { unique: false });
      }

      if (!db.objectStoreNames.contains('references')) {
        const refStore = db.createObjectStore('references', { keyPath: 'id' });
        refStore.createIndex('by_createdAt', 'createdAt', { unique: false });
      }

      if (!db.objectStoreNames.contains('referenceBlobs')) {
        db.createObjectStore('referenceBlobs', { keyPath: 'storageKey' });
      }

      if (!db.objectStoreNames.contains('logs')) {
        const logStore = db.createObjectStore('logs', { keyPath: 'id' });
        logStore.createIndex('by_timestamp', 'timestamp', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error || new Error('Failed to open BatchStudioDB'));
    };
  });

  return dbPromise;
}

export async function closeAndResetDatabase(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
    dbPromise = null;
  }
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

function wrapRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      const err = request.error;
      if (err && (err.name === 'QuotaExceededError' || err.message?.includes('quota'))) {
        reject(new StorageQuotaError());
      } else {
        reject(err || new Error('IndexedDB request failed'));
      }
    };
  });
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T> | IDBRequest<T>
): Promise<T> {
  const db = await openDatabase();
  const tx = db.transaction(storeName, mode);
  const store = tx.objectStore(storeName);
  const res = fn(store);
  if (res instanceof Promise) {
    return res;
  }
  return wrapRequest(res);
}

// Batches
export async function saveBatch(batch: BatchRecord): Promise<void> {
  await withStore('batches', 'readwrite', (store) => store.put(batch));
}

export async function getBatch(id: string): Promise<BatchRecord | undefined> {
  return withStore('batches', 'readonly', (store) => store.get(id));
}

export async function getAllBatches(): Promise<BatchRecord[]> {
  const batches = await withStore<BatchRecord[]>('batches', 'readonly', (store) => store.getAll());
  return batches.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteBatchCascade(batchId: string): Promise<void> {
  const tasks = await getTasksByBatch(batchId);
  const outputs = await getOutputsByBatch(batchId);
  const db = await openDatabase();
  const tx = db.transaction(['batches', 'tasks', 'outputs'], 'readwrite');
  tx.objectStore('batches').delete(batchId);
  const taskStore = tx.objectStore('tasks');
  for (const t of tasks) {
    taskStore.delete(t.id);
  }
  const outputStore = tx.objectStore('outputs');
  for (const o of outputs) {
    outputStore.delete(o.id);
  }
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Tasks
export async function saveTask(task: TaskRecord): Promise<void> {
  await withStore('tasks', 'readwrite', (store) => store.put(task));
}

export async function saveTasksBulk(tasks: TaskRecord[]): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction('tasks', 'readwrite');
  const store = tx.objectStore('tasks');
  for (const t of tasks) {
    store.put(t);
  }
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => {
      if (tx.error?.name === 'QuotaExceededError') reject(new StorageQuotaError());
      else reject(tx.error);
    };
  });
}

export async function getTask(id: string): Promise<TaskRecord | undefined> {
  return withStore('tasks', 'readonly', (store) => store.get(id));
}

export async function getTasksByBatch(batchId: string): Promise<TaskRecord[]> {
  const db = await openDatabase();
  const tx = db.transaction('tasks', 'readonly');
  const index = tx.objectStore('tasks').index('by_batchId');
  const tasks = await wrapRequest<TaskRecord[]>(index.getAll(IDBKeyRange.only(batchId)));
  return tasks.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
}

export async function deleteTask(taskId: string): Promise<void> {
  await withStore('tasks', 'readwrite', (store) => store.delete(taskId));
}

// Outputs
export async function saveOutput(output: OutputRecord): Promise<void> {
  await withStore('outputs', 'readwrite', (store) => store.put(output));
}

export async function getOutput(id: string): Promise<OutputRecord | undefined> {
  return withStore('outputs', 'readonly', (store) => store.get(id));
}

export async function getOutputsByTask(taskId: string): Promise<OutputRecord[]> {
  const db = await openDatabase();
  const tx = db.transaction('outputs', 'readonly');
  const index = tx.objectStore('outputs').index('by_taskId');
  const outputs = await wrapRequest<OutputRecord[]>(index.getAll(IDBKeyRange.only(taskId)));
  return outputs.sort((a, b) => a.index - b.index);
}

export async function getOutputsByBatch(batchId: string): Promise<OutputRecord[]> {
  const db = await openDatabase();
  const tx = db.transaction('outputs', 'readonly');
  const index = tx.objectStore('outputs').index('by_batchId');
  const outputs = await wrapRequest<OutputRecord[]>(index.getAll(IDBKeyRange.only(batchId)));
  return outputs.sort((a, b) => a.createdAt - b.createdAt);
}

export async function getOutputByDownloadId(downloadId: number): Promise<OutputRecord | undefined> {
  const db = await openDatabase();
  const tx = db.transaction('outputs', 'readonly');
  const index = tx.objectStore('outputs').index('by_downloadId');
  return wrapRequest<OutputRecord | undefined>(index.get(downloadId));
}

// References
export async function saveReference(
  metadata: ReferenceRecord,
  blobRecord: ReferenceBlobRecord
): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(['references', 'referenceBlobs'], 'readwrite');
  tx.objectStore('references').put(metadata);
  tx.objectStore('referenceBlobs').put(blobRecord);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => {
      if (tx.error?.name === 'QuotaExceededError') reject(new StorageQuotaError());
      else reject(tx.error || new Error('Failed to store reference image'));
    };
  });
}

export async function updateReferenceMetadata(metadata: ReferenceRecord): Promise<void> {
  await withStore('references', 'readwrite', (store) => store.put(metadata));
}

export async function getReference(id: string): Promise<ReferenceRecord | undefined> {
  return withStore('references', 'readonly', (store) => store.get(id));
}

export async function getReferenceBlob(storageKey: string): Promise<ReferenceBlobRecord | undefined> {
  return withStore('referenceBlobs', 'readonly', (store) => store.get(storageKey));
}

export async function getAllReferences(): Promise<ReferenceRecord[]> {
  const refs = await withStore<ReferenceRecord[]>('references', 'readonly', (store) =>
    store.getAll()
  );
  return refs.sort((a, b) => a.createdAt - b.createdAt);
}

export async function deleteReference(id: string): Promise<void> {
  const ref = await getReference(id);
  const db = await openDatabase();
  const tx = db.transaction(['references', 'referenceBlobs'], 'readwrite');
  tx.objectStore('references').delete(id);
  if (ref?.storageKey) {
    tx.objectStore('referenceBlobs').delete(ref.storageKey);
  }
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Diagnostic Logs
export async function appendDiagnosticLog(
  entry: Omit<DiagnosticLogEntry, 'id' | 'timestamp'>
): Promise<DiagnosticLogEntry> {
  const fullEntry: DiagnosticLogEntry = {
    ...entry,
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now()
  };
  try {
    await withStore('logs', 'readwrite', (store) => store.put(fullEntry));
  } catch {
    // Non-fatal if diagnostic logging fails
  }
  return fullEntry;
}

export async function getRecentDiagnosticLogs(limit = 100): Promise<DiagnosticLogEntry[]> {
  const logs = await withStore<DiagnosticLogEntry[]>('logs', 'readonly', (store) => store.getAll());
  return logs.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

export async function clearDiagnosticLogs(): Promise<void> {
  await withStore('logs', 'readwrite', (store) => store.clear());
}
