import { db } from "@/utils/db";
import { currentOriginDeviceUuid } from "./canvas-execution-service";
import { getCanvasOutboxByIdentity, upsertCanvasOutboxRow } from "./canvas-execution-outbox";

/** 中文注释：只按 projectUuid+intentUuid+runUuid 精确打开，禁止扫描全部项目。 */
export async function reconcileCanvasExecutionIntents(projectUuid: string): Promise<number> {
  if (!projectUuid) throw new Error("画布执行协调器缺少 projectUuid");
  const originDeviceUuid = currentOriginDeviceUuid();
  const query = db("canvas_execution_intents").where({
    origin_device_uuid: originDeviceUuid,
    state: "pending_origin_device",
  });
  const rows = await query;
  let bridged = 0;
  for (const row of rows) {
    const intentUuid = String(row.intent_uuid);
    const runUuid = String(row.run_uuid);
    const existing = getCanvasOutboxByIdentity(projectUuid, intentUuid, runUuid);
    if (existing) continue;
    const run = await db("canvas_node_runs").where({ run_uuid: runUuid }).first();
    if (!run) continue;
    const frozen = JSON.parse(String(run.normalized_parameters_json)) as {
      itemRequestDigest?: string;
      providerId?: string;
      deploymentKey?: string;
      credentialSlotId?: string;
    };
    if (!frozen.providerId || !frozen.deploymentKey || !frozen.credentialSlotId || !frozen.itemRequestDigest) {
      throw new Error("画布收费任务缺少冻结的模型路由");
    }
    upsertCanvasOutboxRow({
      intentUuid,
      projectUuid,
      runUuid,
      batchUuid: String(run.batch_uuid),
      originDeviceUuid,
      immutableRequestJson: String(run.normalized_parameters_json),
      requestDigest: frozen.itemRequestDigest,
      providerIdempotencyKey: runUuid,
      providerId: frozen.providerId,
      deploymentKey: frozen.deploymentKey,
      credentialSlotId: frozen.credentialSlotId,
      state: "ready",
    });
    await db("canvas_execution_intents").where({ intent_uuid: intentUuid }).update({
      state: "bridged",
      updated_at: new Date().toISOString(),
    });
    bridged += 1;
  }
  return bridged;
}
