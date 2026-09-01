import { db } from "@/utils/db";
import { CanvasRuntimeError } from "./canvas-document-service";

export async function replayOrStoreImportAction(input: {
  importUuid: string;
  actionType: "cancel" | "reconcile";
  clientActionId: string;
  requestDigest: string;
  response: unknown;
}): Promise<{ replayed: boolean; response: unknown }> {
  const existing = await db("canvas_import_action_receipts").where({
    import_uuid: input.importUuid,
    action_type: input.actionType,
    client_action_id: input.clientActionId,
  }).first();
  if (existing) {
    if (String(existing.request_digest) !== input.requestDigest) {
      throw new CanvasRuntimeError(
        "CANVAS_MUTATION_IDEMPOTENCY_CONFLICT",
        "相同文档变更 ID 的摘要与首次请求不一致",
        409,
        false,
      );
    }
    return { replayed: true, response: JSON.parse(String(existing.response_json)) };
  }
  await db("canvas_import_action_receipts").insert({
    import_uuid: input.importUuid,
    action_type: input.actionType,
    client_action_id: input.clientActionId,
    request_digest: input.requestDigest,
    response_json: JSON.stringify(input.response),
    audit_uuid: crypto.randomUUID(),
    created_at: new Date().toISOString(),
  });
  return { replayed: false, response: input.response };
}
