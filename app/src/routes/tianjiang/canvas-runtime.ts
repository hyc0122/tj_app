import express from "express";
import { z } from "zod";

import {
  acceptCanvasTjcanvasImport,
  cancelCanvasImport,
  exportCanvasPortable,
  importCanvasJson,
  importCanvasNovel,
  listActiveCanvasImports,
  readCanvasImportAcceptance,
  readCanvasImportStatus,
  reconcileCanvasImport,
} from "@/tianjiang/canvas/canvas-import-export-service";
import {
  deleteCanvasAsset,
  listCanvasAssets,
  uploadCanvasAsset,
} from "@/tianjiang/canvas/canvas-asset-service";
import {
  CanvasRuntimeError,
  listCanvasRevisions,
  readCanvasDocument,
  restoreCanvasRevision,
  saveCanvasDocument,
} from "@/tianjiang/canvas/canvas-document-service";
import { pinCanvasRevision, unpinCanvasRevision } from "@/tianjiang/canvas/canvas-revision-pin-service";
import {
  assertAssetUuidList,
  runCanvasChat,
  runHomePlan,
} from "@/tianjiang/canvas/canvas-chat-service";
import { applyCanvasPlan } from "@/tianjiang/canvas/canvas-plan-service";
import { cancelCanvasExecution, confirmCanvasExecution, previewCanvasExecution } from "@/tianjiang/canvas/canvas-execution-service";
import { listCanvasExecutions } from "@/tianjiang/canvas/canvas-execution-events";
import { db } from "@/utils/db";
import type { CentralSession } from "@/tianjiang/auth/central-session";
import { withOpenPersonalCanvasProject } from "@/tianjiang/runtime/project-operation-port";
import { RuntimePermissionError } from "@/tianjiang/runtime/sync-coordinator";

const router = express.Router({ mergeParams: true });
const projectUuid = z.string().uuid();
const revisionUuid = z.string().uuid();
const mutationId = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/i);

const saveBodySchema = z.object({
  baseRevision: z.number().int().min(0),
  clientMutationId: mutationId,
  document: z.unknown(),
}).strict();

const restoreBodySchema = z.object({
  baseRevision: z.number().int().min(0),
  clientMutationId: mutationId,
}).strict();

const pinBodySchema = z.object({
  clientMutationId: mutationId,
  requestDigest: digest,
  pinReason: z.string().trim().min(1).max(500),
}).strict();

const unpinBodySchema = z.object({
  clientMutationId: mutationId,
  requestDigest: digest,
  resolutionNote: z.string().trim().min(1).max(500),
}).strict();

const jsonImportBodySchema = z.object({
  baseRevision: z.number().int().min(0),
  clientMutationId: mutationId,
  document: z.unknown(),
}).strict();

const novelImportBodySchema = z.object({
  baseRevision: z.number().int().min(0),
  clientMutationId: mutationId,
  text: z.string().min(1).max(200_000),
}).strict();

function sessionOf(req: express.Request): CentralSession | undefined {
  return (req as { centralSession?: CentralSession }).centralSession;
}

function writeCanvasError(res: express.Response, error: unknown): void {
  if (error instanceof CanvasRuntimeError) {
    res.status(error.status).send({
      code: error.status,
      errorCode: error.errorCode,
      message: error.message,
      retryable: error.retryable,
    });
    return;
  }
  if (error instanceof RuntimePermissionError) {
    res.status(error.status).send({
      code: error.status,
      errorCode: error.errorCode ?? "PERMISSION_DENIED",
      message: error.message,
      retryable: false,
    });
    return;
  }
  const explicitStatus = Number((error as { status?: unknown })?.status);
  const status = Number.isInteger(explicitStatus) ? explicitStatus : 422;
  const errorCode = (error as { errorCode?: unknown } | null)?.errorCode;
  res.status(status).send({
    code: status,
    message: error instanceof Error ? error.message : "画布运行时请求失败",
    ...(typeof errorCode === "string" && errorCode.length > 0 ? { errorCode } : {}),
    retryable: false,
  });
}

async function withCanvas<T>(
  req: express.Request,
  mode: "read" | "write",
  handler: (uuid: string) => Promise<T>,
): Promise<T> {
  const uuid = projectUuid.parse(String(req.params.uuid ?? ""));
  return withOpenPersonalCanvasProject(uuid, mode, async () => handler(uuid), sessionOf(req));
}

router.get("/document", async (req, res) => {
  try {
    const data = await withCanvas(req, "read", (uuid) => readCanvasDocument(uuid));
    res.status(200).send({ code: 0, data, message: "画布文档读取成功" });
  } catch (error) {
    writeCanvasError(res, error);
  }
});

router.put("/document", async (req, res) => {
  try {
    const body = saveBodySchema.parse(req.body);
    const data = await withCanvas(req, "write", (uuid) => saveCanvasDocument(uuid, {
      baseRevision: body.baseRevision,
      clientMutationId: body.clientMutationId,
      document: body.document as never,
    }));
    res.status(200).send({ code: 0, data, message: "画布文档已保存" });
  } catch (error) {
    writeCanvasError(res, error);
  }
});

router.get("/revisions", async (req, res) => {
  try {
    const revisions = await withCanvas(req, "read", async () => listCanvasRevisions());
    res.status(200).send({ code: 0, data: { revisions }, message: "画布历史读取成功" });
  } catch (error) {
    writeCanvasError(res, error);
  }
});

router.post("/revisions/:revisionUuid/restore", async (req, res) => {
  try {
    const target = revisionUuid.parse(String(req.params.revisionUuid ?? ""));
    const body = restoreBodySchema.parse(req.body);
    const data = await withCanvas(req, "write", (uuid) => restoreCanvasRevision(uuid, target, {
      baseRevision: body.baseRevision,
      clientMutationId: body.clientMutationId,
    }));
    res.status(200).send({ code: 0, data, message: "画布历史已恢复" });
  } catch (error) {
    writeCanvasError(res, error);
  }
});

router.post("/revisions/:revisionUuid/pin", async (req, res) => {
  try {
    const target = revisionUuid.parse(String(req.params.revisionUuid ?? ""));
    const body = pinBodySchema.parse(req.body);
    const data = await withCanvas(req, "write", (uuid) => pinCanvasRevision(uuid, target, body));
    res.status(200).send({ code: 0, data, message: "画布恢复点已固定" });
  } catch (error) {
    writeCanvasError(res, error);
  }
});

router.post("/revisions/:revisionUuid/unpin", async (req, res) => {
  try {
    const target = revisionUuid.parse(String(req.params.revisionUuid ?? ""));
    const body = unpinBodySchema.parse(req.body);
    const data = await withCanvas(req, "write", (uuid) => unpinCanvasRevision(uuid, target, body));
    res.status(200).send({ code: 0, data, message: "画布恢复点已解除固定" });
  } catch (error) {
    writeCanvasError(res, error);
  }
});

router.post("/imports/json", async (req, res) => {
  try {
    const body = jsonImportBodySchema.parse(req.body);
    const data = await withCanvas(req, "write", (uuid) => importCanvasJson(uuid, {
      baseRevision: body.baseRevision,
      clientMutationId: body.clientMutationId,
      document: body.document as never,
    }));
    res.status(200).send({ code: 0, data, message: "JSON 已导入画布" });
  } catch (error) {
    writeCanvasError(res, error);
  }
});

router.post("/imports/novel", async (req, res) => {
  try {
    const body = novelImportBodySchema.parse(req.body);
    const data = await withCanvas(req, "write", (uuid) => importCanvasNovel(uuid, {
      baseRevision: body.baseRevision,
      clientMutationId: body.clientMutationId,
      text: body.text,
    }));
    res.status(200).send({ code: 0, data, message: "小说原文已导入画布" });
  } catch (error) {
    writeCanvasError(res, error);
  }
});

router.get("/assets", async (req, res) => {
  try {
    const assets = await withCanvas(req, "read", async () => listCanvasAssets());
    res.status(200).send({ code: 0, data: { assets }, message: "画布素材列表读取成功" });
  } catch (error) {
    writeCanvasError(res, error);
  }
});

router.post("/assets", async (req, res) => {
  try {
    const data = await withCanvas(req, "write", (uuid) => uploadCanvasAsset(req, uuid));
    res.status(200).send({ code: 0, data, message: "画布素材已上传" });
  } catch (error) {
    writeCanvasError(res, error);
  }
});

const deleteAssetBodySchema = z.object({
  clientAssetMutationId: mutationId,
  requestDigest: digest,
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i),
}).strict();

router.delete("/assets/:assetUuid", async (req, res) => {
  try {
    const target = revisionUuid.parse(String(req.params.assetUuid ?? ""));
    const body = deleteAssetBodySchema.parse(req.body);
    const data = await withCanvas(req, "write", (uuid) => deleteCanvasAsset(uuid, target, body));
    res.status(200).send({ code: 0, data, message: "画布素材已删除" });
  } catch (error) {
    writeCanvasError(res, error);
  }
});

router.get("/export", async (req, res) => {
  try {
    const zip = await withCanvas(req, "read", (uuid) => exportCanvasPortable(uuid));
    res.status(200);
    res.setHeader("content-type", "application/zip");
    res.send(zip);
  } catch (error) {
    writeCanvasError(res, error);
  }
});

router.post("/imports/tjcanvas", async (req, res) => {
  try {
    const data = await withCanvas(req, "write", (uuid) => acceptCanvasTjcanvasImport(req, uuid));
    res.status(202).send({ code: 0, data, message: "便携画布导入已接受" });
  } catch (error) {
    writeCanvasError(res, error);
  }
});

router.get("/imports/by-client-mutation/:clientMutationId", async (req, res) => {
  try {
    const clientMutationId = mutationId.parse(String(req.params.clientMutationId ?? ""));
    const data = await withCanvas(req, "read", (uuid) => readCanvasImportAcceptance(uuid, clientMutationId));
    res.status(200).send({ code: 0, data, message: "导入回执读取成功" });
  } catch (error) {
    writeCanvasError(res, error);
  }
});

router.get("/imports/:importUuid", async (req, res) => {
  try {
    const importUuid = revisionUuid.parse(String(req.params.importUuid ?? ""));
    const data = await withCanvas(req, "read", async () => readCanvasImportStatus(importUuid));
    res.status(200).send({ code: 0, data, message: "导入状态读取成功" });
  } catch (error) {
    writeCanvasError(res, error);
  }
});

router.get("/imports", async (req, res) => {
  try {
    const data = await withCanvas(req, "read", async () => listActiveCanvasImports());
    res.status(200).send({ code: 0, data, message: "活动导入读取成功" });
  } catch (error) {
    writeCanvasError(res, error);
  }
});

const importActionBodySchema = z.object({
  clientActionId: mutationId,
  requestDigest: digest,
}).strict();

router.post("/imports/:importUuid/cancel", async (req, res) => {
  try {
    const importUuid = revisionUuid.parse(String(req.params.importUuid ?? ""));
    const body = importActionBodySchema.parse(req.body);
    const data = await withCanvas(req, "write", (uuid) => cancelCanvasImport(uuid, importUuid, body));
    res.status(200).send({ code: 0, data, message: "导入已取消" });
  } catch (error) {
    writeCanvasError(res, error);
  }
});

router.post("/imports/:importUuid/reconcile", async (req, res) => {
  try {
    const importUuid = revisionUuid.parse(String(req.params.importUuid ?? ""));
    const body = importActionBodySchema.parse(req.body);
    const data = await withCanvas(req, "write", async () => reconcileCanvasImport(importUuid, body));
    res.status(200).send({ code: 0, data, message: "导入已对账" });
  } catch (error) {
    writeCanvasError(res, error);
  }
});

const homePlanBodySchema = z.object({
  prompt: z.string().min(1).max(20_000),
  modelId: z.string().min(1).optional(),
  attachmentAssetUuids: z.array(z.string()).default([]),
  baseRevision: z.number().int().min(0),
  clientChatRequestId: mutationId,
  requestDigest: digest,
}).strict();

const chatBodySchema = z.object({
  conversationUuid: mutationId,
  prompt: z.string().min(1).max(200_000),
  modelId: z.string().min(1).optional(),
  skillId: z.string().min(1).optional(),
  attachmentAssetUuids: z.array(z.string()).default([]),
  referencedNodeUuids: z.array(z.string()).default([]),
  baseRevision: z.number().int().min(0),
  clientChatRequestId: mutationId,
  requestDigest: digest,
}).strict();

const applyPlanBodySchema = z.object({
  baseRevision: z.number().int().min(0),
  clientMutationId: mutationId,
  requestDigest: digest.optional(),
}).strict();

function invalidHomePlan(): CanvasRuntimeError {
  return new CanvasRuntimeError("CANVAS_HOME_PLAN_REQUEST_INVALID", "首页规划请求不合法", 422, false);
}

function invalidChat(): CanvasRuntimeError {
  return new CanvasRuntimeError("CANVAS_CHAT_REQUEST_INVALID", "画布聊天请求不合法", 422, false);
}

router.get("/conversations", async (req, res) => {
  try {
    const data = await withCanvas(req, "read", async () => db("canvas_conversations").select("*"));
    res.status(200).send({ code: 0, data, message: "会话列表读取成功" });
  } catch (error) {
    writeCanvasError(res, error);
  }
});

router.post("/conversations", async (req, res) => {
  try {
    const data = await withCanvas(req, "write", async () => {
      const conversationUuid = cryptoRandom();
      const now = new Date().toISOString();
      await db("canvas_conversations").insert({
        conversation_uuid: conversationUuid,
        title: "画布对话",
        created_by: "canvas-owner",
        created_at: now,
        updated_at: now,
      });
      return { conversationUuid };
    });
    res.status(200).send({ code: 0, data, message: "会话已创建" });
  } catch (error) {
    writeCanvasError(res, error);
  }
});

router.get("/conversations/:conversationUuid/messages", async (req, res) => {
  try {
    const conversationUuid = mutationId.parse(String(req.params.conversationUuid ?? ""));
    const data = await withCanvas(req, "read", async () => db("canvas_messages").where({
      conversation_uuid: conversationUuid,
    }));
    res.status(200).send({ code: 0, data, message: "消息列表读取成功" });
  } catch (error) {
    writeCanvasError(res, error);
  }
});

router.post("/home-plan", async (req, res) => {
  try {
    const parsed = homePlanBodySchema.safeParse(req.body);
    if (!parsed.success) throw invalidHomePlan();
    assertAssetUuidList(parsed.data.attachmentAssetUuids, "CANVAS_HOME_PLAN_REQUEST_INVALID");
    const data = await withCanvas(req, "write", (uuid) => runHomePlan(uuid, {
      ...parsed.data,
      attachmentAssetUuids: parsed.data.attachmentAssetUuids,
    }));
    res.status(200).send({ code: 0, data, message: "首页规划已应用" });
  } catch (error) {
    writeCanvasError(res, error);
  }
});

router.post("/chat", async (req, res) => {
  try {
    const parsed = chatBodySchema.safeParse(req.body);
    if (!parsed.success) throw invalidChat();
    assertAssetUuidList(parsed.data.attachmentAssetUuids, "CANVAS_CHAT_REQUEST_INVALID");
    assertAssetUuidList(parsed.data.referencedNodeUuids, "CANVAS_CHAT_REQUEST_INVALID");
    await withCanvas(req, "write", (uuid) => runCanvasChat(uuid, parsed.data, res));
  } catch (error) {
    writeCanvasError(res, error);
  }
});

router.post("/plans/:planUuid/apply", async (req, res) => {
  try {
    const planUuid = mutationId.parse(String(req.params.planUuid ?? ""));
    const parsed = applyPlanBodySchema.safeParse(req.body);
    if (!parsed.success) throw invalidChat();
    const data = await withCanvas(req, "write", (uuid) => applyCanvasPlan(uuid, planUuid, parsed.data));
    res.status(200).send({ code: 0, data, message: "计划已应用" });
  } catch (error) {
    writeCanvasError(res, error);
  }
});

function cryptoRandom(): string {
  return globalThis.crypto.randomUUID();
}

const previewBodySchema = z.object({
  baseRevision: z.number().int().min(0),
  nodeUuids: z.array(mutationId).min(1),
}).strict();

const confirmBodySchema = z.object({
  confirmationUuid: mutationId,
  requestDigest: digest,
  baseRevision: z.number().int().min(0),
  clientRequestId: mutationId,
}).strict();

router.post("/executions/preview", async (req, res) => {
  try {
    const parsed = previewBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new CanvasRuntimeError("CANVAS_EXECUTION_PREVIEW_REQUEST_INVALID", "执行预览请求不合法", 422, false);
    }
    const data = await withCanvas(req, "write", (uuid) => previewCanvasExecution(uuid, parsed.data));
    res.status(200).send({ code: 0, data, message: "执行预览已生成" });
  } catch (error) {
    writeCanvasError(res, error);
  }
});

router.post("/executions/confirm", async (req, res) => {
  try {
    const parsed = confirmBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new CanvasRuntimeError("CANVAS_CONFIRM_REQUEST_INVALID", "执行确认请求不合法", 422, false);
    }
    const data = await withCanvas(req, "write", (uuid) => confirmCanvasExecution(uuid, parsed.data));
    res.status(202).send({
      code: 0,
      data,
      message: "提交已受理，等待原设备进入任务队列",
      retryable: false,
    });
  } catch (error) {
    writeCanvasError(res, error);
  }
});

router.get("/executions", async (req, res) => {
  try {
    const data = await withCanvas(req, "read", (uuid) => listCanvasExecutions(uuid));
    res.status(200).send({ code: 0, data, message: "执行列表读取成功" });
  } catch (error) {
    writeCanvasError(res, error);
  }
});

const cancelBodySchema = z.object({
  clientActionId: mutationId,
  requestDigest: digest,
}).strict();

router.post("/executions/:runUuid/cancel", async (req, res) => {
  try {
    const runUuid = mutationId.parse(String(req.params.runUuid ?? ""));
    const parsed = cancelBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new CanvasRuntimeError("CANVAS_EXECUTION_CANCEL_REQUEST_INVALID", "取消执行请求不合法", 422, false);
    }
    const data = await withCanvas(req, "write", (uuid) => cancelCanvasExecution(uuid, runUuid, parsed.data));
    res.status(200).send({ code: 0, data, message: "执行已取消" });
  } catch (error) {
    writeCanvasError(res, error);
  }
});

export default router;
