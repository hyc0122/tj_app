import { decideDurableGenerationRecovery } from "../generation/durable-generation-worker";
import u from "@/utils";
import { runWithProjectStorage } from "../runtime/user-storage-context";
import { acquireProjectDatabaseLease, releaseProjectDatabaseLease } from "@/utils/db";
import { createGenerationCompletionContract } from "../tasks/generation-completion-contract";
import {
  getCanvasOutboxByIdentity,
  listReadyCanvasOutbox,
  openCanvasExecutionOutbox,
  updateCanvasOutboxState,
  type CanvasOutboxRow,
} from "./canvas-execution-outbox";
import { ingestCanvasProviderEvent, type ProviderResultEventSink } from "./canvas-execution-events";

export type { ProviderResultEventSink };
export const providerResultEventSink: ProviderResultEventSink = ingestCanvasProviderEvent;

export interface CanvasExecutionWorkerInput {
  projectUuid: string;
  runUuid: string;
  nodeUuid: string;
  capabilityId: string;
  modelId: string;
  providerId: string;
  normalizedParameters: Record<string, unknown>;
  inputAssetUuids: string[];
}

type CanvasExecutionWorkerAdapter = (input: CanvasExecutionWorkerInput) => Promise<void | "deferred">;
let testWorkerAdapter: CanvasExecutionWorkerAdapter | undefined;

/** 中文注释：仅测试可注入零费用适配器；生产路径总是调用账号已配置模型。 */
export function setCanvasExecutionWorkerAdapterForTests(
  adapter: CanvasExecutionWorkerAdapter | undefined,
): void {
  testWorkerAdapter = adapter;
}

/** 中文注释：进入 submitting 后不得退回 ready；无查询能力则 outcome_unknown。 */
export function claimCanvasOutbox(projectUuid: string, intentUuid: string, runUuid: string): boolean {
  const existing = getCanvasOutboxByIdentity(projectUuid, intentUuid, runUuid);
  if (!existing) return false;
  const db = openCanvasExecutionOutbox();
  try {
    const affected = db.prepare(`
      UPDATE canvas_execution_outbox
      SET state = 'leased'
      WHERE project_uuid = ? AND intent_uuid = ? AND run_uuid = ? AND state = 'ready'
    `).run(projectUuid, intentUuid, runUuid);
    return Number(affected.changes) === 1;
  } finally {
    db.close();
  }
}

export function markCanvasOutboxSubmitting(projectUuid: string, intentUuid: string, runUuid: string): void {
  const db = openCanvasExecutionOutbox();
  try {
    db.prepare(`
      UPDATE canvas_execution_outbox
      SET state = 'submitting', dispatch_started_at = ?
      WHERE project_uuid = ? AND intent_uuid = ? AND run_uuid = ?
    `).run(new Date().toISOString(), projectUuid, intentUuid, runUuid);
  } finally {
    db.close();
  }
}

async function executeProductionCanvasGeneration(input: CanvasExecutionWorkerInput): Promise<void> {
  const prompt = String(input.normalizedParameters.prompt ?? "");
  const isVideo = input.capabilityId === "canvas.video.generate";
  const relativePath = isVideo
    ? `files/videos/${input.runUuid}.mp4`
    : `files/images/${input.runUuid}.png`;
  const relatedObjects = JSON.stringify(createGenerationCompletionContract({
    kind: "canvas-generation",
    mediaType: isVideo ? "video" : "image",
    relativePath,
    canvasRunUuid: input.runUuid,
    canvasNodeUuid: input.nodeUuid,
  }));
  const taskRecord = {
    taskClass: "canvas-generation",
    describe: `画布节点 ${input.nodeUuid} 生成`,
    relatedObjects,
    projectId: 0,
  };
  if (isVideo) {
    await u.Ai.Video(input.modelId as `${string}:${string}`).run({
      duration: Number(input.normalizedParameters.duration ?? 5),
      resolution: String(input.normalizedParameters.resolution ?? "720p"),
      aspectRatio: String(input.normalizedParameters.aspectRatio ?? "16:9") as "16:9" | "9:16",
      prompt,
      mode: ["text"],
    }, taskRecord);
    return;
  }
  await u.Ai.Image(input.modelId as `${string}:${string}`).run({
    prompt,
    size: String(input.normalizedParameters.size ?? "2K") as "1K" | "2K" | "4K",
    aspectRatio: String(input.normalizedParameters.aspectRatio ?? "16:9") as `${number}:${number}`,
  }, taskRecord);
}

function parseFrozenOutbox(row: CanvasOutboxRow): CanvasExecutionWorkerInput {
  const frozen = JSON.parse(row.immutableRequestJson) as {
    nodeUuid?: string;
    capabilityId?: string;
    modelId?: string;
    providerId?: string;
    normalizedParameters?: Record<string, unknown>;
    inputAssetUuids?: string[];
  };
  if (
    !frozen.nodeUuid
    || !frozen.capabilityId
    || !frozen.modelId
    || frozen.providerId !== row.providerId
  ) {
    throw new Error("设备 outbox 冻结请求不完整或路由不一致");
  }
  return {
    projectUuid: row.projectUuid,
    runUuid: row.runUuid,
    nodeUuid: frozen.nodeUuid,
    capabilityId: frozen.capabilityId,
    modelId: frozen.modelId,
    providerId: frozen.providerId,
    normalizedParameters: frozen.normalizedParameters ?? {},
    inputAssetUuids: Array.isArray(frozen.inputAssetUuids) ? frozen.inputAssetUuids : [],
  };
}

async function executeCanvasOutboxRow(row: CanvasOutboxRow): Promise<void> {
  if (!claimCanvasOutbox(row.projectUuid, row.intentUuid, row.runUuid)) return;
  markCanvasOutboxSubmitting(row.projectUuid, row.intentUuid, row.runUuid);
  try {
    const input = parseFrozenOutbox(row);
    const outcome = await (testWorkerAdapter ?? executeProductionCanvasGeneration)(input);
    if (outcome === "deferred") {
      // 中文注释：HTTP 合同夹具只验证确认/事件时可延后消费，不能误触真实供应商。
      updateCanvasOutboxState(row.projectUuid, row.intentUuid, row.runUuid, "ready");
      return;
    }
    updateCanvasOutboxState(row.projectUuid, row.intentUuid, row.runUuid, "succeeded");
    await u.db("canvas_node_runs").where({ run_uuid: row.runUuid }).update({
      state: "succeeded",
      failure_text: null,
      updated_at: new Date().toISOString(),
    });
  } catch (error) {
    updateCanvasOutboxState(row.projectUuid, row.intentUuid, row.runUuid, "failed");
    await u.db("canvas_node_runs").where({ run_uuid: row.runUuid }).update({
      state: "failed",
      failure_text: u.error(error).message,
      updated_at: new Date().toISOString(),
    });
  }
}

export async function drainCanvasExecutionOutbox(projectUuid: string): Promise<number> {
  if (!projectUuid) throw new Error("画布执行器缺少 projectUuid");
  await acquireProjectDatabaseLease(projectUuid, "scheduler");
  try {
    return await runWithProjectStorage(projectUuid, async () => {
      const rows = listReadyCanvasOutbox(projectUuid);
      for (const row of rows) await executeCanvasOutboxRow(row);
      return rows.length;
    });
  } finally {
    // 中文注释：收费任务执行完立即释放项目句柄，切换项目后不长期占用内存。
    await releaseProjectDatabaseLease(projectUuid, "scheduler");
  }
}

export function recoverSubmittingOutbox(hasRemoteTaskId: boolean, canQuery: boolean, canReplay: boolean): string {
  const decision = decideDurableGenerationRecovery({
    state: "submitting",
    capabilities: {
      canQueryByClientKey: canQuery,
      canReplaySameIdempotencyKey: canReplay,
      adapterProtocolVersion: "1",
    },
    hasRemoteTaskId,
  });
  return decision.nextState;
}

void recoverSubmittingOutbox;
export const OUTCOME_UNKNOWN = "outcome_unknown";
