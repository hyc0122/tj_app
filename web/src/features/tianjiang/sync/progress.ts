export type SyncProgressSnapshot = {
  operationId: string;
  intent: string;
  reason?: string;
  state: "idle" | "running" | "succeeded" | "failed";
  phase: string;
  completedProjects: number;
  totalProjects: number;
  projectUuid?: string;
  projectName?: string;
  projectKind?: "personal" | "team";
  completedObjects: number;
  totalObjects: number;
  objectIndex?: number;
  objectTotal?: number;
  uploadedBytes: number;
  totalBytes: number;
  bytesDone?: number;
  bytesTotal?: number;
  counts: { database: number; image: number; video: number; audio: number; other: number };
  failedObject?: string;
  errorCode?: string;
  errorMessage?: string;
  canCancel?: boolean;
  startedAt?: string;
};

export function isBlockingProgress(progress: SyncProgressSnapshot | null | undefined): boolean {
  return progress?.state === "running";
}

export function formatByteProgress(done: number, total: number): string {
  const safeDone = Math.max(0, done);
  const safeTotal = Math.max(0, total);
  if (safeTotal <= 0) return `${formatBytes(safeDone)}`;
  return `${formatBytes(safeDone)} / ${formatBytes(safeTotal)}`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
