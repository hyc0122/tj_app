import crypto from "node:crypto";
import type { Response } from "express";

import { db } from "@/utils/db";
import { CanvasRuntimeError } from "./canvas-document-service";
import { readCanvasDocument } from "./canvas-document-service";
import { applyCanvasPlan, createCanvasPlan } from "./canvas-plan-service";
import {
  beginCanvasChatReceipt,
  markCanvasChatReceiptOutcomeUnknown,
  readCanvasChatReceipt,
  writeCanvasChatReceipt,
} from "./canvas-chat-receipt";

export type CanvasChatSource = "home" | "chat";

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function assertAssetUuidList(values: unknown, errorCode: string): string[] {
  if (!Array.isArray(values)) {
    throw new CanvasRuntimeError(errorCode, "画布请求不合法", 422, false);
  }
  for (const item of values) {
    if (typeof item !== "string" || !isUuid(item)) {
      throw new CanvasRuntimeError(errorCode, "画布请求不合法", 422, false);
    }
  }
  return values as string[];
}

export async function replayOrBegin(input: {
  clientChatRequestId: string;
  requestDigest: string;
}): Promise<{ replay?: unknown }> {
  const existing = await readCanvasChatReceipt(input.clientChatRequestId);
  if (!existing) return {};
  if (existing.requestDigest !== input.requestDigest) {
    throw new CanvasRuntimeError(
      "CANVAS_CHAT_IDEMPOTENCY_CONFLICT",
      "相同聊天请求 ID 的摘要与首次请求不一致",
      409,
      false,
    );
  }
  if (existing.state === "completed" && existing.responseJson) {
    return { replay: existing.responseJson };
  }
  throw new CanvasRuntimeError(
    "CANVAS_CHAT_RECOVERY_REQUIRED",
    "上次 AI 请求在提交后中断，为避免重复计费已停止自动重试",
    409,
    false,
  );
}

async function assertReadyAttachmentAssets(assetUuids: string[]): Promise<void> {
  if (assetUuids.length === 0) return;
  const countRow = await db("canvas_assets")
    .whereIn("asset_uuid", assetUuids)
    .where({ lifecycle_state: "ready" })
    .count({ count: "*" })
    .first();
  if (Number(countRow?.count ?? 0) !== new Set(assetUuids).size) {
    throw new CanvasRuntimeError("CANVAS_CHAT_REQUEST_INVALID", "附件不属于当前项目或尚未就绪", 422, false);
  }
}

export async function runHomePlan(projectUuid: string, body: {
  prompt: string;
  modelId?: string;
  attachmentAssetUuids: string[];
  baseRevision: number;
  clientChatRequestId: string;
  requestDigest: string;
}): Promise<unknown> {
  const replay = await replayOrBegin(body);
  if (replay.replay) return replay.replay;
  const document = await readCanvasDocument(projectUuid);
  if (document.revision !== 0 || (document.document.graph.nodes?.length ?? 0) > 0) {
    throw new CanvasRuntimeError("CANVAS_HOME_PLAN_NOT_ELIGIBLE", "首页规划资格已失效", 409, false);
  }
  await assertReadyAttachmentAssets(body.attachmentAssetUuids);
  await beginCanvasChatReceipt({
    clientChatRequestId: body.clientChatRequestId,
    requestDigest: body.requestDigest,
    providerIdempotencyKey: body.clientChatRequestId,
    modelId: body.modelId,
  });
  try {
    const plan = await createCanvasPlan({
    projectUuid,
    baseRevision: body.baseRevision,
    source: "home",
    prompt: body.prompt,
    modelId: body.modelId,
    attachmentAssetUuids: body.attachmentAssetUuids,
    referencedNodeUuids: [],
  });
    const applied = await applyCanvasPlan(projectUuid, plan.planUuid, {
    baseRevision: body.baseRevision,
    clientMutationId: crypto.randomUUID(),
  });
    const response = {
    source: "home" as const,
    planUuid: plan.planUuid,
    plan,
    applied,
  };
    await writeCanvasChatReceipt({
    clientChatRequestId: body.clientChatRequestId,
    requestDigest: body.requestDigest,
    providerIdempotencyKey: body.clientChatRequestId,
    responseJson: response,
    planUuid: plan.planUuid,
    state: "completed",
  });
    return response;
  } catch (error) {
    await markCanvasChatReceiptOutcomeUnknown(body.clientChatRequestId).catch(() => undefined);
    throw error;
  }
}

export async function runCanvasChat(projectUuid: string, body: {
  conversationUuid: string;
  prompt: string;
  modelId?: string;
  skillId?: string;
  attachmentAssetUuids: string[];
  referencedNodeUuids: string[];
  baseRevision: number;
  clientChatRequestId: string;
  requestDigest: string;
}, res: Response): Promise<void> {
  const replay = await replayOrBegin(body);
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  if (replay.replay) {
    res.write(`data: ${JSON.stringify(replay.replay)}\n\n`);
    res.end();
    return;
  }
  const document = await readCanvasDocument(projectUuid);
  if (document.revision !== body.baseRevision) {
    throw new CanvasRuntimeError("CANVAS_PLAN_STALE", "计划基于的画布版本已变化", 409, true);
  }
  const nodeIds = new Set((document.document.graph.nodes ?? []).map((item) => (
    String((item as { nodeUuid?: unknown }).nodeUuid ?? "")
  )));
  if (body.referencedNodeUuids.some((nodeUuid) => !nodeIds.has(nodeUuid))) {
    throw new CanvasRuntimeError("CANVAS_CHAT_REQUEST_INVALID", "引用节点不属于当前项目", 422, false);
  }
  await assertReadyAttachmentAssets(body.attachmentAssetUuids);
  await beginCanvasChatReceipt({
    clientChatRequestId: body.clientChatRequestId,
    requestDigest: body.requestDigest,
    providerIdempotencyKey: body.clientChatRequestId,
    modelId: body.modelId,
  });
  try {
    const plan = await createCanvasPlan({
    projectUuid,
    baseRevision: body.baseRevision,
    source: "chat",
    prompt: body.prompt,
    modelId: body.modelId,
    skillId: body.skillId,
    attachmentAssetUuids: body.attachmentAssetUuids,
    referencedNodeUuids: body.referencedNodeUuids,
  });
    const payload = {
    source: "chat" as const,
    conversationUuid: body.conversationUuid,
    planUuid: plan.planUuid,
    plan,
  };
    await writeCanvasChatReceipt({
    clientChatRequestId: body.clientChatRequestId,
    requestDigest: body.requestDigest,
    providerIdempotencyKey: body.clientChatRequestId,
    responseJson: payload,
    planUuid: plan.planUuid,
    state: "completed",
  });
    res.write(`data: ${JSON.stringify({ delta: plan.summary })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true, ...payload })}\n\n`);
    res.end();
  } catch (error) {
    await markCanvasChatReceiptOutcomeUnknown(body.clientChatRequestId).catch(() => undefined);
    throw error;
  }
}
