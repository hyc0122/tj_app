/**
 * 同步进度内存仓：只接受单调进度；operationId 隔离迟到事件。
 * 中文注释：进度来自生产运行时真实事件，禁止前端估算假进度。
 * 中文注释：操作级上下文用 AsyncLocalStorage，禁止全局 progressOperationId 串台。
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type SyncProgressIntent =
  | "close_project"
  | "logout"
  | "account_switch"
  | "app_quit"
  | "manual"
  | "auto";

export type SyncProgressState = "idle" | "running" | "succeeded" | "failed";

export type SyncProgressPhase =
  | "preparing"
  | "pause_generation"
  | "save_task"
  | "snapshotting"
  | "validating"
  | "uploading"
  | "downloading"
  | "committing"
  | "finalizing"
  | "releasing"
  | "completed"
  | "failed"
  | "snapshot"
  | "validate"
  | "upload"
  | "commit"
  | "finalize"
  | "release_lock";

export type SyncProgressContext = {
  operationId: string;
  intent: SyncProgressIntent;
  reason?: string;
  totalProjects: number;
  projectUuid?: string;
  projectName?: string;
  projectKind?: "personal" | "team";
};

const progressAls = new AsyncLocalStorage<SyncProgressContext>();

/** 读取当前操作级进度上下文（无则 undefined，禁止回落到其他 operation）。 */
export function currentSyncProgressContext(): SyncProgressContext | undefined {
  return progressAls.getStore();
}

/**
 * 在独立 operation 上下文中运行；try/finally 由 ALS 作用域自动结束。
 * 中文注释：close/logout/checkpoint 必须各自 runWith，禁止共享全局字段。
 */
export async function runWithSyncProgress<T>(
  input: SyncProgressContext,
  fn: () => Promise<T>,
): Promise<T> {
  return progressAls.run(input, async () => {
    syncProgressStore.begin({
      operationId: input.operationId,
      intent: input.intent,
      reason: input.reason,
      totalProjects: input.totalProjects,
      projectUuid: input.projectUuid,
      projectName: input.projectName,
      projectKind: input.projectKind,
    });
    try {
      const result = await fn();
      if (syncProgressStore.get().operationId === input.operationId
        && syncProgressStore.get().state === "running") {
        syncProgressStore.succeed(input.operationId);
      }
      return result;
    } catch (error) {
      if (syncProgressStore.get().operationId === input.operationId
        && syncProgressStore.get().state === "running") {
        syncProgressStore.fail(
          input.operationId,
          "SYNC_PROGRESS_FAILED",
          error instanceof Error ? error.message : "同步失败",
        );
      }
      throw error;
    }
  });
}

export type SyncProgressSnapshot = {
  operationId: string;
  intent: SyncProgressIntent;
  reason?: string;
  state: SyncProgressState;
  phase: SyncProgressPhase;
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

/**
 * 进度更新的内部控制字段不会暴露给前端。
 * 中文注释：候选清单与实际传输清单是两个阶段，进入传输阶段时允许显式重置对象/字节计数。
 */
export type SyncProgressUpdate = Omit<Partial<SyncProgressSnapshot>, "operationId"> & {
  resetTransferCounters?: boolean;
  /** 同一 operation 切换到下一个项目时，允许阶段重新从 preparing 开始。 */
  resetProjectPhase?: boolean;
};

/** 仅当当前 ALS operationId 匹配时更新进度。 */
export function reportSyncProgress(
  partial: SyncProgressUpdate,
): void {
  const ctx = progressAls.getStore();
  if (!ctx?.operationId) return;
  syncProgressStore.update({
    operationId: ctx.operationId,
    ...partial,
  });
}

const PHASE_ORDER: SyncProgressPhase[] = [
  "preparing",
  "snapshot",
  "snapshotting",
  "validate",
  "validating",
  "downloading",
  "uploading",
  "upload",
  "committing",
  "commit",
  "finalizing",
  "finalize",
  "releasing",
  "release_lock",
  "completed",
  "failed",
];

function phaseRank(phase: SyncProgressPhase): number {
  const index = PHASE_ORDER.indexOf(phase);
  return index >= 0 ? index : 0;
}

function sanitizeMessage(message: string | undefined): string | undefined {
  if (!message) return undefined;
  return message
    .replace(/https?:\/\/[^\s]+/gi, "[redacted-url]")
    .replace(/(accessKey|secret|token|signature)=[^\s&]+/gi, "$1=[redacted]");
}

export class SyncProgressStore {
  private current: SyncProgressSnapshot = idleSnapshot();

  get(): SyncProgressSnapshot {
    return structuredClone(this.current);
  }

  begin(input: {
    operationId: string;
    intent: SyncProgressIntent;
    reason?: string;
    totalProjects: number;
    projectUuid?: string;
    projectName?: string;
    projectKind?: "personal" | "team";
  }): void {
    // 中文注释：后台自动 checkpoint 只能在没有前台操作时占用全局展示位。
    // 前台 close/logout/account-switch/app-quit 运行期间，auto 仍可在自己的 ALS 中执行，
    // 但其 begin/report/finish 都不得覆盖用户正在等待的退出进度。
    if (
      this.current.state === "running"
      && this.current.intent !== "auto"
      && input.intent === "auto"
    ) {
      return;
    }
    this.current = {
      operationId: input.operationId,
      intent: input.intent,
      reason: input.reason,
      state: "running",
      phase: "preparing",
      completedProjects: 0,
      totalProjects: Math.max(0, input.totalProjects),
      projectUuid: input.projectUuid,
      projectName: input.projectName,
      projectKind: input.projectKind,
      completedObjects: 0,
      totalObjects: 0,
      objectIndex: 0,
      objectTotal: 0,
      uploadedBytes: 0,
      totalBytes: 0,
      bytesDone: 0,
      bytesTotal: 0,
      counts: { database: 0, image: 0, video: 0, audio: 0, other: 0 },
      canCancel: false,
      startedAt: new Date().toISOString(),
    };
  }

  update(partial: SyncProgressUpdate & { operationId: string }): void {
    if (partial.operationId !== this.current.operationId) return; // 迟到事件丢弃
    if (this.current.state === "idle") return;
    const {
      resetTransferCounters = false,
      resetProjectPhase = false,
      ...snapshotPartial
    } = partial;
    const next = { ...this.current, ...snapshotPartial };
    // 单调：对象/字节/项目完成数不得回退
    next.completedProjects = Math.max(
      this.current.completedProjects,
      snapshotPartial.completedProjects ?? this.current.completedProjects,
    );
    if (resetTransferCounters) {
      // 中文注释：只重置传输维度，不回退 completedProjects，也不改变 operation 所有权。
      next.completedObjects = Math.max(0, snapshotPartial.completedObjects ?? 0);
      next.totalObjects = Math.max(0, snapshotPartial.totalObjects ?? 0);
      next.objectIndex = Math.max(0, snapshotPartial.objectIndex ?? 0);
      next.objectTotal = Math.max(0, snapshotPartial.objectTotal ?? next.totalObjects);
      next.uploadedBytes = Math.max(0, snapshotPartial.uploadedBytes ?? 0);
      next.totalBytes = Math.max(0, snapshotPartial.totalBytes ?? 0);
    } else {
      next.completedObjects = Math.max(
        this.current.completedObjects,
        snapshotPartial.completedObjects ?? this.current.completedObjects,
      );
      next.uploadedBytes = Math.max(
        this.current.uploadedBytes,
        snapshotPartial.uploadedBytes ?? this.current.uploadedBytes,
      );
      next.totalObjects = Math.max(
        this.current.totalObjects,
        snapshotPartial.totalObjects ?? this.current.totalObjects,
      );
      next.totalBytes = Math.max(
        this.current.totalBytes,
        snapshotPartial.totalBytes ?? this.current.totalBytes,
      );
      next.objectIndex = Math.max(
        this.current.objectIndex ?? 0,
        snapshotPartial.objectIndex ?? this.current.objectIndex ?? 0,
      );
      next.objectTotal = Math.max(
        this.current.objectTotal ?? 0,
        snapshotPartial.objectTotal ?? this.current.objectTotal ?? 0,
      );
    }
    next.bytesDone = next.uploadedBytes;
    next.bytesTotal = next.totalBytes;
    if (
      !resetProjectPhase
      &&
      snapshotPartial.phase
      && phaseRank(snapshotPartial.phase) < phaseRank(this.current.phase)
      && snapshotPartial.state !== "failed"
    ) {
      next.phase = this.current.phase;
    }
    next.errorMessage = sanitizeMessage(next.errorMessage);
    this.current = next;
  }

  succeed(operationId: string): void {
    if (operationId !== this.current.operationId) return;
    this.current = {
      ...this.current,
      state: "succeeded",
      phase: "completed",
      completedProjects: Math.max(this.current.completedProjects, this.current.totalProjects),
    };
  }

  fail(operationId: string, errorCode?: string, errorMessage?: string, failedObject?: string): void {
    if (operationId !== this.current.operationId) return;
    this.current = {
      ...this.current,
      state: "failed",
      phase: "failed",
      errorCode,
      errorMessage: sanitizeMessage(errorMessage),
      failedObject,
      canCancel: false,
    };
  }

  clear(operationId?: string): void {
    if (operationId && operationId !== this.current.operationId) return;
    this.current = idleSnapshot();
  }
}

function idleSnapshot(): SyncProgressSnapshot {
  return {
    operationId: "",
    intent: "auto",
    state: "idle",
    phase: "preparing",
    completedProjects: 0,
    totalProjects: 0,
    completedObjects: 0,
    totalObjects: 0,
    uploadedBytes: 0,
    totalBytes: 0,
    counts: { database: 0, image: 0, video: 0, audio: 0, other: 0 },
  };
}

export const syncProgressStore = new SyncProgressStore();
