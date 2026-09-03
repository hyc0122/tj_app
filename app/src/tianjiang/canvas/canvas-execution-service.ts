import crypto from "node:crypto";

import u from "@/utils";
import { db } from "@/utils/db";
import { getStableDeviceUUID } from "../auth/device";
import { upsertPendingMutationJournalInTrx } from "../runtime/legacy-mutation-journal";
import { currentUserStorage } from "../runtime/user-storage-context";
import { canonicalizeJcs } from "./canvas-import-export-service";
import { CanvasRuntimeError, readCanvasDocument, sha256Text } from "./canvas-document-service";
import { readCanvasCancelReceipt, writeCanvasCancelReceipt } from "./canvas-execution-cancel-receipt-store";
import { MAX_CANVAS_NODES } from "../contracts";
import {
  CANVAS_CAPABILITY_REGISTRY_VERSION,
  capabilityForNodeType,
} from "../generation/generation-capability-registry";
import { assertVendorProviderModelAvailable } from "../storyboard/storyboard-generation-service";

export interface ResolvedCanvasExecutionModel {
  modelId: string;
  providerId: string;
  deploymentKey: string;
  credentialSlotId: string;
}

type CanvasExecutionModelResolver = (input: {
  modelId: string;
  mediaType: "image" | "video";
}) => Promise<ResolvedCanvasExecutionModel>;

let testModelResolver: CanvasExecutionModelResolver | undefined;

/** 中文注释：测试必须显式注入假目录，生产环境始终校验当前账号真实模型目录。 */
export function setCanvasExecutionModelResolverForTests(
  resolver: CanvasExecutionModelResolver | undefined,
): void {
  testModelResolver = resolver;
}

async function resolveCanvasExecutionModel(input: {
  modelId: string;
  mediaType: "image" | "video";
}): Promise<ResolvedCanvasExecutionModel> {
  if (testModelResolver) return testModelResolver(input);
  if (!input.modelId || !input.modelId.includes(":")) {
    throw new CanvasRuntimeError("CANVAS_EXECUTION_MODEL_REQUIRED", "生成节点必须选择可用模型", 422, false);
  }
  await assertVendorProviderModelAvailable({
    providerModel: input.modelId,
    mediaType: input.mediaType,
  });
  const [providerId] = input.modelId.split(/:(.+)/);
  return {
    modelId: input.modelId,
    providerId: providerId!,
    deploymentKey: input.modelId,
    // 中文注释：这里只记录账号供应商槽位标识，绝不把 AccessKey 等密钥写进确认单。
    credentialSlotId: providerId!,
  };
}

export const MODEL_CATALOG_VERSION = "canvas-model-catalog.v1";

type StoredCanvasExecutionItem = {
  nodeUuid: string;
  capabilityId: string;
  nodeType: string;
  modelId: string;
  providerId: string;
  deploymentKey: string;
  credentialSlotId: string;
  normalizedParameters: { prompt?: unknown };
  inputAssetUuids: string[];
  itemRequestDigest: string;
};

function rfc3339Ms(date: Date): string {
  return date.toISOString();
}

/** 中文注释：origin device 只来自本机稳定设备文件，禁止 body/header 或账号 ID 覆盖。 */
export function currentOriginDeviceUuid(): string {
  return getStableDeviceUUID(u.getPath());
}

function quoteForPolicy(policy: string): {
  quoteId?: string;
  quoteExpiresAt?: string;
  fee?: {
    amountMinor: string;
    currency: string;
    minorUnit: number;
    maximumAmountMinor?: string;
    displayText: string;
  };
} {
  if (policy === "none") return {};
  const quoteExpiresAt = rfc3339Ms(new Date(Date.now() + 10 * 60_000));
  return {
    quoteId: crypto.randomUUID(),
    quoteExpiresAt,
  };
}

async function confirmationInputsStillMatch(
  document: Awaited<ReturnType<typeof readCanvasDocument>>,
  items: StoredCanvasExecutionItem[],
): Promise<boolean> {
  const nodes = (document.document.graph.nodes ?? []) as Array<{
    nodeUuid?: string;
    kind?: string;
    data?: { prompt?: string; modelId?: string; assetUuid?: string };
  }>;

  try {
    for (const item of items) {
      const node = nodes.find((candidate) => String(candidate.nodeUuid ?? "") === item.nodeUuid);
      if (!node?.kind) return false;
      const capability = capabilityForNodeType(node.kind);
      const mediaType = capability.nodeType === "video_generation" ? "video" : "image";
      const route = await resolveCanvasExecutionModel({
        modelId: String(node.data?.modelId ?? ""),
        mediaType,
      });
      const inputAssetUuids = node.data?.assetUuid ? [node.data.assetUuid] : [];
      if (
        capability.capabilityId !== item.capabilityId
        || capability.nodeType !== item.nodeType
        || route.modelId !== item.modelId
        || route.providerId !== item.providerId
        || route.deploymentKey !== item.deploymentKey
        || route.credentialSlotId !== item.credentialSlotId
        || String(node.data?.prompt ?? "") !== String(item.normalizedParameters?.prompt ?? "")
        || canonicalizeJcs(inputAssetUuids) !== canonicalizeJcs(item.inputAssetUuids ?? [])
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export async function previewCanvasExecution(projectUuid: string, input: {
  baseRevision: number;
  nodeUuids: string[];
}): Promise<unknown> {
  if (
    input.nodeUuids.length === 0
    || input.nodeUuids.length > MAX_CANVAS_NODES
    || new Set(input.nodeUuids).size !== input.nodeUuids.length
  ) {
    throw new CanvasRuntimeError("CANVAS_EXECUTION_PREVIEW_REQUEST_INVALID", "预览节点集合不合法", 422, false);
  }
  const document = await readCanvasDocument(projectUuid);
  if (document.revision !== input.baseRevision) {
    throw new CanvasRuntimeError("CANVAS_CONFIRMATION_STALE", "画布文档版本已变化", 409, true);
  }
  const nodes = (document.document.graph.nodes ?? []) as Array<{
    nodeUuid?: string;
    kind?: string;
    data?: { prompt?: string; modelId?: string; assetUuid?: string };
  }>;
  const items = await Promise.all(input.nodeUuids.map(async (nodeUuid) => {
    const node = nodes.find((item) => item.nodeUuid === nodeUuid);
    if (!node?.kind) {
      throw new CanvasRuntimeError("CANVAS_EXECUTION_PREVIEW_REQUEST_INVALID", "预览节点不属于当前项目", 422, false);
    }
    const capability = capabilityForNodeType(node.kind);
    if (capability.nodeType === "audio") {
      throw new CanvasRuntimeError("CANVAS_EXECUTION_CAPABILITY_INVALID", "画布音频执行器尚未启用", 503, false);
    }
    const route = await resolveCanvasExecutionModel({
      modelId: String(node.data?.modelId ?? ""),
      mediaType: capability.nodeType === "video_generation" ? "video" : "image",
    });
    const quote = quoteForPolicy(capability.billingPolicy);
    if (capability.billingPolicy === "none" && (quote.fee || quote.quoteId)) {
      throw new CanvasRuntimeError("CANVAS_EXECUTION_CAPABILITY_INVALID", "免费能力不得携带报价", 503, false);
    }
    const item = {
      nodeUuid,
      capabilityId: capability.capabilityId,
      nodeType: capability.nodeType,
      modelId: route.modelId,
      providerId: route.providerId,
      deploymentKey: route.deploymentKey,
      credentialSlotId: route.credentialSlotId,
      quoteId: quote.quoteId,
      quoteExpiresAt: quote.quoteExpiresAt,
      parameterSchemaVersion: capability.parameterSchemaVersion,
      normalizedParameters: { prompt: node.data?.prompt ?? "" },
      inputAssetUuids: node.data?.assetUuid ? [node.data.assetUuid] : [],
      requiresConfirmation: capability.requiresConfirmation,
      billingPolicy: capability.billingPolicy,
      fee: quote.fee,
      chargeNotice: capability.billingPolicy === "none" ? undefined : "实际费用以模型服务商结算为准",
    };
    const itemRequestDigest = sha256Text(canonicalizeJcs({
      nodeUuid: item.nodeUuid,
      capabilityId: item.capabilityId,
      modelId: item.modelId,
      providerId: item.providerId,
      deploymentKey: item.deploymentKey,
      credentialSlotId: item.credentialSlotId,
      quoteId: item.quoteId ?? null,
      quoteExpiresAt: item.quoteExpiresAt ?? null,
      amountMinor: item.fee?.amountMinor ?? null,
      currency: item.fee?.currency ?? null,
      minorUnit: item.fee?.minorUnit ?? null,
      maximumAmountMinor: item.fee?.maximumAmountMinor ?? null,
      prompt: item.normalizedParameters.prompt,
    }));
    return { ...item, itemRequestDigest };
  }));
  const paidItemCount = items.filter((item) => item.billingPolicy !== "none").length;
  const confirmationUuid = crypto.randomUUID();
  const originDeviceUuid = currentOriginDeviceUuid();
  const expiresAt = rfc3339Ms(new Date(Date.now() + 5 * 60_000));
  for (const item of items) {
    if (item.quoteExpiresAt && item.quoteExpiresAt < expiresAt) {
      throw new CanvasRuntimeError("CANVAS_EXECUTION_CAPABILITY_INVALID", "报价早于确认过期时间", 503, false);
    }
  }
  const requestDigest = sha256Text(canonicalizeJcs({
    userId: currentUserStorage()?.userId ?? 0,
    projectUuid,
    originDeviceUuid,
    confirmationUuid,
    itemRequestDigests: items.map((item) => item.itemRequestDigest),
    baseRevision: input.baseRevision,
    capabilityRegistryVersion: CANVAS_CAPABILITY_REGISTRY_VERSION,
    modelCatalogVersion: MODEL_CATALOG_VERSION,
    expiresAt,
  }));
  await db("canvas_execution_confirmations").insert({
    confirmation_uuid: confirmationUuid,
    origin_device_uuid: originDeviceUuid,
    document_revision: input.baseRevision,
    request_digest: requestDigest,
    capability_registry_version: CANVAS_CAPABILITY_REGISTRY_VERSION,
    model_catalog_version: MODEL_CATALOG_VERSION,
    immutable_items_json: JSON.stringify(items),
    ordered_request_digests_json: JSON.stringify(items.map((item) => item.itemRequestDigest)),
    first_batch_uuid: null,
    expires_at: expiresAt,
    consumed_at: null,
  });
  return {
    confirmationUuid,
    projectUuid,
    originDeviceUuid,
    documentRevision: input.baseRevision,
    requestDigest,
    capabilityRegistryVersion: CANVAS_CAPABILITY_REGISTRY_VERSION,
    modelCatalogVersion: MODEL_CATALOG_VERSION,
    expiresAt,
    paidItemCount,
    items,
  };
}

export async function confirmCanvasExecution(projectUuid: string, input: {
  confirmationUuid: string;
  requestDigest: string;
  baseRevision: number;
  clientRequestId: string;
}): Promise<unknown> {
  const existing = await db("canvas_execution_batches").where({
    client_request_id: input.clientRequestId,
  }).first();
  if (existing) {
    if (String(existing.request_digest) !== input.requestDigest) {
      throw new CanvasRuntimeError(
        "CANVAS_CONFIRM_IDEMPOTENCY_CONFLICT",
        "相同确认请求 ID 的摘要与首次请求不一致",
        409,
        false,
      );
    }
    return JSON.parse(String(existing.response_json));
  }
  const confirmation = await db("canvas_execution_confirmations").where({
    confirmation_uuid: input.confirmationUuid,
  }).first();
  if (!confirmation) {
    throw new CanvasRuntimeError("CANVAS_CONFIRMATION_NOT_FOUND", "确认单不存在或不可见", 404, false);
  }
  const originDeviceUuid = currentOriginDeviceUuid();
  if (String(confirmation.origin_device_uuid) !== originDeviceUuid) {
    throw new CanvasRuntimeError("CANVAS_CONFIRMATION_ORIGIN_DEVICE_MISMATCH", "仅原设备可确认执行", 403, false);
  }
  if (String(confirmation.request_digest) !== input.requestDigest) {
    throw new CanvasRuntimeError("CANVAS_CONFIRMATION_STALE", "确认摘要已失效", 409, false);
  }
  if (Number(confirmation.document_revision) !== input.baseRevision) {
    throw new CanvasRuntimeError("CANVAS_CONFIRMATION_STALE", "确认基于的画布版本已变化", 409, true);
  }
  const items = JSON.parse(String(confirmation.immutable_items_json)) as StoredCanvasExecutionItem[];
  // 中文注释：客户端回传旧 revision 不能证明执行输入未变化，因此首次消费前读取当前权威文档。
  // 进度、状态、节点位置等非执行字段可在确认框停留期间自动保存；只有提示词、模型、能力或输入资产
  // 变化时才让确认单失效，避免客户端自己的进度保存把视频确认单误判为过期。
  const currentDocument = await readCanvasDocument(projectUuid);
  if (
    currentDocument.revision !== input.baseRevision
    && !(await confirmationInputsStillMatch(currentDocument, items))
  ) {
    throw new CanvasRuntimeError("CANVAS_CONFIRMATION_STALE", "确认基于的画布版本已变化", 409, true);
  }
  if (String(confirmation.expires_at) < rfc3339Ms(new Date())) {
    throw new CanvasRuntimeError("CANVAS_CONFIRMATION_EXPIRED", "确认已过期", 409, false);
  }
  if (confirmation.consumed_at) {
    throw new CanvasRuntimeError("CANVAS_CONFIRMATION_ALREADY_CONSUMED", "确认已被消费", 409, false);
  }
  const batchUuid = crypto.randomUUID();
  const receiptUuid = crypto.randomUUID();
  const acceptedAt = rfc3339Ms(new Date());
  const runs = items.map((item) => ({
    runUuid: crypto.randomUUID(),
    nodeUuid: item.nodeUuid,
    runGeneration: 1,
    state: "waiting_for_origin_device" as const,
  }));
  const receipt = {
    receiptUuid,
    projectUuid,
    batchUuid,
    confirmationUuid: input.confirmationUuid,
    clientRequestId: input.clientRequestId,
    requestDigest: input.requestDigest,
    acceptedAt,
    runs,
  };
  await db.transaction(async (trx) => {
    const consumed = await trx("canvas_execution_confirmations").where({
      confirmation_uuid: input.confirmationUuid,
      consumed_at: null,
    }).update({
      consumed_at: acceptedAt,
      first_batch_uuid: batchUuid,
    });
    if (Number(consumed) !== 1) {
      throw new CanvasRuntimeError("CANVAS_CONFIRMATION_ALREADY_CONSUMED", "确认已被消费", 409, false);
    }
    await trx("canvas_execution_batches").insert({
      batch_uuid: batchUuid,
      confirmation_uuid: input.confirmationUuid,
      client_request_id: input.clientRequestId,
      request_digest: input.requestDigest,
      origin_device_uuid: originDeviceUuid,
      state: "accepted",
      response_json: JSON.stringify(receipt),
      created_by: "canvas-owner",
      created_at: acceptedAt,
    });
    for (const [index, run] of runs.entries()) {
      await trx("canvas_node_runs").insert({
        run_uuid: run.runUuid,
        batch_uuid: batchUuid,
        node_uuid: run.nodeUuid,
        capability_id: items[index]?.capabilityId,
        run_generation: 1,
        // 中文注释：运行行保存完整冻结项，重启恢复时不得重新读取已变化的节点或模型配置。
        normalized_parameters_json: JSON.stringify(items[index] ?? {}),
        task_uuid: null,
        attempt: 0,
        state: "waiting_for_origin_device",
        failure_text: null,
        created_at: acceptedAt,
        updated_at: acceptedAt,
      });
      await trx("canvas_execution_intents").insert({
        intent_uuid: crypto.randomUUID(),
        run_uuid: run.runUuid,
        origin_device_uuid: originDeviceUuid,
        receipt_uuid: receiptUuid,
        state: "pending_origin_device",
        created_at: acceptedAt,
        updated_at: acceptedAt,
      });
    }
    await upsertPendingMutationJournalInTrx(trx, "canvas:execution-confirm");
  });
  const { canvasExecutionRuntime } = await import("./canvas-execution-runtime");
  canvasExecutionRuntime.wake(projectUuid);
  return receipt;
}

export async function cancelCanvasExecution(projectUuid: string, runUuid: string, input: {
  clientActionId: string;
  requestDigest: string;
}): Promise<unknown> {
  const existing = await readCanvasCancelReceipt(runUuid, input.clientActionId);
  if (existing) {
    if (existing.requestDigest !== input.requestDigest) {
      throw new CanvasRuntimeError(
        "CANVAS_EXECUTION_CANCEL_IDEMPOTENCY_CONFLICT",
        "相同取消请求 ID 的摘要与首次请求不一致",
        409,
        false,
      );
    }
    return existing.response;
  }
  const run = await db("canvas_node_runs").where({ run_uuid: runUuid }).first();
  if (!run) {
    throw new CanvasRuntimeError("CANVAS_CONFIRMATION_NOT_FOUND", "执行任务不存在或不可见", 404, false);
  }
  const originDeviceUuid = currentOriginDeviceUuid();
  const intent = await db("canvas_execution_intents").where({ run_uuid: runUuid }).first();
  if (intent && String(intent.origin_device_uuid) !== originDeviceUuid) {
    throw new CanvasRuntimeError(
      "CANVAS_EXECUTION_CANCEL_ORIGIN_DEVICE_MISMATCH",
      "仅原设备可取消收费执行",
      403,
      false,
    );
  }
  const cancellable = new Set(["waiting_for_origin_device", "queued", "leased"]);
  if (!cancellable.has(String(run.state))) {
    throw new CanvasRuntimeError("CANVAS_EXECUTION_NOT_CANCELABLE", "当前执行状态不允许取消", 409, false);
  }
  const now = new Date().toISOString();
  const response = {
    runUuid,
    clientActionId: input.clientActionId,
    requestDigest: input.requestDigest,
    state: "canceled",
    projectUuid,
  };
  await db.transaction(async (trx) => {
    await trx("canvas_node_runs").where({ run_uuid: runUuid }).update({
      state: "canceled",
      updated_at: now,
    });
    if (intent) {
      await trx("canvas_execution_intents").where({ intent_uuid: intent.intent_uuid }).update({
        state: "canceled",
        updated_at: now,
      });
    }
    await upsertPendingMutationJournalInTrx(trx, "canvas:execution-cancel");
  });
  await writeCanvasCancelReceipt({
    runUuid,
    clientActionId: input.clientActionId,
    requestDigest: input.requestDigest,
    response,
  });
  return response;
}
