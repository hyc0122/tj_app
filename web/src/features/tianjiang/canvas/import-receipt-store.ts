/** 中文注释：导入回执按账号+项目隔离，pending 未升级前禁止认为 POST 已成功。 */

export type CanvasImportIntentStatus = "pending" | "accepted";

export interface CanvasImportIntent {
  key: string;
  accountId: string;
  projectUuid: string;
  status: CanvasImportIntentStatus;
  clientMutationId: string;
  requestDigest: string;
  archiveSha256: string;
  archiveSizeBytes: number;
  baseRevision: number;
  importerSchemaVersion: number;
  importUuid?: string;
  receipt?: unknown;
}

export interface CanvasImportActionIntent {
  key: string;
  accountId: string;
  projectUuid: string;
  importUuid: string;
  status: CanvasImportIntentStatus;
  actionType: "cancel" | "reconcile";
  clientActionId: string;
  requestDigest: string;
  receipt?: unknown;
}

const DB_NAME = "tianjiang-canvas-import-receipts";
const IMPORT_STORE = "import-intents";
const ACTION_STORE = "action-intents";

function openReceiptDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IMPORT_STORE)) {
        db.createObjectStore(IMPORT_STORE, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(ACTION_STORE)) {
        db.createObjectStore(ACTION_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function putRecord<T>(storeName: string, value: T): Promise<void> {
  return openReceiptDb().then((db) => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function getRecord<T>(storeName: string, key: string): Promise<T | undefined> {
  return openReceiptDb().then((db) => new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const request = tx.objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  }));
}

function getAllRecords<T>(storeName: string): Promise<T[]> {
  return openReceiptDb().then((db) => new Promise<T[]>((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => resolve((request.result as T[]) ?? []);
    request.onerror = () => reject(request.error);
  }));
}

function deleteRecord(storeName: string, key: string): Promise<void> {
  return openReceiptDb().then((db) => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

export function importIntentKey(accountId: string, projectUuid: string, clientMutationId: string): string {
  return `${accountId}:${projectUuid}:${clientMutationId}`;
}

export function importActionKey(accountId: string, projectUuid: string, clientActionId: string): string {
  return `${accountId}:${projectUuid}:action:${clientActionId}`;
}

export async function commitPendingImportIntent(intent: Omit<CanvasImportIntent, "key" | "status">): Promise<CanvasImportIntent> {
  const record: CanvasImportIntent = {
    ...intent,
    key: importIntentKey(intent.accountId, intent.projectUuid, intent.clientMutationId),
    status: "pending",
  };
  await putRecord(IMPORT_STORE, record);
  return record;
}

export async function upgradeImportIntentAccepted(
  key: string,
  receipt: { importUuid?: string } & Record<string, unknown>,
): Promise<CanvasImportIntent> {
  const current = await getRecord<CanvasImportIntent>(IMPORT_STORE, key);
  if (!current) throw new Error("导入意图不存在，无法升级为已受理");
  const next: CanvasImportIntent = {
    ...current,
    status: "accepted",
    importUuid: String(receipt.importUuid ?? current.importUuid ?? ""),
    receipt,
  };
  await putRecord(IMPORT_STORE, next);
  return next;
}

export function loadImportIntent(key: string): Promise<CanvasImportIntent | undefined> {
  return getRecord<CanvasImportIntent>(IMPORT_STORE, key);
}

export async function listProjectImportIntents(accountId: string, projectUuid: string): Promise<CanvasImportIntent[]> {
  const rows = await getAllRecords<CanvasImportIntent>(IMPORT_STORE);
  return rows.filter((row) => row.accountId === accountId && row.projectUuid === projectUuid);
}

export async function deleteImportIntent(intent: CanvasImportIntent): Promise<void> {
  const current = await getRecord<CanvasImportIntent>(IMPORT_STORE, intent.key);
  if (!current) return;
  if (
    current.clientMutationId !== intent.clientMutationId
    || current.requestDigest !== intent.requestDigest
    || current.archiveSha256 !== intent.archiveSha256
  ) {
    return;
  }
  await deleteRecord(IMPORT_STORE, intent.key);
}

export async function commitPendingActionIntent(intent: Omit<CanvasImportActionIntent, "key" | "status">): Promise<CanvasImportActionIntent> {
  const record: CanvasImportActionIntent = {
    ...intent,
    key: importActionKey(intent.accountId, intent.projectUuid, intent.clientActionId),
    status: "pending",
  };
  await putRecord(ACTION_STORE, record);
  return record;
}

export async function upgradeActionIntentAccepted(
  key: string,
  receipt: unknown,
): Promise<CanvasImportActionIntent> {
  const current = await getRecord<CanvasImportActionIntent>(ACTION_STORE, key);
  if (!current) throw new Error("导入动作意图不存在，无法升级");
  const next: CanvasImportActionIntent = {
    ...current,
    status: "accepted",
    receipt,
  };
  await putRecord(ACTION_STORE, next);
  return next;
}

export function loadActionIntent(key: string): Promise<CanvasImportActionIntent | undefined> {
  return getRecord<CanvasImportActionIntent>(ACTION_STORE, key);
}

export async function listProjectActionIntents(accountId: string, projectUuid: string): Promise<CanvasImportActionIntent[]> {
  const rows = await getAllRecords<CanvasImportActionIntent>(ACTION_STORE);
  return rows.filter((row) => row.accountId === accountId && row.projectUuid === projectUuid);
}

export async function deleteActionIntent(intent: CanvasImportActionIntent): Promise<void> {
  const current = await getRecord<CanvasImportActionIntent>(ACTION_STORE, intent.key);
  if (!current) return;
  if (current.clientActionId !== intent.clientActionId || current.requestDigest !== intent.requestDigest) {
    return;
  }
  await deleteRecord(ACTION_STORE, intent.key);
}
