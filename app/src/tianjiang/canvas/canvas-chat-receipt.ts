import { db } from "@/utils/db";

export interface CanvasChatReceiptRow {
  clientChatRequestId: string;
  requestDigest: string;
  responseJson: unknown;
  planUuid?: string;
  state: string;
}

/** 中文注释：聊天/规划回执按 clientChatRequestId 耐久保存，丢失响应后只允许原摘要回放。 */
export async function readCanvasChatReceipt(clientChatRequestId: string): Promise<CanvasChatReceiptRow | undefined> {
  const row = await db("canvas_chat_requests").where({
    client_chat_request_id: clientChatRequestId,
  }).first();
  if (!row) return undefined;
  return {
    clientChatRequestId: String(row.client_chat_request_id),
    requestDigest: String(row.request_digest),
    responseJson: row.response_json ? JSON.parse(String(row.response_json)) : null,
    planUuid: row.plan_uuid ? String(row.plan_uuid) : undefined,
    state: String(row.state),
  };
}

function receiptRoute(modelId?: string): {
  providerId: string;
  deploymentKey: string;
  credentialSlotId: string;
} {
  const deploymentKey = String(modelId ?? "universalAi").trim() || "universalAi";
  const separator = deploymentKey.indexOf(":");
  const providerId = separator > 0 ? deploymentKey.slice(0, separator) : "account-deployment";
  return { providerId, deploymentKey, credentialSlotId: providerId };
}

/** 中文注释：调用模型前先写 submitting，进程崩溃后不得把同一幂等键再次提交给供应商。 */
export async function beginCanvasChatReceipt(input: {
  clientChatRequestId: string;
  requestDigest: string;
  providerIdempotencyKey: string;
  modelId?: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const route = receiptRoute(input.modelId);
  await db("canvas_chat_requests").insert({
    client_chat_request_id: input.clientChatRequestId,
    request_digest: input.requestDigest,
    provider_idempotency_key: input.providerIdempotencyKey,
    provider_id: route.providerId,
    deployment_key: route.deploymentKey,
    credential_slot_id: route.credentialSlotId,
    model_catalog_version: "1",
    can_query_by_client_key: 0,
    can_replay_same_idempotency_key: 0,
    submission_generation: 1,
    dispatch_started_at: now,
    remote_request_id: null,
    state: "submitting",
    user_message_uuid: null,
    assistant_message_uuid: null,
    plan_uuid: null,
    response_json: null,
    created_at: now,
    updated_at: now,
  });
}

export async function markCanvasChatReceiptOutcomeUnknown(clientChatRequestId: string): Promise<void> {
  await db("canvas_chat_requests").where({
    client_chat_request_id: clientChatRequestId,
    state: "submitting",
  }).update({
    state: "outcome_unknown",
    updated_at: new Date().toISOString(),
  });
}

export async function writeCanvasChatReceipt(input: {
  clientChatRequestId: string;
  requestDigest: string;
  providerIdempotencyKey: string;
  responseJson: unknown;
  planUuid?: string;
  state: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const affected = await db("canvas_chat_requests").where({
    client_chat_request_id: input.clientChatRequestId,
    request_digest: input.requestDigest,
    state: "submitting",
  }).update({
    state: input.state,
    plan_uuid: input.planUuid ?? null,
    response_json: JSON.stringify(input.responseJson),
    updated_at: now,
  });
  if (Number(affected) !== 1) throw new Error("画布 AI 回执状态已变化，拒绝覆盖");
}
