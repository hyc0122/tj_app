import { migrateCanvasExecutionOutbox } from "./canvas-execution-outbox-migration";
import { listPendingCanvasOutboxProjectUuids } from "./canvas-execution-outbox";
import { reconcileCanvasExecutionIntents } from "./canvas-execution-reconciler";
import { drainCanvasExecutionOutbox } from "./canvas-execution-worker";
import "./canvas-execution-outbox";

let paused = false;
let committed = false;
let timer: ReturnType<typeof setInterval> | undefined;
const pendingProjects = new Set<string>();

async function drainProject(projectUuid: string): Promise<void> {
  await reconcileCanvasExecutionIntents(projectUuid);
  await drainCanvasExecutionOutbox(projectUuid);
}

/** 中文注释：唯一生产组合根，作为 lifecycle participant 实现 prepare/commit/rollback。 */
export const canvasExecutionRuntime = {
  async resume(): Promise<void> {
    paused = false;
    committed = false;
    try {
      migrateCanvasExecutionOutbox();
    } catch {
      return;
    }
    // 中文注释：账号切换后必须在新账号 ALS 中重建计时器，禁止复用旧账号闭包。
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      if (!paused) {
        for (const projectUuid of pendingProjects) void drainProject(projectUuid);
      }
    }, 15_000);
    timer.unref?.();
    for (const projectUuid of listPendingCanvasOutboxProjectUuids()) {
      pendingProjects.add(projectUuid);
      void drainProject(projectUuid);
    }
  },
  wake(projectUuid: string): void {
    if (paused) return;
    pendingProjects.add(projectUuid);
    void drainProject(projectUuid);
  },
  async prepare(): Promise<void> {
    paused = true;
  },
  async commit(): Promise<void> {
    paused = true;
    committed = true;
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    pendingProjects.clear();
  },
  async rollback(): Promise<void> {
    if (committed) {
      paused = true;
      return;
    }
    paused = false;
  },
};
