export interface CanvasRecoveryDraft {
  draftVersion: number;
  clientMutationId: string;
  digest: string;
  baseRevision: number;
  document: unknown;
}

const DB_NAME = "tianjiang-canvas-drafts";

function openDraftDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("drafts", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveRecoveryDraft(key: string, draft: CanvasRecoveryDraft): Promise<void> {
  const db = await openDraftDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("drafts", "readwrite");
    tx.objectStore("drafts").put({ key, ...draft });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadRecoveryDraft(key: string): Promise<CanvasRecoveryDraft | undefined> {
  const db = await openDraftDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("drafts", "readonly");
    const request = tx.objectStore("drafts").get(key);
    request.onsuccess = () => resolve(request.result as CanvasRecoveryDraft | undefined);
    request.onerror = () => reject(request.error);
  });
}
