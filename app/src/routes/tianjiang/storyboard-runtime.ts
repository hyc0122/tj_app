import express from "express";
import { z } from "zod";

import {
  adaptVendorGenerationRequest,
  assertVendorProviderModelAvailable,
  assertStoryboardGenerationRoute,
  classifyStoryboardGenerationRoute,
  createStoryboardGenerationPreviewDigest,
  parseDreaminaVideoModel,
  prepareDreaminaStoryboardGenerationRequest,
  prepareVendorStoryboardGenerationRequest,
  sanitizeStoryboardGenerationPreview,
} from "@/tianjiang/storyboard/storyboard-generation-service";
import {
  createEnqueueRequestIntentDigest,
  DreaminaEnqueueError,
  enqueueAsyncMediaTasks,
  MAX_DREAMINA_ENQUEUE_ITEMS,
  normalizeDreaminaClientOperationId,
  replayAcceptedDreaminaEnqueue,
} from "@/tianjiang/model-providers/async-generation-service";
import { sharedAssetGateway } from "@/tianjiang/storyboard/shared-asset-gateway";
import { StoryboardService } from "@/tianjiang/storyboard/storyboard-service";
import {
  projectOperationPort,
  enterTeamWriteGuard,
  teamWriteGuardFromHeaders,
} from "@/tianjiang/runtime/project-operation-port";
import { RuntimePermissionError } from "@/tianjiang/runtime/sync-coordinator";
import {
  readSafeVendorStagingStep,
} from "@/tianjiang/storyboard/vendor-generation-safety";
import { listStoryboardVideoStyles } from "@/tianjiang/storyboard/storyboard-video-style";
import {
  enqueueVendorGenerationOperation,
  normalizeVendorClientOperationId,
  replayVendorGenerationOperation,
  VendorGenerationOperationError,
} from "@/tianjiang/storyboard/vendor-generation-operation";

const router = express.Router({ mergeParams: true });
const projectUuid = z.string().uuid();
const assetUuid = z.string().uuid();
const MAX_SELECTED_SHOTS = 500;
const selectedShotUuidsSchema = z.array(z.string().uuid()).min(1).max(MAX_SELECTED_SHOTS);
const autoMatchAssetsBodySchema = z.object({
  shotUuids: selectedShotUuidsSchema,
}).strict();
const batchReplacePromptBodySchema = z.object({
  shotUuids: selectedShotUuidsSchema,
  findText: z.string().min(1).max(4000),
  replaceText: z.string().max(8000),
}).strict();
const generationItemSchema = z.object({
  // 中文注释：页面级覆盖必须在任何入队/收费动作前整批校验，禁止非法值被静默忽略。
  durationMs: z.number().finite().int().min(100).max(600_000).optional(),
  aspectRatio: z.string().trim().regex(/^[1-9]\d{0,3}:[1-9]\d{0,3}$/).optional(),
  mediaType: z.enum(["image", "video"]),
  providerModel: z.string().trim().min(1).max(160),
  routeKind: z.enum(["dreamina-cli", "vendor"]).optional(),
  mode: z.string().trim().min(1).max(64).optional(),
  resolution: z.string().trim().min(1).max(32).optional(),
  expectedPreviewDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).passthrough();
type GenerationRouteItem = z.infer<typeof generationItemSchema>;

const generationPreviewOverrideSchema = z.object({
  // 中文注释：preview 只接收生成参数覆盖；提示词仍来自持久化分镜/设置，禁止 body 注入未保存内容。
  durationMs: generationItemSchema.shape.durationMs,
  aspectRatio: generationItemSchema.shape.aspectRatio,
  resolution: z.string().trim().min(1).max(32).optional(),
}).passthrough();

function assertPreviewDigest(input: {
  projectUuid: string;
  shotUuid: string;
  mediaType: "image" | "video";
  expectedPreviewDigest?: string;
  request: Parameters<typeof createStoryboardGenerationPreviewDigest>[0]["request"];
}): void {
  if (!input.expectedPreviewDigest) {
    throw Object.assign(new Error("生成前必须先完成最终请求预览确认"), {
      status: 400,
      code: "STORYBOARD_PREVIEW_REQUIRED",
    });
  }
  const actual = createStoryboardGenerationPreviewDigest({
    projectUuid: input.projectUuid,
    shotUuid: input.shotUuid,
    mediaType: input.mediaType,
    request: input.request,
  });
  if (actual !== input.expectedPreviewDigest) {
    throw Object.assign(new Error("最终请求已变化，请重新预览确认"), {
      status: 409,
      code: "STORYBOARD_PREVIEW_STALE",
    });
  }
}

const PUBLIC_GENERATION_ERROR_MESSAGES: Record<string, string> = {
  STORYBOARD_SHOT_NOT_FOUND: "分镜不存在",
  STORYBOARD_REFERENCE_MISSING: "分镜参考素材记录缺失",
  STORYBOARD_REFERENCE_FILE_MISSING: "分镜参考素材文件缺失",
  STORYBOARD_DREAMINA_MODE_UNSUPPORTED: "当前即梦模式暂不可预览",
  STORYBOARD_BOUND_TEXT_MODE: "有角色、场景或道具绑定时不能使用纯文本生成",
  STORYBOARD_IMPORT_FORBIDDEN: "当前身份不能写入该项目",
  STORYBOARD_VIDEO_DURATION_INVALID: "视频时长必须是 4 到 30 的整数秒",
  STORYBOARD_DURATION_EXCEEDS_MODEL: "当前模型不支持该视频时长",
  DREAMINA_CLI_DISABLED: "即梦 CLI 已关闭",
  DREAMINA_CLI_NOT_INSTALLED: "未安装即梦 CLI 或无法执行",
  DREAMINA_CLI_NOT_LOGGED_IN: "未登录即梦账号",
  DREAMINA_CLI_START_FAILED: "即梦 CLI 启动失败",
  DREAMINA_CLI_INVALID_ARGUMENT: "即梦 CLI 请求参数不合法",
  DREAMINA_BATCH_PERSIST_FAILED: "生成任务入队失败，请重试",
};

const PUBLIC_GENERATION_SUBMIT_MESSAGES: Record<string, string> = {
  ...PUBLIC_GENERATION_ERROR_MESSAGES,
  STORYBOARD_DREAMINA_MODE_UNSUPPORTED: "当前即梦 CLI 不支持当前模式",
  STORYBOARD_VENDOR_MODE_UNSUPPORTED: "当前模型不支持该参考素材形态",
  STORYBOARD_PREVIEW_REQUIRED: "生成前必须先完成最终请求预览确认",
  STORYBOARD_PREVIEW_STALE: "最终请求已变化，请重新预览确认",
  STORYBOARD_GENERATION_ROUTE_MISMATCH: "生成路由已变化，请重新预览确认",
  STORYBOARD_VENDOR_MODEL_UNAVAILABLE: "当前普通供应商模型不可用",
  STORYBOARD_CLIENT_OPERATION_CONFLICT: "生成操作标识冲突，请重新提交",
  VENDOR_PREPARE_FAILED: "当前视频模型配置或请求参数不可用",
  VENDOR_MEDIA_STAGING_FAILED: "参考素材暂存失败，请检查网络或稍后重试",
  VENDOR_GENERATION_FAILED: "普通供应商生成失败，请检查模型配置或稍后重试",
  VENDOR_REFERENCE_UNSUPPORTED: "当前视频模型不支持参考素材输入",
  STORYBOARD_DREAMINA_CLI_UNAVAILABLE: "即梦 CLI 不可用",
  DREAMINA_CLI_DISABLED: "即梦 CLI 已关闭",
  DREAMINA_CLI_NOT_INSTALLED: "未安装即梦 CLI 或无法执行",
  DREAMINA_CLI_NOT_LOGGED_IN: "未登录即梦账号",
  DREAMINA_CLI_START_FAILED: "即梦 CLI 启动失败",
  DREAMINA_CLI_INVALID_ARGUMENT: "即梦 CLI 请求参数不合法",
  DREAMINA_BATCH_PERSIST_FAILED: "生成任务入队失败，请重试",
  STORYBOARD_REFERENCE_IDENTITY_MISMATCH: "参考素材文件已变化，请重新预览确认",
  VENDOR_CLIENT_OPERATION_ID_INVALID: "生成操作标识无效",
  VENDOR_CLIENT_OPERATION_CONFLICT: "生成操作标识冲突，请重新提交",
  VENDOR_PAID_BATCH_CONFIRMATION_REQUIRED: "批量普通供应商任务必须明确确认潜在收费",
  VENDOR_OPERATION_READ_FAILED: "生成操作暂时不可读取，请稍后重试",
  VENDOR_OPERATION_PERSIST_FAILED: "生成操作未耐久，请重试",
  VENDOR_OPERATION_STATE_INVALID: "生成操作状态无效",
  VENDOR_EMPTY_BATCH: "没有可提交的生成任务",
};

function writeGenerationSubmitError(res: express.Response, error: unknown): void {
  // 中文注释：正式 generate 只回白名单 code/message，禁止 writeError 把路径、SQL 或堆栈带回页面。
  const status = typeof (error as { status?: unknown })?.status === "number"
    ? Number((error as { status: number }).status)
    : error instanceof RuntimePermissionError ? 403 : 400;
  const rawCode = typeof (error as { code?: unknown })?.code === "string"
    ? String((error as { code: string }).code)
    : error instanceof RuntimePermissionError ? "STORYBOARD_IMPORT_FORBIDDEN" : "";
  const mapped = rawCode ? PUBLIC_GENERATION_SUBMIT_MESSAGES[rawCode] : undefined;
  const current = error instanceof Error ? error.message : "";
  const dreaminaMode = rawCode === "STORYBOARD_DREAMINA_MODE_UNSUPPORTED"
    && /^当前即梦 CLI 不支持 [A-Za-z0-9_]+$/.test(current)
    ? current
    : undefined;
  if (mapped || dreaminaMode) {
    const stagingStep = rawCode === "VENDOR_MEDIA_STAGING_FAILED"
      ? readSafeVendorStagingStep(error)
      : undefined;
    res.status(status).send({
      code: rawCode,
      message: dreaminaMode ?? mapped,
      ...(stagingStep ? { stagingStep } : {}),
    });
    return;
  }
  res.status(status).send({
    code: String(status),
    message: "提交生成失败，请重试",
  });
}

function writeGenerationPreviewError(res: express.Response, error: unknown): void {
  // 中文注释：预览对外只回稳定错误码对应中文，禁止把 SQL、路径、堆栈或探测细节回显给页面。
  const status = typeof (error as { status?: unknown })?.status === "number"
    ? Number((error as { status: number }).status)
    : error instanceof RuntimePermissionError ? 403 : 400;
  const rawCode = typeof (error as { code?: unknown })?.code === "string"
    ? String((error as { code: string }).code)
    : error instanceof RuntimePermissionError ? "STORYBOARD_IMPORT_FORBIDDEN" : "";
  const mapped = rawCode ? PUBLIC_GENERATION_ERROR_MESSAGES[rawCode] : undefined;
  if (mapped) {
    res.status(status).send({ code: rawCode, message: mapped });
    return;
  }
  res.status(status).send({
    code: String(status),
    message: "分镜生成预览失败",
  });
}

function parseSelectedShotAction<T extends z.ZodTypeAny>(
  schema: T,
  body: unknown,
  emptyMessage: string,
): z.infer<T> {
  const parsed = schema.safeParse(body ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = String(issue?.path?.join(".") ?? "");
  if (path.includes("findText") && issue?.code === "too_big") {
    throw Object.assign(new Error("查找文本过长"), { status: 400 });
  }
  if (path.includes("replaceText") && issue?.code === "too_big") {
    throw Object.assign(new Error("替换文本过长"), { status: 400 });
  }
  if (path.includes("findText")) {
    throw Object.assign(new Error("查找文本不能为空"), { status: 400 });
  }
  if (issue?.code === "too_big") {
    throw Object.assign(new Error(`一次最多处理 ${MAX_SELECTED_SHOTS} 条分镜`), { status: 400 });
  }
  throw Object.assign(new Error(emptyMessage), { status: 400 });
}

const STORYBOARD_BATCH_TOOL_FAILED = "STORYBOARD_BATCH_TOOL_FAILED";
const PUBLIC_BATCH_ERROR_CODES = new Set([
  "STORYBOARD_PROMPT_TOO_LONG",
  "STORYBOARD_BATCH_PROMPT_TOO_LONG",
  "STORYBOARD_SELECTION_REQUIRED",
  "STORYBOARD_SELECTION_TOO_LARGE",
  "STORYBOARD_FIND_TEXT_EMPTY",
  "STORYBOARD_FIND_TEXT_TOO_LONG",
  "STORYBOARD_REPLACE_TEXT_TOO_LONG",
  "STORYBOARD_REPLACE_UNCHANGED",
  "STORYBOARD_SHOT_NOT_IN_PROJECT",
]);
const PUBLIC_BATCH_ERROR_MESSAGES = new Set([
  "请选择要匹配资产的分镜",
  "请选择要替换的分镜",
  "查找文本不能为空",
  "查找文本过长",
  "替换文本过长",
  "替换后内容没有变化",
  "替换后分镜提示词超过长度上限",
  "本次替换后的提示词总长度超过上限",
  "一次最多处理 500 条分镜",
  "分镜不存在或不属于当前项目",
]);
const PUBLIC_BATCH_PERMISSION_MESSAGES = new Set([
  "缺少中央会话，无法打开项目运行时",
  "项目不存在或不可见",
  "当前身份不能写入该项目",
  "Team 写入缺少设备或锁",
  "Team 编辑锁无效",
  "Team 写入设备不匹配",
  "Team 锁不匹配",
  "Team 栅栏令牌已失效",
  "项目尚未打开，禁止写入",
  "团队项目当前只读",
  "团队项目当前只读或编辑锁已失效",
  "团队项目离线只读",
  "项目类型未知，拒绝写入 mutation intent",
]);

function leaksInternalBatchDetail(value: string): boolean {
  return /SQLITE|SQL|SELECT |INSERT |UPDATE |FROM |o_storyboard|o_legacy|node_modules|[A-Za-z]:\\|[/\\]/i.test(value);
}

function writeBatchToolError(res: express.Response, error: unknown, fallback: string): void {
  const rawCode = typeof (error as { code?: unknown })?.code === "string"
    ? String((error as { code: string }).code)
    : "";
  const rawMessage = error instanceof Error ? error.message : "";
  const permission = error instanceof RuntimePermissionError;
  const whitelistedCode = PUBLIC_BATCH_ERROR_CODES.has(rawCode) && !leaksInternalBatchDetail(rawCode);
  const whitelistedBusinessMessage = PUBLIC_BATCH_ERROR_MESSAGES.has(rawMessage);
  const whitelistedPermissionMessage = PUBLIC_BATCH_PERMISSION_MESSAGES.has(rawMessage);
  // 中文注释：RuntimePermissionError 只决定 403；原文必须精确命中权限白名单，禁止按中文/长度/正则猜测。
  let status = 500;
  if (permission) status = 403;
  else if (whitelistedCode || whitelistedBusinessMessage) {
    const requested = typeof (error as { status?: unknown })?.status === "number"
      ? Number((error as { status: number }).status)
      : 400;
    status = requested === 403 ? 403 : 400;
  }
  const publishMessage = permission ? whitelistedPermissionMessage : whitelistedBusinessMessage;
  const message = publishMessage ? rawMessage : fallback;
  // 中文注释：权限分支优先固定 body.code=403，禁止带出业务白名单码。
  const code = permission
    ? 403
    : status === 500
      ? STORYBOARD_BATCH_TOOL_FAILED
      : (whitelistedCode ? rawCode : status);
  res.status(status).send({ code, message });
}

function writeError(res: express.Response, error: unknown): void {
  const status = typeof (error as { status?: unknown })?.status === "number"
    ? Number((error as { status: number }).status)
    : error instanceof RuntimePermissionError ? 403 : 400;
  res.status(status).send({
    code: typeof (error as { code?: unknown })?.code === "string"
      ? String((error as { code: string }).code)
      : status,
    message: error instanceof Error ? error.message : "分镜资源操作失败",
    dependents: (error as { dependents?: unknown }).dependents,
  });
}

router.use((req, res, next) => {
  try {
    projectUuid.parse(String((req.params as { uuid?: string }).uuid ?? ""));
    enterTeamWriteGuard(teamWriteGuardFromHeaders(req.headers as Record<string, unknown>));
    next();
  } catch (error) {
    writeError(res, error);
  }
});

router.use("/shots", (req, res, next) => {
  if (req.method !== "DELETE") {
    next();
    return;
  }
  // 中文注释：只拦截精确 DELETE /shots，不得吞掉 /shots/:id/bindings/:assetUuid。
  if (req.path && req.path !== "/" ) {
    next();
    return;
  }
  void (async () => {
    try {
      const uuid = projectUuid.parse(String((req.params as { uuid?: string }).uuid ?? ""));
      const shotUuids = Array.isArray(req.body?.shotUuids) ? req.body.shotUuids.map(String) : [];
      await projectOperationPort.withProject(
        (req as { centralSession?: never }).centralSession,
        uuid,
        "write",
        async () => new StoryboardService(uuid).deleteShots(shotUuids),
      );
      res.status(200).send({ code: 0, data: { deleted: shotUuids.length }, message: "分镜已删除" });
    } catch (error) {
      writeError(res, error);
    }
  })();
});

router.get("/shots", async (req, res) => {
  try {
    const uuid = projectUuid.parse(String((req.params as { uuid?: string }).uuid ?? ""));
    const data = await projectOperationPort.withProject(
      (req as { centralSession?: never }).centralSession,
      uuid,
      "read",
      async () => new StoryboardService(uuid).listShots(),
    );
    res.status(200).send({ code: 0, data, message: "分镜列表已读取" });
  } catch (error) {
    writeError(res, error);
  }
});

router.post("/shots", async (req, res) => {
  try {
    const uuid = projectUuid.parse(String((req.params as { uuid?: string }).uuid ?? ""));
    const data = await projectOperationPort.withProject(
      (req as { centralSession?: never }).centralSession,
      uuid,
      "write",
      async () => new StoryboardService(uuid).insertShot({
        afterShotUuid: typeof req.body?.afterShotUuid === "string" ? req.body.afterShotUuid : null,
        sourceText: typeof req.body?.sourceText === "string" ? req.body.sourceText : undefined,
        visualDescription: typeof req.body?.visualDescription === "string" ? req.body.visualDescription : undefined,
      }),
    );
    res.status(200).send({ code: 0, data, message: "分镜已插入" });
  } catch (error) {
    writeError(res, error);
  }
});

router.post("/shots/actions/auto-match-assets", async (req, res) => {
  try {
    const uuid = projectUuid.parse(String((req.params as { uuid?: string }).uuid ?? ""));
    const body = parseSelectedShotAction(autoMatchAssetsBodySchema, req.body, "请选择要匹配资产的分镜");
    const session = (req as { centralSession?: never }).centralSession;
    const data = await projectOperationPort.withProject(
      session,
      uuid,
      "write",
      async () => {
        const assets = await sharedAssetGateway.listAssets(session, uuid);
        return new StoryboardService(uuid).autoMatchAssets(body.shotUuids, assets);
      },
    );
    const conflictHint = data.conflictCount > 0 && data.conflictAssetNames.length
      ? `，跳过 ${data.conflictCount} 处歧义：${data.conflictAssetNames.join("、")}`
      : "";
    res.status(200).send({
      code: 0,
      data,
      message: `资产已自动匹配${conflictHint}`,
    });
  } catch (error) {
    writeBatchToolError(res, error, "自动匹配资产失败，请重试");
  }
});

router.post("/shots/actions/batch-replace-prompt", async (req, res) => {
  try {
    const uuid = projectUuid.parse(String((req.params as { uuid?: string }).uuid ?? ""));
    const body = parseSelectedShotAction(batchReplacePromptBodySchema, req.body, "请选择要替换的分镜");
    const data = await projectOperationPort.withProject(
      (req as { centralSession?: never }).centralSession,
      uuid,
      "write",
      async () => new StoryboardService(uuid).batchReplacePrompt({
        shotUuids: body.shotUuids,
        findText: body.findText,
        replaceText: body.replaceText,
      }),
    );
    res.status(200).send({
      code: 0,
      data,
      message: `选中 ${data.selectedCount} 条、影响 ${data.affectedShotCount} 条、共替换 ${data.replacementCount} 处`,
    });
  } catch (error) {
    writeBatchToolError(res, error, "批量替换失败，请重试");
  }
});

router.patch("/shots/:shotUuid", async (req, res) => {
  try {
    const uuid = projectUuid.parse(String((req.params as { uuid?: string }).uuid ?? ""));
    const shotUuid = z.string().uuid().parse(String((req.params as { shotUuid?: string }).shotUuid ?? ""));
    const data = await projectOperationPort.withProject(
      (req as { centralSession?: never }).centralSession,
      uuid,
      "write",
      async () => new StoryboardService(uuid).updateShot(shotUuid, req.body ?? {}),
    );
    res.status(200).send({ code: 0, data, message: "分镜已更新" });
  } catch (error) {
    writeError(res, error);
  }
});

router.delete("/shots", async (req, res) => {
  try {
    const uuid = projectUuid.parse(String((req.params as { uuid?: string }).uuid ?? ""));
    const shotUuids = Array.isArray(req.body?.shotUuids) ? req.body.shotUuids.map(String) : [];
    await projectOperationPort.withProject(
      (req as { centralSession?: never }).centralSession,
      uuid,
      "write",
      async () => new StoryboardService(uuid).deleteShots(shotUuids),
    );
    res.status(200).send({ code: 0, data: { deleted: shotUuids.length }, message: "分镜已删除" });
  } catch (error) {
    writeError(res, error);
  }
});

router.put("/shots/reorder", async (req, res) => {
  try {
    const uuid = projectUuid.parse(String((req.params as { uuid?: string }).uuid ?? ""));
    const orderedShotUuids = Array.isArray(req.body?.orderedShotUuids) ? req.body.orderedShotUuids.map(String) : [];
    await projectOperationPort.withProject(
      (req as { centralSession?: never }).centralSession,
      uuid,
      "write",
      async () => new StoryboardService(uuid).reorderShots({ orderedShotUuids }),
    );
    res.status(200).send({ code: 0, data: { orderedShotUuids }, message: "分镜已重排" });
  } catch (error) {
    writeError(res, error);
  }
});

router.patch("/shots/:shotUuid/bindings/:assetUuid", async (req, res) => {
  try {
    const uuid = projectUuid.parse(String((req.params as { uuid?: string }).uuid ?? ""));
    const shotUuid = z.string().uuid().parse(String((req.params as { shotUuid?: string }).shotUuid ?? ""));
    const boundAssetUuid = assetUuid.parse(String((req.params as { assetUuid?: string }).assetUuid ?? ""));
    const sourceProjectUuid = projectUuid.parse(String(req.query?.sourceProjectUuid ?? req.body?.sourceProjectUuid ?? ""));
    const assetType = String(req.query?.assetType ?? req.body?.assetType ?? "").trim();
    const relationRole = String(req.query?.relationRole ?? req.body?.relationRole ?? "").trim();
    const voiceEnabled = req.body?.voiceEnabled;
    if (typeof voiceEnabled !== "boolean" || !relationRole) {
      throw Object.assign(new Error("更新绑定必须同时复核来源项目、类型、关系角色和音色开关"), { status: 400 });
    }
    const data = await projectOperationPort.withProject(
      (req as { centralSession?: never }).centralSession,
      uuid,
      "write",
      async () => new StoryboardService(uuid).updateBindingVoice(shotUuid, {
        assetUuid: boundAssetUuid,
        sourceProjectUuid,
        assetType,
        relationRole,
        voiceEnabled,
      }),
    );
    res.status(200).send({ code: 0, data, message: "绑定音色开关已更新" });
  } catch (error) {
    writeError(res, error);
  }
});

router.delete("/shots/:shotUuid/bindings/:assetUuid", async (req, res) => {
  try {
    const uuid = projectUuid.parse(String((req.params as { uuid?: string }).uuid ?? ""));
    const shotUuid = z.string().uuid().parse(String((req.params as { shotUuid?: string }).shotUuid ?? ""));
    const boundAssetUuid = assetUuid.parse(String((req.params as { assetUuid?: string }).assetUuid ?? ""));
    const sourceProjectUuid = projectUuid.parse(String(req.query?.sourceProjectUuid ?? req.body?.sourceProjectUuid ?? ""));
    const assetType = String(req.query?.assetType ?? req.body?.assetType ?? "").trim();
    if (!["role", "scene", "tool"].includes(assetType)) {
      throw Object.assign(new Error("解绑必须同时复核来源项目和资产类型"), { status: 400 });
    }
    await projectOperationPort.withProject(
      (req as { centralSession?: never }).centralSession,
      uuid,
      "write",
      async () => new StoryboardService(uuid).unbindAsset(shotUuid, {
        assetUuid: boundAssetUuid,
        sourceProjectUuid,
        assetType,
      }),
    );
    res.status(200).send({ code: 0, data: { shotUuid, assetUuid: boundAssetUuid }, message: "资产已取消关联" });
  } catch (error) {
    writeError(res, error);
  }
});

router.post("/shots/:shotUuid/bindings", async (req, res) => {
  try {
    const uuid = projectUuid.parse(String((req.params as { uuid?: string }).uuid ?? ""));
    const shotUuid = z.string().uuid().parse(String((req.params as { shotUuid?: string }).shotUuid ?? ""));
    await projectOperationPort.withProject(
      (req as { centralSession?: never }).centralSession,
      uuid,
      "write",
      async () => new StoryboardService(uuid).bindAsset(shotUuid, {
        sourceProjectUuid: String(req.body?.sourceProjectUuid ?? ""),
        assetUuid: String(req.body?.assetUuid ?? ""),
        assetType: req.body?.assetType,
        relationRole: String(req.body?.relationRole ?? "appear"),
      }),
    );
    res.status(200).send({ code: 0, data: { shotUuid }, message: "资产已绑定" });
  } catch (error) {
    writeError(res, error);
  }
});

router.post("/shots/:shotUuid/candidates/:candidateUuid/select", async (req, res) => {
  try {
    const uuid = projectUuid.parse(String((req.params as { uuid?: string }).uuid ?? ""));
    const shotUuid = z.string().uuid().parse(String((req.params as { shotUuid?: string }).shotUuid ?? ""));
    const candidateUuid = z.string().uuid().parse(String((req.params as { candidateUuid?: string }).candidateUuid ?? ""));
    await projectOperationPort.withProject(
      (req as { centralSession?: never }).centralSession,
      uuid,
      "write",
      async () => new StoryboardService(uuid).selectCandidate(shotUuid, candidateUuid),
    );
    res.status(200).send({ code: 0, data: { shotUuid, candidateUuid }, message: "候选已采用" });
  } catch (error) {
    writeError(res, error);
  }
});

router.get("/settings", async (req, res) => {
  try {
    const uuid = projectUuid.parse(String((req.params as { uuid?: string }).uuid ?? ""));
    const data = await projectOperationPort.withProject(
      (req as { centralSession?: never }).centralSession,
      uuid,
      "read",
      async () => {
        const service = new StoryboardService(uuid);
        const settings = await service.getSettings();
        const artStyle = await service.getProjectArtStyle();
        return { ...settings, artStyle: artStyle.name, artStylePrompt: artStyle.prompt };
      },
    );
    res.status(200).send({ code: 0, data, message: "分镜设置已读取" });
  } catch (error) {
    writeError(res, error);
  }
});

router.put("/settings", async (req, res) => {
  try {
    const uuid = projectUuid.parse(String((req.params as { uuid?: string }).uuid ?? ""));
    const data = await projectOperationPort.withProject(
      (req as { centralSession?: never }).centralSession,
      uuid,
      "write",
      async () => {
        const service = new StoryboardService(uuid);
        if (Object.prototype.hasOwnProperty.call(req.body ?? {}, "artStyle")) {
          await service.saveProjectArtStyle(req.body?.artStyle ?? null);
        }
        const settings = await service.saveSettings(req.body ?? {});
        const artStyle = await service.getProjectArtStyle();
        return { ...settings, artStyle: artStyle.name, artStylePrompt: artStyle.prompt };
      },
    );
    res.status(200).send({ code: 0, data, message: "分镜设置已保存" });
  } catch (error) {
    writeError(res, error);
  }
});

router.get("/video-templates", async (req, res) => {
  try {
    const uuid = projectUuid.parse(String((req.params as { uuid?: string }).uuid ?? ""));
    const data = await projectOperationPort.withProject(
      (req as { centralSession?: never }).centralSession,
      uuid,
      "read",
      async () => {
        const { listStoryboardVideoTemplates } = await import("@/tianjiang/storyboard/storyboard-video-templates");
        return { templates: await listStoryboardVideoTemplates() };
      },
    );
    res.status(200).send({ code: 0, data, message: "视频指令模板已读取" });
  } catch (error) {
    writeError(res, error);
  }
});

router.put("/video-templates/:templateId", async (req, res) => {
  try {
    const uuid = projectUuid.parse(String((req.params as { uuid?: string }).uuid ?? ""));
    const templateId = z.coerce.number().int().positive().parse((req.params as { templateId?: string }).templateId);
    const data = await projectOperationPort.withProject(
      (req as { centralSession?: never }).centralSession,
      uuid,
      "write",
      async () => {
        const { updateStoryboardVideoTemplate } = await import("@/tianjiang/storyboard/storyboard-video-templates");
        return updateStoryboardVideoTemplate(templateId, {
          name: String(req.body?.name ?? ""),
          content: String(req.body?.content ?? ""),
        });
      },
    );
    res.status(200).send({ code: 0, data, message: "视频指令模板已保存" });
  } catch (error) {
    writeError(res, error);
  }
});

router.post("/video-templates", async (req, res) => {
  try {
    const uuid = projectUuid.parse(String((req.params as { uuid?: string }).uuid ?? ""));
    const data = await projectOperationPort.withProject(
      (req as { centralSession?: never }).centralSession,
      uuid,
      "write",
      async () => {
        const { createStoryboardVideoTemplate } = await import("@/tianjiang/storyboard/storyboard-video-templates");
        return createStoryboardVideoTemplate({
          name: String(req.body?.name ?? ""),
          content: String(req.body?.content ?? ""),
        });
      },
    );
    res.status(200).send({ code: 0, data, message: "视频指令模板已保存" });
  } catch (error) {
    writeError(res, error);
  }
});

router.post("/video-templates/:templateId/use", async (req, res) => {
  try {
    const uuid = projectUuid.parse(String((req.params as { uuid?: string }).uuid ?? ""));
    const templateId = z.coerce.number().int().positive().parse((req.params as { templateId?: string }).templateId);
    const data = await projectOperationPort.withProject(
      (req as { centralSession?: never }).centralSession,
      uuid,
      "write",
      async () => {
        const { getStoryboardVideoTemplate } = await import("@/tianjiang/storyboard/storyboard-video-templates");
        const template = await getStoryboardVideoTemplate(templateId);
        const service = new StoryboardService(uuid);
        return service.saveSettings({
          videoPromptTemplateId: template.id,
          videoPromptTemplateContent: template.content,
        });
      },
    );
    res.status(200).send({ code: 0, data, message: "视频指令模板已用于当前项目" });
  } catch (error) {
    writeError(res, error);
  }
});

router.get("/art-styles", async (req, res) => {
  try {
    const uuid = projectUuid.parse(String((req.params as { uuid?: string }).uuid ?? ""));
    const data = await projectOperationPort.withProject(
      (req as { centralSession?: never }).centralSession,
      uuid,
      "read",
      async () => {
        return listStoryboardVideoStyles(uuid);
      },
    );
    res.status(200).send({ code: 0, data, message: "视频风格已读取" });
  } catch (error) {
    const text = `${error instanceof Error ? error.message : ""}${error instanceof Error ? error.stack ?? "" : ""}`;
    const fsLike = /ENOENT|EACCES|EPERM|[A-Za-z]:\\|\\\\|skills[/\\]|art_storyboard_video|runtime-users/i.test(text)
      || /ENOENT|EACCES|EPERM/i.test(String((error as { code?: unknown })?.code ?? ""));
    const businessStatus = typeof (error as { status?: unknown })?.status === "number"
      || error instanceof RuntimePermissionError;
    if (!fsLike && businessStatus) {
      writeError(res, error);
      return;
    }
    // 中文注释：手册/文件系统失败只回固定中文，禁止把盘符、堆栈或内部文件名回给前端。
    res.status(503).send({
      code: "STORYBOARD_ART_STYLES_UNAVAILABLE",
      message: "视频风格列表暂时无法读取",
    });
    void error;
  }
});

router.post("/generate", async (req, res) => {
  try {
    const uuid = projectUuid.parse(String((req.params as { uuid?: string }).uuid ?? "")).toLowerCase();
    const body = req.body ?? {};
    const rawItems = Array.isArray(body.items)
      ? body.items
      : [{
          shotUuid: body.shotUuid,
          mediaType: body.mediaType,
          providerModel: body.providerModel,
          routeKind: body.routeKind,
          mode: body.mode,
          durationMs: body.durationMs,
          aspectRatio: body.aspectRatio,
          resolution: body.resolution,
          expectedPreviewDigest: body.expectedPreviewDigest,
        }];
    const items = rawItems.map((item: unknown) => {
      const parsed = generationItemSchema.parse(item);
      const routeKind = assertStoryboardGenerationRoute({
        providerModel: parsed.providerModel,
        // 中文注释：旧客户端未传时按 providerModel 推导；显式传入时必须与预览路由一致。
        routeKind: parsed.routeKind ?? classifyStoryboardGenerationRoute(parsed.providerModel),
      });
      return { ...parsed, routeKind };
    });
    if (items.length === 0) {
      throw Object.assign(new Error("没有可提交的生成任务"), { status: 400 });
    }
    const dreaminaItems = items.filter((item: GenerationRouteItem) => item.routeKind === "dreamina-cli");
    const vendorItems = items.filter((item: GenerationRouteItem) => item.routeKind === "vendor");
    if (vendorItems.length && dreaminaItems.length) {
      throw Object.assign(new Error("不能在同一次请求中混合即梦与普通供应商"), { status: 400 });
    }
    if (dreaminaItems.length > MAX_DREAMINA_ENQUEUE_ITEMS) {
      throw new DreaminaEnqueueError(
        "DREAMINA_BATCH_LIMIT_EXCEEDED",
        `单次即梦生成最多提交 ${MAX_DREAMINA_ENQUEUE_ITEMS} 项`,
        400,
      );
    }
    if (dreaminaItems.length > 1 && body.paidBatchConfirmed !== true) {
      // 中文注释：未确认批量尚未形成可受理意图，必须在操作 ID 解析和任何持久化前直接拒绝。
      throw new DreaminaEnqueueError(
        "DREAMINA_PAID_BATCH_CONFIRMATION_REQUIRED",
        "批量即梦任务必须明确确认潜在收费",
        400,
      );
    }
    // 中文注释：所有正式生成入口共用同一客户端操作 UUID，200 响应据此与当前确认动作精确绑定。
    const clientOperationId = dreaminaItems.length > 0
      ? normalizeDreaminaClientOperationId(body.clientOperationId)
      : normalizeVendorClientOperationId(body.clientOperationId);
    const requestIntentDigest = createEnqueueRequestIntentDigest({
      projectUuid: uuid,
      action: "generate",
      paidBatchConfirmed: body.paidBatchConfirmed === true,
      items: items.map((item: GenerationRouteItem & { shotUuid?: string }) => ({
        shotUuid: String(item.shotUuid ?? ""),
        mediaType: item.mediaType,
        providerModel: item.providerModel,
        routeKind: item.routeKind,
        mode: item.mode ?? "auto",
        durationMs: item.durationMs ?? null,
        aspectRatio: item.aspectRatio ?? null,
        resolution: item.resolution ?? null,
        expectedPreviewDigest: item.expectedPreviewDigest ?? null,
      })),
    });
    const executionResult = await projectOperationPort.withProject(
      (req as { centralSession?: never }).centralSession,
      uuid,
      "write",
      async () => {
        if (dreaminaItems.length > 0) {
          const replay = await replayAcceptedDreaminaEnqueue({
            projectUuid: uuid,
            clientOperationId,
            requestIntentDigest,
          });
          if (replay) return replay;
        }
        if (vendorItems.length > 0) {
          const replay = await replayVendorGenerationOperation({
            projectUuid: uuid,
            clientOperationId,
            requestIntentDigest,
          });
          if (replay) return replay;
          if (vendorItems.length > 1 && body.paidBatchConfirmed !== true) {
            // 中文注释：先让既有 ID 完成冲突判定；全新批次仍在任何预检、耐久或收费前硬拒绝。
            throw Object.assign(new Error("批量普通供应商任务必须明确确认潜在收费"), {
              status: 400,
              code: "VENDOR_PAID_BATCH_CONFIRMATION_REQUIRED",
            });
          }
        }
        const service = new StoryboardService(uuid);
        const settings = await service.getSettings();
        const shots = await service.listShots();
        const buildRequest = async (item: {
          shotUuid?: string;
          mediaType?: string;
          providerModel?: string;
          mode?: string;
          durationMs?: number;
          aspectRatio?: string;
          resolution?: string;
          expectedPreviewDigest?: string;
        }) => {
          const shot = shots.find((row) => row.shotUuid === item.shotUuid);
          if (!shot) throw Object.assign(new Error("分镜不存在"), { status: 404 });
          return prepareVendorStoryboardGenerationRequest({
            projectUuid: uuid,
            mediaType: item.mediaType === "video" ? "video" : "image",
            providerModel: String(item.providerModel ?? ""),
            settings: {
              ...settings,
              // 中文注释：正式请求必须使用本次预览确认的分辨率，不能重新读取项目旧默认值。
              ...(item.resolution ? { resolution: item.resolution } : {}),
            },
            shot: {
              ...shot,
              durationMs: item.durationMs ?? shot?.durationMs,
              aspectRatio: item.aspectRatio ?? shot?.aspectRatio,
            },
            requestedMode: String(item.mode ?? ""),
          });
        };
        if (dreaminaItems.length > 0) {
          // 中文注释：先解析完整批次，任何模型/能力/路径失败时都不得留下部分收费队列。
          const referenceIdentityCache = new Map<string, { md5: string; size: number }>();
          const preparedItems = await Promise.all(dreaminaItems.map(async (item: {
            shotUuid?: string;
            mediaType?: string;
            providerModel?: string;
            mode?: string;
            durationMs?: number;
            aspectRatio?: string;
            resolution?: string;
            expectedPreviewDigest?: string;
          }) => {
            const shot = shots.find((row) => row.shotUuid === item.shotUuid);
            if (!shot) throw Object.assign(new Error("分镜不存在"), { status: 404 });
            const mediaType = item.mediaType === "video" ? "video" : "image";
            const providerModel = String(item.providerModel ?? "");
            if (mediaType === "video") parseDreaminaVideoModel(providerModel);
            const prepared = await prepareDreaminaStoryboardGenerationRequest({
              projectUuid: uuid,
              mediaType,
              providerModel,
              requestedMode: String(item.mode ?? "auto"),
              settings: {
                ...settings,
                // 中文注释：即梦与普通供应商共用同一分辨率覆盖合同，摘要和执行载荷保持一致。
                ...(item.resolution ? { resolution: item.resolution } : {}),
              },
              shot: {
                ...shot,
                durationMs: item.durationMs ?? shot.durationMs,
                aspectRatio: item.aspectRatio ?? shot.aspectRatio,
              },
              referenceIdentityCache,
              // 中文注释：HTTP 提交只负责摘要复核与耐久入队，实时 CLI 探测由后台领取前完成。
              capabilityPolicy: "enqueue",
            });
            assertPreviewDigest({
              projectUuid: uuid,
              shotUuid: String(item.shotUuid ?? ""),
              mediaType,
              expectedPreviewDigest: item.expectedPreviewDigest,
              request: prepared.request,
            });
            return {
              shotUuid: String(item.shotUuid ?? ""),
              mediaType,
              providerModel,
              mode: prepared.mode,
              request: prepared.request,
              // 中文注释：请求身份刚在本 generate 链路读取，可跳过入队层重复同步扫描。
              requestReferenceIdentityVerified: true,
            };
          }));
          return enqueueAsyncMediaTasks({
            projectUuid: uuid,
            clientOperationId,
            requestIntentDigest,
            paidBatchConfirmed: body.paidBatchConfirmed === true,
            items: preparedItems,
          });
        }
        // 中文注释：普通供应商同样先重建并校验完整批次摘要，任何失配都不得提前调用外部服务。
        const vendorModelChecks = new Map<string, Promise<void>>();
        const preparedVendorItems = await Promise.all(vendorItems.map(async (item: GenerationRouteItem) => {
          const mediaType = item.mediaType === "video" ? "video" : "image";
          const providerModel = String(item.providerModel ?? "");
          const checkKey = `${mediaType}:${providerModel}`;
          let modelCheck = vendorModelChecks.get(checkKey);
          if (!modelCheck) {
            modelCheck = assertVendorProviderModelAvailable({ providerModel, mediaType });
            vendorModelChecks.set(checkKey, modelCheck);
          }
          await modelCheck;
          const request = await buildRequest(item);
          assertPreviewDigest({
            projectUuid: uuid,
            shotUuid: String(item.shotUuid ?? ""),
            mediaType,
            expectedPreviewDigest: item.expectedPreviewDigest,
            request,
          });
          return {
            item,
            request,
            mediaType,
          };
        }));
        // 中文注释：HTTP 只负责最终合同校验和 SQLite 受理；供应商 prepare/stage/execute 全部移交后台。
        return enqueueVendorGenerationOperation({
          projectUuid: uuid,
          clientOperationId,
          requestIntentDigest,
          paidBatchConfirmed: body.paidBatchConfirmed === true,
          items: preparedVendorItems.map(({ item, request, mediaType }) => ({
            shotUuid: String(item.shotUuid ?? ""),
            mediaType,
            providerModel: String(item.providerModel ?? ""),
            mode: String(request.options.mode ?? item.mode ?? ""),
            requestDigest: createStoryboardGenerationPreviewDigest({
              projectUuid: uuid,
              shotUuid: String(item.shotUuid ?? ""),
              mediaType,
              request,
            }),
            request,
          })),
        });
      },
    );
    const vendorOutcome = !Array.isArray(executionResult)
      && executionResult
      && typeof executionResult === "object"
      && "httpStatus" in executionResult
      ? executionResult
      : null;
    const data = vendorOutcome ? vendorOutcome.data : executionResult;
    const responseStatus = vendorOutcome ? vendorOutcome.httpStatus : 200;
    const first = Array.isArray(data) ? data[0] : data;
    const completed = first && typeof first === "object" && (first as { status?: string }).status === "completed";
    res.status(responseStatus).send({
      code: 0,
      // 中文注释：单项与批量统一返回数组，禁止客户端按供应商或条目数猜测响应形状。
      data,
      message: responseStatus === 202 ? "生成操作已受理，正在确认供应商状态" : completed ? "生成已完成" : "生成任务已入队",
    });
  } catch (error) {
    if (error instanceof DreaminaEnqueueError) {
      res.status(error.status).send({
        code: error.code,
        message: error.message,
        data: error.data,
      });
      return;
    }
    if (error instanceof VendorGenerationOperationError) {
      res.status(error.status).send({
        code: error.code,
        message: error.message,
      });
      return;
    }
    writeGenerationSubmitError(res, error);
  }
});

router.post("/generate/preview", async (req, res) => {
  try {
    const uuid = projectUuid.parse(String((req.params as { uuid?: string }).uuid ?? "")).toLowerCase();
    const data = await projectOperationPort.withProject(
      (req as { centralSession?: never }).centralSession,
      uuid,
      "read",
      async () => {
        const service = new StoryboardService(uuid);
        // 中文注释：preview 必须与正式 generate 一样只读持久化设置，禁止 body 注入未保存提示词。
        const settings = await service.getSettings();
        const shotUuid = typeof req.body?.shotUuid === "string" ? req.body.shotUuid : "";
        const persistedShot = shotUuid
          ? (await service.listShots()).find((item) => item.shotUuid === shotUuid)
          : undefined;
        if (!persistedShot) {
          throw Object.assign(new Error("分镜不存在"), { status: 404, code: "STORYBOARD_SHOT_NOT_FOUND" });
        }
        const shot = persistedShot;
        const providerModel = String(req.body?.providerModel ?? "");
        const shotOverrides = generationPreviewOverrideSchema.parse(req.body?.shot ?? {});
        const settingOverrides = generationPreviewOverrideSchema.parse(req.body?.settings ?? {});
        const parsed = generationItemSchema.parse({
          shotUuid,
          mediaType: req.body?.mediaType,
          providerModel,
          mode: req.body?.mode,
          // 中文注释：Web serializer 把页面覆盖写入 shot/settings；preview 必须消费同一合同，
          // 不能静默回退到持久化镜头后生成另一份摘要。
          durationMs: shotOverrides.durationMs ?? settingOverrides.durationMs ?? req.body?.durationMs,
          aspectRatio: shotOverrides.aspectRatio ?? settingOverrides.aspectRatio ?? req.body?.aspectRatio,
          resolution: settingOverrides.resolution ?? req.body?.resolution,
        });
        const requestSettings = {
          ...settings,
          ...(parsed.resolution ? { resolution: parsed.resolution } : {}),
        };
        if (providerModel.startsWith("dreamina-cli:")) {
          const prepared = await prepareDreaminaStoryboardGenerationRequest({
            projectUuid: uuid,
            mediaType: parsed.mediaType,
            providerModel: parsed.providerModel,
            requestedMode: parsed.mode ?? "auto",
            settings: requestSettings,
            shot: {
              ...persistedShot,
              durationMs: parsed.durationMs ?? persistedShot.durationMs,
              aspectRatio: parsed.aspectRatio ?? persistedShot.aspectRatio,
            },
            // 中文注释：只有预览允许缓存未就绪时使用已发布字段；正式 generate 必须走 execute。
            capabilityPolicy: "preview",
          });
          return sanitizeStoryboardGenerationPreview({
            projectUuid: uuid,
            shotUuid,
            mediaType: parsed.mediaType,
            request: prepared.request,
          });
        }
        const mediaType = parsed.mediaType;
        const request = await prepareVendorStoryboardGenerationRequest({
          projectUuid: uuid,
          mediaType,
          providerModel: parsed.providerModel,
          settings: requestSettings,
          shot: {
            ...shot,
            durationMs: parsed.durationMs ?? shot.durationMs,
            aspectRatio: parsed.aspectRatio ?? shot.aspectRatio,
          },
          requestedMode: parsed.mode ?? "",
        });
        // 中文注释：preview 只有在普通供应商适配也可完成时才返回摘要，避免确认后才暴露本地参数错误。
        adaptVendorGenerationRequest({ projectUuid: uuid, mediaType, request });
        return sanitizeStoryboardGenerationPreview({
          projectUuid: uuid,
          shotUuid,
          mediaType,
          request,
        });
      },
    );
    res.status(200).send({ code: 0, data, message: "最终请求预览" });
  } catch (error) {
    writeGenerationPreviewError(res, error);
  }
});

router.post("/assets", async (req, res) => {
  try {
    const session = (req as { centralSession?: never }).centralSession;
    const uuid = projectUuid.parse(String((req.params as { uuid?: string }).uuid ?? ""));
    const contentType = String(req.headers["content-type"] ?? "");
    let payload: Parameters<typeof sharedAssetGateway.createAsset>[2];
    if (contentType.includes("multipart/form-data")) {
      const { parseRestrictedMultipart } = await import("@/tianjiang/media/restricted-multipart");
      const parsed = await parseRestrictedMultipart(req);
      const image = parsed.files.find((file) => file.fieldName === "image");
      const audio = parsed.files.find((file) => file.fieldName === "audio");
      payload = {
        type: String(parsed.fields.type ?? ""),
        name: String(parsed.fields.name ?? ""),
        describe: parsed.fields.describe ?? "",
        remark: parsed.fields.remark ?? "",
        prompt: parsed.fields.prompt ?? "",
        imageRatio: parsed.fields.imageRatio,
        image: image ? { buffer: image.buffer, mime: image.mime } : undefined,
        audio: audio ? { buffer: audio.buffer, mime: audio.mime, filename: audio.filename } : undefined,
      };
    } else {
      payload = {
        type: String(req.body?.type ?? ""),
        name: String(req.body?.name ?? ""),
        describe: typeof req.body?.describe === "string" ? req.body.describe : "",
        remark: typeof req.body?.remark === "string" ? req.body.remark : "",
        prompt: typeof req.body?.prompt === "string" ? req.body.prompt : "",
        imageRatio: typeof req.body?.imageRatio === "string" ? req.body.imageRatio : undefined,
      };
    }
    const data = await sharedAssetGateway.createAsset(session, uuid, payload);
    res.status(200).send({ code: 0, data, message: "共享资产已创建" });
  } catch (error) {
    writeError(res, error);
  }
});

router.post("/assets/batch", async (req, res) => {
  try {
    const { parseRestrictedMultipart } = await import("@/tianjiang/media/restricted-multipart");
    const parsed = await parseRestrictedMultipart(req, { maxFiles: 30 });
    const data = await sharedAssetGateway.batchUploadAssets(
      (req as { centralSession?: never }).centralSession,
      projectUuid.parse(String((req.params as { uuid?: string }).uuid ?? "")),
      {
        type: String(parsed.fields.type ?? req.body?.type ?? ""),
        imageRatio: parsed.fields.imageRatio,
        files: parsed.files,
      },
    );
    res.status(200).send({ code: 0, data, message: "批量资产已写入" });
  } catch (error) {
    writeError(res, error);
  }
});

router.post("/assets/import", async (req, res) => {
  try {
    const data = await sharedAssetGateway.importAssetDescriptions(
      (req as { centralSession?: never }).centralSession,
      projectUuid.parse(String((req.params as { uuid?: string }).uuid ?? "")),
      {
        format: String(req.body?.format ?? ""),
        text: typeof req.body?.text === "string" ? req.body.text : "",
      },
    );
    res.status(200).send({ code: 0, data, message: "资产描述已导入" });
  } catch (error) {
    writeError(res, error);
  }
});

router.post("/assets/:assetUuid/image", async (req, res) => {
  try {
    const { parseSingleMultipartFile } = await import("@/tianjiang/media/restricted-multipart");
    const file = await parseSingleMultipartFile(req);
    const data = await sharedAssetGateway.uploadAssetImage(
      (req as { centralSession?: never }).centralSession,
      projectUuid.parse(String((req.params as { uuid?: string }).uuid ?? "")),
      assetUuid.parse(String((req.params as { assetUuid?: string }).assetUuid ?? "")),
      { buffer: file.buffer, mime: file.mime },
    );
    res.status(200).send({ code: 0, data, message: "资产图片已上传" });
  } catch (error) {
    writeError(res, error);
  }
});

router.get("/assets", async (req, res) => {
  try {
    const data = await sharedAssetGateway.listAssets(
      (req as { centralSession?: never }).centralSession,
      projectUuid.parse(String((req.params as { uuid?: string }).uuid ?? "")),
    );
    res.status(200).send({ code: 0, data, message: "共享资产已读取" });
  } catch (error) {
    writeError(res, error);
  }
});

router.post("/assets/:assetUuid/audio", async (req, res) => {
  try {
    const { parseSingleMultipartFile } = await import("@/tianjiang/media/restricted-multipart");
    const file = await parseSingleMultipartFile(req);
    const data = await sharedAssetGateway.uploadAssetAudio(
      (req as { centralSession?: never }).centralSession,
      projectUuid.parse(String((req.params as { uuid?: string }).uuid ?? "")),
      assetUuid.parse(String((req.params as { assetUuid?: string }).assetUuid ?? "")),
      { buffer: file.buffer, mime: file.mime, filename: file.filename },
    );
    res.status(200).send({ code: 0, data, message: "角色音频已上传" });
  } catch (error) {
    writeError(res, error);
  }
});

router.patch("/assets/:assetUuid", async (req, res) => {
  try {
    const data = await sharedAssetGateway.updateAsset(
      (req as { centralSession?: never }).centralSession,
      projectUuid.parse(String((req.params as { uuid?: string }).uuid ?? "")),
      assetUuid.parse(String((req.params as { assetUuid?: string }).assetUuid ?? "")),
      {
        name: typeof req.body?.name === "string" ? req.body.name : undefined,
        describe: typeof req.body?.describe === "string" ? req.body.describe : undefined,
        remark: typeof req.body?.remark === "string" ? req.body.remark : undefined,
        prompt: typeof req.body?.prompt === "string" ? req.body.prompt : undefined,
        imageRatio: typeof req.body?.imageRatio === "string" ? req.body.imageRatio : undefined,
      },
    );
    res.status(200).send({ code: 0, data, message: "共享资产已更新" });
  } catch (error) {
    writeError(res, error);
  }
});

router.delete("/assets/:assetUuid", async (req, res) => {
  try {
    const data = await sharedAssetGateway.deleteAsset(
      (req as { centralSession?: never }).centralSession,
      projectUuid.parse(String((req.params as { uuid?: string }).uuid ?? "")),
      assetUuid.parse(String((req.params as { assetUuid?: string }).assetUuid ?? "")),
    );
    res.status(200).send({ code: 0, data, message: "共享资产已删除" });
  } catch (error) {
    writeError(res, error);
  }
});

export default router;
