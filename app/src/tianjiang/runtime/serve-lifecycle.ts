import type http from "node:http";
import type { WebSocketServer } from "ws";

import type { SocketRuntime } from "@/socket";
import {
  beginDatabaseShutdown,
  destroyAllDatabaseHandles,
  pauseGenerationTaskRecovery,
  resetDatabaseRuntimeForServe,
  resumeGenerationTaskRecovery,
  stopGenerationTaskRecovery,
} from "@/utils/db";
import { syncCoordinator } from "./runtime";
import { serveReadinessGate } from "./serve-readiness";

export interface ServeRuntimeResources {
  httpServer: http.Server;
  socketRuntime: SocketRuntime;
  webSocketRuntime: WebSocketRuntime;
}

export interface WebSocketRuntime {
  beginClosing(): void;
  close(): Promise<void>;
}

/**
 * open → reversible_draining → project_close_commit → irreversible_closing → closed
 *
 * 禁止把完整 closeAll 命名/伪装成 preflight；项目关闭在排空之后的 commit 阶段。
 */
export type ServeClosePhase =
  | "open"
  | "reversible_draining"
  | "project_close_commit"
  | "irreversible_closing"
  | "closed";

export interface ServeLifecycleOperations {
  /** 可恢复：暂停 generation 轮询并等待在途 */
  pauseGenerationRecovery(): Promise<void>;
  resumeGenerationRecovery(): void;
  /** 可恢复：暂停 pending consumer 并等待在途 */
  beginProjectCloseDrain(): Promise<void>;
  resumeProjectCloseDrain(): void;
  stopGenerationRecovery(): Promise<void>;
  stopProfileKeyRecovery(): Promise<void>;
  /**
   * 活动写 handler 已排空后：批量 attempt + 全有或全无 commit dispose。
   * 阻断时 throw，调用方必须 resume 接入。
   */
  commitProjectCloses(): Promise<void>;
  finalSync(): Promise<void>;
  destroyDatabases(): Promise<void>;
}

export interface ServeRuntimeSnapshot {
  phase: ServeClosePhase;
  closing: boolean;
  reversibleDraining: boolean;
  projectCloseCommitComplete: boolean;
  acceptingHttpRequests: boolean;
  activeRequestCount: number;
  activeRequestsDrained: boolean;
  acceptingSocketEvents: boolean;
  activeSocketHandlerCount: number;
  socketHandlersDrained: boolean;
  acceptingWebSocketConnections: boolean;
  generationRecoveryStopped: boolean;
  profileKeyRecoveryStopped: boolean;
  socketIOActive: boolean;
  webSocketActive: boolean;
  finalSyncComplete: boolean;
  databaseHandlesClosed: boolean;
  httpListening: boolean;
  closed: boolean;
  /** @deprecated 使用 phase / projectCloseCommitComplete */
  preflightPersonalCloseComplete: boolean;
}

let resources: ServeRuntimeResources | undefined;
let running: Promise<void> | undefined;
let httpClosePromise: Promise<void> | undefined;
let profileKeyRecoveryStopPromise: Promise<void> | undefined;
let operations = defaultOperations();
let state: ServeRuntimeSnapshot = emptyState();

/** 服务启动完成后登记真实传输层；同一进程只允许一个活动装配。 */
export function registerServeRuntimeResources(
  next: ServeRuntimeResources,
  overrides: Partial<ServeLifecycleOperations> = {},
): void {
  if (resources && !state.closed) throw new Error("本地服务运行资源已经登记");
  resources = next;
  running = undefined;
  httpClosePromise = undefined;
  profileKeyRecoveryStopPromise = undefined;
  operations = { ...defaultOperations(), ...overrides };
  resetDatabaseRuntimeForServe();
  if (!serveReadinessGate.snapshot().accepting) serveReadinessGate.startAccepting();
  state = {
    phase: "open",
    closing: false,
    reversibleDraining: false,
    projectCloseCommitComplete: false,
    acceptingHttpRequests: true,
    activeRequestCount: 0,
    activeRequestsDrained: false,
    acceptingSocketEvents: true,
    activeSocketHandlerCount: 0,
    socketHandlersDrained: false,
    acceptingWebSocketConnections: true,
    generationRecoveryStopped: false,
    profileKeyRecoveryStopped: false,
    socketIOActive: true,
    webSocketActive: true,
    finalSyncComplete: false,
    databaseHandlesClosed: false,
    httpListening: next.httpServer.listening,
    closed: false,
    preflightPersonalCloseComplete: false,
  };
}

export function serveRuntimeSnapshot(): ServeRuntimeSnapshot {
  const readiness = serveReadinessGate.snapshot();
  const socketActivity = resources?.socketRuntime.snapshot();
  return {
    ...state,
    phase: state.closed ? "closed" : state.phase,
    acceptingHttpRequests: readiness.accepting,
    reversibleDraining: readiness.reversibleDraining,
    activeRequestCount: readiness.activeRequestCount,
    acceptingSocketEvents: socketActivity?.acceptingEvents ?? false,
    activeSocketHandlerCount: socketActivity?.activeHandlerCount ?? 0,
    httpListening: resources?.httpServer.listening ?? false,
    preflightPersonalCloseComplete: state.projectCloseCommitComplete,
  };
}

/**
 * 本地服务唯一关闭装配：
 * reversible_draining → project_close_commit → irreversible_closing → closed
 * 并发或重复调用复用同一结果；项目关闭阻断时恢复接入，绝不半关闭。
 */
export function closeServe(): Promise<void> {
  if (state.closed) return Promise.resolve();
  if (running) return running;
  running = executeClose().finally(() => {
    if (!state.closed) running = undefined;
  });
  return running;
}

function errorCodeOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * 倒序恢复可逆关闭阶段；任一恢复失败都把 HTTP/Socket 重新压回 drain。
 * 中文注释：初始 drain 失败与 project_close_commit 失败必须共用同一套 fail-closed 语义。
 */
function restoreReversibleDrain(input: {
  projectDrainStarted: boolean;
  generationPauseStarted: boolean;
  socketDrainStarted: boolean;
  httpDrainStarted: boolean;
  originalError: unknown;
}): void {
  let resumeError: unknown;
  const captureResumeError = (error: unknown) => {
    if (resumeError === undefined) resumeError = error;
  };
  if (input.projectDrainStarted) {
    try {
      operations.resumeProjectCloseDrain();
    } catch (error) {
      captureResumeError(error);
    }
  }
  if (input.generationPauseStarted) {
    try {
      operations.resumeGenerationRecovery();
    } catch (error) {
      captureResumeError(error);
    }
  }
  // 中文注释：后台阶段全部恢复后才开放 Socket，再成功后才开放 HTTP。
  if (resumeError === undefined && input.socketDrainStarted && resources) {
    try {
      resources.socketRuntime.resumeAccepting();
    } catch (error) {
      captureResumeError(error);
    }
  }
  if (resumeError === undefined && input.httpDrainStarted) {
    try {
      serveReadinessGate.resumeAccepting();
    } catch (error) {
      captureResumeError(error);
    }
  }

  state.activeRequestsDrained = false;
  state.socketHandlersDrained = false;
  if (resumeError !== undefined) {
    // resume 可能先开放后抛错；再次调用 drain 将部分开放状态压回失败关闭。
    try {
      resources?.socketRuntime.beginReversibleDraining();
    } catch (error) {
      captureResumeError(error);
    }
    try {
      serveReadinessGate.beginReversibleDraining();
    } catch (error) {
      captureResumeError(error);
    }
    state.phase = "reversible_draining";
    state.reversibleDraining = true;
    throw Object.assign(new Error("退出准备恢复失败，请重试关闭"), {
      code: "DRAIN_RESUME_FAILED",
      cause: resumeError,
      drainError: input.originalError,
    });
  }

  state.phase = "open";
  state.reversibleDraining = false;
}

/**
 * 可恢复 drain 幂等阶段：未完成 project_close_commit 时每次关闭都必须真实 waitForDrain。
 * 中文注释：部分 resume 失败后 phase 可能停在 reversible_draining，禁止跳过排空直接 commit。
 */
async function ensureReversibleDrain(): Promise<void> {
  state.phase = "reversible_draining";
  state.reversibleDraining = true;
  // 中文注释：作废缓存，强制本轮重新排空
  state.activeRequestsDrained = false;
  state.socketHandlersDrained = false;
  let httpDrainStarted = false;
  let socketDrainStarted = false;
  let generationPauseStarted = false;
  let projectDrainStarted = false;
  try {
    httpDrainStarted = true;
    serveReadinessGate.beginReversibleDraining();
    if (resources) {
      socketDrainStarted = true;
      resources.socketRuntime.beginReversibleDraining();
    }
    await serveReadinessGate.waitForDrain();
    if (resources) await resources.socketRuntime.waitForDrain();
    generationPauseStarted = true;
    await operations.pauseGenerationRecovery();
    projectDrainStarted = true;
    await operations.beginProjectCloseDrain();
    state.activeRequestsDrained = true;
    state.socketHandlersDrained = true;
  } catch (drainError) {
    restoreReversibleDrain({
      projectDrainStarted,
      generationPauseStarted,
      socketDrainStarted,
      httpDrainStarted,
      originalError: drainError,
    });
    throw drainError;
  }
}

async function executeClose(): Promise<void> {
  let drainStarted = false;
  let projectsClosedOk = false;

  // —— 1) reversible_draining：禁止新写，排空活动 handler + 后台写 ——
  // 中文注释：projectCloseCommitComplete 为 false 时必须 ensure drain（含重试路径）
  if (!state.projectCloseCommitComplete) {
    await ensureReversibleDrain();
    drainStarted = true;
  }

  // —— 2) project_close_commit：排空后关闭项目；阻断则 fail-closed 恢复 ——
  if (!state.projectCloseCommitComplete) {
    state.phase = "project_close_commit";
    try {
      await operations.commitProjectCloses();
      state.projectCloseCommitComplete = true;
      state.preflightPersonalCloseComplete = true;
      projectsClosedOk = true;
    } catch (error) {
      if (drainStarted && !projectsClosedOk) {
        const code = errorCodeOf(error);
        // 中文注释：已 dispose 且尚未 reopen，恢复接入会暴露半恢复 runtime
        if (
          code === "PERSONAL_CLOSE_COMPENSATION_FAILED"
          || code === "TEAM_CLOSE_COMPENSATION_FAILED"
        ) {
          state.phase = "reversible_draining";
          state.reversibleDraining = true;
          state.activeRequestsDrained = true;
          state.socketHandlersDrained = true;
          throw error;
        }
        // 中文注释：普通 PERSONAL_CLOSE_BLOCKED 等可恢复：倒序 resume
        restoreReversibleDrain({
          projectDrainStarted: true,
          generationPauseStarted: true,
          socketDrainStarted: Boolean(resources),
          httpDrainStarted: true,
          originalError: error,
        });
      }
      throw error;
    }
  }

  // —— 3) irreversible_closing：此后不得恢复业务接入 ——
  state.phase = "irreversible_closing";
  state.closing = true;
  state.reversibleDraining = false;
  serveReadinessGate.beginClosing();
  beginDatabaseShutdown();
  state.acceptingHttpRequests = false;
  if (resources && !httpClosePromise) {
    httpClosePromise = closeHttpServer(resources.httpServer);
    void httpClosePromise.catch(() => undefined);
  }
  if (resources) {
    resources.socketRuntime.beginClosing();
    resources.webSocketRuntime.beginClosing();
    state.acceptingSocketEvents = false;
    state.acceptingWebSocketConnections = false;
  }
  if (!state.profileKeyRecoveryStopped && !profileKeyRecoveryStopPromise) {
    profileKeyRecoveryStopPromise = beginOperation(operations.stopProfileKeyRecovery);
    void profileKeyRecoveryStopPromise.catch(() => undefined);
  }

  // 不可逆阶段再次确认排空（可能有竞态晚到请求已被 503）
  if (!state.activeRequestsDrained) {
    await serveReadinessGate.waitForDrain();
    state.activeRequestsDrained = true;
  }

  if (!state.generationRecoveryStopped) {
    await operations.stopGenerationRecovery();
    state.generationRecoveryStopped = true;
  }

  if (!state.socketHandlersDrained && resources) {
    await resources.socketRuntime.waitForDrain();
    state.socketHandlersDrained = true;
  }
  if (state.socketIOActive && resources) {
    await resources.socketRuntime.close();
    state.socketIOActive = false;
  }
  if (state.webSocketActive && resources) {
    await resources.webSocketRuntime.close();
    state.webSocketActive = false;
  }

  if (!state.profileKeyRecoveryStopped && profileKeyRecoveryStopPromise) {
    try {
      await profileKeyRecoveryStopPromise;
      state.profileKeyRecoveryStopped = true;
    } catch (error) {
      profileKeyRecoveryStopPromise = undefined;
      throw error;
    }
  }

  // 项目已在 commit 阶段关闭；finalSync 负责 profile flush / 句柄收尾。
  // 中文注释：首屏打开不得等待设置校准；关闭时才排空在途 reconcile。
  if (!state.finalSyncComplete) {
    await operations.finalSync();
    state.finalSyncComplete = true;
  }

  if (!state.databaseHandlesClosed) {
    await operations.destroyDatabases();
    state.databaseHandlesClosed = true;
  }

  resources?.httpServer.closeAllConnections?.();
  if (httpClosePromise) {
    try {
      await httpClosePromise;
    } catch (error) {
      httpClosePromise = undefined;
      throw error;
    }
  }
  state.httpListening = false;
  state.closed = true;
  state.phase = "closed";
}

async function closeHttpServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    });
  });
}

/** express-ws 传输层包装：同步摘除 upgrade 入口并终止客户端，异步等待 WSS 真正关闭。 */
export function createWebSocketRuntime(
  server: WebSocketServer,
  stopAccepting: () => void = () => undefined,
): WebSocketRuntime {
  let accepting = true;
  let closePromise: Promise<void> | undefined;
  const beginClosing = () => {
    if (!accepting) return;
    accepting = false;
    stopAccepting();
    for (const client of server.clients) client.terminate();
  };
  return {
    beginClosing,
    async close(): Promise<void> {
      beginClosing();
      if (!closePromise) {
        closePromise = new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
        void closePromise.catch(() => undefined);
      }
      try {
        await closePromise;
      } catch (error) {
        closePromise = undefined;
        throw error;
      }
    },
  };
}

function defaultOperations(): ServeLifecycleOperations {
  return {
    pauseGenerationRecovery: () => pauseGenerationTaskRecovery(),
    resumeGenerationRecovery: () => resumeGenerationTaskRecovery(),
    beginProjectCloseDrain: () => syncCoordinator.beginProjectCloseDrain(),
    resumeProjectCloseDrain: () => syncCoordinator.resumeProjectCloseDrain(),
    stopGenerationRecovery: stopGenerationTaskRecovery,
    stopProfileKeyRecovery: () => syncCoordinator.stopBackgroundWork(),
    // 排空后的项目关闭提交（非 preflight 包装 closeAll）
    commitProjectCloses: () => syncCoordinator.commitProjectClosesForOrdinaryShutdown(),
    finalSync: () => syncCoordinator.shutdown(),
    destroyDatabases: destroyAllDatabaseHandles,
  };
}

function beginOperation(operation: () => Promise<void>): Promise<void> {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(error);
  }
}

function emptyState(): ServeRuntimeSnapshot {
  return {
    phase: "open",
    closing: false,
    reversibleDraining: false,
    projectCloseCommitComplete: false,
    acceptingHttpRequests: false,
    activeRequestCount: 0,
    activeRequestsDrained: false,
    acceptingSocketEvents: false,
    activeSocketHandlerCount: 0,
    socketHandlersDrained: false,
    acceptingWebSocketConnections: false,
    generationRecoveryStopped: false,
    profileKeyRecoveryStopped: false,
    socketIOActive: false,
    webSocketActive: false,
    finalSyncComplete: false,
    databaseHandlesClosed: false,
    httpListening: false,
    closed: false,
    preflightPersonalCloseComplete: false,
  };
}

/**
 * 测试专用：强制复位 serve 生命周期。
 * 生产路径不得调用。
 */
export function resetServeLifecycleForTests(): void {
  resources = undefined;
  running = undefined;
  httpClosePromise = undefined;
  profileKeyRecoveryStopPromise = undefined;
  operations = defaultOperations();
  state = emptyState();
}
