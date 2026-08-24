/**
 * 原视频工作台即梦提交：复用现有 ensureDreaminaExecuteReady / 队列 / 调度，
 * 禁止 Web 层执行 CLI，禁止伪造分镜 shotUuid。
 */
import crypto from "node:crypto";
import type { Response } from "express";

import { db as activeDb, prepareProjectDatabase } from "@/utils/db";
import { readDreaminaCapabilityCache } from "@/tianjiang/model-providers/dreamina-cli/capability-cache";
import {
  DreaminaEnqueueError,
  createEnqueueRequestIntentDigest,
  enqueueAsyncMediaTasks,
  normalizeDreaminaClientOperationId,
  replayAcceptedDreaminaEnqueue,
  stableDreaminaTaskUuid,
} from "@/tianjiang/model-providers/async-generation-service";
import { hashProjectFileIdentity } from "@/tianjiang/media/project-file-inventory";
import { classifyProjectFile } from "@/tianjiang/media/project-file-store";
import getPath from "@/utils/getPath";
import { syncCoordinator } from "@/tianjiang/runtime/runtime";
import { currentUserStorage, runWithProjectStorage } from "@/tianjiang/runtime/user-storage-context";
import {
  assertDreaminaGenerationRequest,
  mapWorkbenchVideoModeToDreamina,
  parseDreaminaVideoModel,
  readWorkbenchGenerationOrigin,
  resolveDreaminaGenerationMode,
  type FinalGenerationRequest,
  type ProjectMediaReference,
} from "@/tianjiang/storyboard/storyboard-generation-service";

export const WORKBENCH_DREAMINA_ERROR_MESSAGES: Record<string, string> = {
  DREAMINA_CLI_DISABLED: "即梦 CLI 已关闭",
  DREAMINA_CLI_NOT_INSTALLED: "未安装即梦 CLI 或无法执行",
  DREAMINA_CLI_NOT_LOGGED_IN: "未登录即梦账号",
  STORYBOARD_DREAMINA_CLI_UNAVAILABLE: "即梦 CLI 不可用",
  STORYBOARD_DREAMINA_MODE_UNSUPPORTED: "当前即梦 CLI 不支持当前模式",
  DREAMINA_CLI_MODEL_UNSUPPORTED: "当前即梦模型不支持",
  DREAMINA_BATCH_PERSIST_FAILED: "生成任务入队失败，请重试",
  DREAMINA_EMPTY_BATCH: "没有可提交的生成任务",
  DREAMINA_PAID_BATCH_CONFIRMATION_REQUIRED: "批量付费任务需要确认后才能写入",
  DREAMINA_CLIENT_OPERATION_ID_INVALID: "生成操作 ID 无效",
  DREAMINA_CLIENT_OPERATION_CONFLICT: "同一生成操作 ID 对应的请求意图已变化",
  DREAMINA_ENQUEUE_RECOVERING: "生成操作已受理，正在恢复本机队列",
  WORKBENCH_TRACK_REQUIRED: "请先选择轨道",
  WORKBENCH_MODEL_REQUIRED: "请先选择模型",
  WORKBENCH_PROMPT_REQUIRED: "即梦生成提示词不能为空",
  WORKBENCH_PROJECT_NOT_FOUND: "项目不存在或不可见",
  WORKBENCH_QUEUE_PAUSED: "即梦队列已暂停",
  WORKBENCH_REFERENCE_INVALID: "参考素材与当前模式不兼容",
  WORKBENCH_REFERENCE_UNSAFE: "参考素材不在当前项目内",
  WORKBENCH_VIDEO_HISTORY_MISSING: "工作台历史记录缺失",
};

const WORKBENCH_DREAMINA_FALLBACK_CODE = "WORKBENCH_DREAMINA_REQUEST_FAILED";

export function isDreaminaCliModel(model: string): boolean {
  return String(model ?? "").startsWith("dreamina-cli:");
}

export function writeWorkbenchDreaminaError(res: Response, error: unknown): void {
  if (res.headersSent) return;
  const status = error instanceof DreaminaEnqueueError
    ? error.status
    : typeof (error as { status?: unknown })?.status === "number"
      ? Number((error as { status: number }).status)
      : 400;
  const rawCode = error instanceof DreaminaEnqueueError
    ? error.code
    : typeof (error as { code?: unknown })?.code === "string"
      ? String((error as { code: string }).code)
      : "";
  const mapped = rawCode && Object.hasOwn(WORKBENCH_DREAMINA_ERROR_MESSAGES, rawCode)
    ? WORKBENCH_DREAMINA_ERROR_MESSAGES[rawCode]
    : undefined;
  const current = error instanceof Error ? error.message : "";
  const dreaminaMode = rawCode === "STORYBOARD_DREAMINA_MODE_UNSUPPORTED"
    && /^当前即梦 CLI 不支持 [A-Za-z0-9_.]+$/.test(current)
    ? current
    : undefined;
  if (mapped || dreaminaMode) {
    res.status(status >= 400 && status < 600 ? status : 400).send({
      code: rawCode,
      message: dreaminaMode ?? mapped,
      ...(error instanceof DreaminaEnqueueError && error.data ? { data: error.data } : {}),
    });
    return;
  }
  // 中文注释：未知服务端 code/message 都属于不可信自由文本，只返回固定安全合同。
  res.status(status >= 400 && status < 600 ? status : 400).send({
    code: WORKBENCH_DREAMINA_FALLBACK_CODE,
    message: "提交生成失败，请重试",
  });
}

export async function resolveWorkbenchProjectUuid(
  projectId: number,
  session?: unknown,
): Promise<string> {
  if (!Number.isInteger(projectId) || projectId <= 0) {
    throw Object.assign(new Error("项目不存在或不可见"), {
      status: 404,
      code: "WORKBENCH_PROJECT_NOT_FOUND",
    });
  }
  const current = currentUserStorage()?.projectUuid;
  if (current) {
    await prepareProjectDatabase(current);
    const row = await runWithProjectStorage(current, () =>
      activeDb("o_project").where({ id: projectId }).first());
    if (row) return current;
  }
  const catalog = syncCoordinator.listProjects(session as never);
  for (const item of catalog) {
    const uuid = String((item as { projectUuid?: unknown }).projectUuid ?? "");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) {
      continue;
    }
    try {
      await prepareProjectDatabase(uuid);
      const row = await runWithProjectStorage(uuid, () =>
        activeDb("o_project").where({ id: projectId }).first());
      if (row) return uuid;
    } catch {
      continue;
    }
  }
  throw Object.assign(new Error("项目不存在或不可见"), {
    status: 404,
    code: "WORKBENCH_PROJECT_NOT_FOUND",
  });
}

export interface WorkbenchUploadItem {
  id: number;
  sources: string;
}

export interface WorkbenchDreaminaItemInput {
  projectId: number;
  scriptId: number;
  trackId: number;
  prompt: string;
  model: string;
  mode: string;
  resolution: string;
  duration: number;
  audio?: boolean;
  uploadData?: WorkbenchUploadItem[];
}

let afterTaskPersistBeforeVideoHookForTests: (() => Promise<void> | void) | null = null;
let afterVideoBeforeDispatchReadyHookForTests: (() => Promise<void> | void) | null = null;
let bindItemHookForTests: ((index: number) => Promise<void> | void) | null = null;

export function setWorkbenchAfterTaskPersistBeforeVideoHookForTests(
  hook: (() => Promise<void> | void) | null,
): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  afterTaskPersistBeforeVideoHookForTests = hook;
}

export function setWorkbenchAfterVideoBeforeDispatchReadyHookForTests(
  hook: (() => Promise<void> | void) | null,
): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  afterVideoBeforeDispatchReadyHookForTests = hook;
}

export function setWorkbenchBindItemHookForTests(
  hook: ((index: number) => Promise<void> | void) | null,
): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  bindItemHookForTests = hook;
}

async function assertWorkbenchTrack(input: {
  projectId: number;
  scriptId: number;
  trackId: number;
}): Promise<void> {
  const track = await activeDb("o_videoTrack")
    .where({
      id: input.trackId,
      projectId: input.projectId,
      scriptId: input.scriptId,
    })
    .first();
  if (!track) {
    throw Object.assign(new Error("请先选择轨道"), {
      status: 400,
      code: "WORKBENCH_TRACK_REQUIRED",
    });
  }
}

function assertProjectRelativeMediaPath(raw: string): string {
  const value = String(raw ?? "").trim().replace(/\\/g, "/");
  if (
    !value
    || !value.startsWith("files/")
    || value.includes("..")
    || value.startsWith("file:")
    || /^[a-zA-Z]:/.test(value)
    || value.startsWith("//")
    || /^https?:/i.test(value)
    || /[\u0000-\u001f]/.test(value)
  ) {
    throw Object.assign(new Error("参考素材不在当前项目内"), {
      status: 400,
      code: "WORKBENCH_REFERENCE_UNSAFE",
    });
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw Object.assign(new Error("参考素材不在当前项目内"), {
      status: 400,
      code: "WORKBENCH_REFERENCE_UNSAFE",
    });
  }
  return value;
}

async function lookupUploadPath(item: WorkbenchUploadItem): Promise<{ filePath: string; hint?: string }> {
  if (item.sources === "storyboard") {
    const row = await activeDb("o_storyboard").where({ id: item.id }).select("filePath").first();
    return { filePath: String(row?.filePath ?? "") };
  }
  if (item.sources === "assets") {
    const row = await activeDb("o_assets")
      .where("o_assets.id", item.id)
      .leftJoin("o_image", "o_assets.imageId", "o_image.id")
      .select("o_image.filePath", "o_image.type")
      .first();
    return { filePath: String(row?.filePath ?? ""), hint: String(row?.type ?? "") };
  }
  throw Object.assign(new Error("参考素材不在当前项目内"), {
    status: 400,
    code: "WORKBENCH_REFERENCE_UNSAFE",
  });
}

async function resolveWorkbenchReferences(
  projectUuid: string,
  uploadData: WorkbenchUploadItem[] | undefined,
): Promise<ProjectMediaReference[]> {
  const items = Array.isArray(uploadData) ? uploadData : [];
  const context = currentUserStorage();
  if (!context) {
    throw Object.assign(new Error("缺少账号上下文，禁止即梦任务入队"), { status: 403 });
  }
  const resolved: ProjectMediaReference[] = [];
  for (const item of items) {
    const looked = await lookupUploadPath(item);
    const relativePath = assertProjectRelativeMediaPath(looked.filePath);
    let digest: { md5: string; size: number };
    try {
      // 中文注释：路径边界、文件身份与摘要绑定同一个安全 fd，禁止校验后按路径 reopen。
      digest = hashProjectFileIdentity(getPath(), projectUuid, context.segment, relativePath);
    } catch {
      throw Object.assign(new Error("参考素材不在当前项目内"), {
        status: 400,
        code: "WORKBENCH_REFERENCE_UNSAFE",
      });
    }
    const classified = classifyProjectFile(relativePath);
    const mediaType = classified.mediaType === "video" || classified.mediaType === "audio" || classified.mediaType === "image"
      ? classified.mediaType
      : looked.hint === "video" || looked.hint === "audio" || looked.hint === "image"
        ? looked.hint
        : null;
    if (mediaType !== "image" && mediaType !== "video" && mediaType !== "audio") {
      throw Object.assign(new Error("参考素材与当前模式不兼容"), {
        status: 400,
        code: "WORKBENCH_REFERENCE_INVALID",
      });
    }
    resolved.push({
      relativePath,
      mediaType,
      md5: digest.md5,
      size: digest.size,
    });
  }
  return resolved;
}

function buildWorkbenchDreaminaRequest(input: WorkbenchDreaminaItemInput & {
  cliMode: ReturnType<typeof mapWorkbenchVideoModeToDreamina>;
  aspectRatio: string;
  references: readonly ProjectMediaReference[];
}): FinalGenerationRequest {
  const cached = readDreaminaCapabilityCache();
  const fields = cached.snapshot?.modes[input.cliMode]?.fields;
  if (!Array.isArray(fields) || fields.length === 0) {
    throw Object.assign(new Error("即梦 CLI 不可用"), {
      status: 400,
      code: "STORYBOARD_DREAMINA_CLI_UNAVAILABLE",
    });
  }
  const prompt = String(input.prompt ?? "").trim();
  if (!prompt) {
    throw Object.assign(new Error("即梦生成提示词不能为空"), {
      status: 400,
      code: "WORKBENCH_PROMPT_REQUIRED",
    });
  }
  const durationMs = Number(input.duration) * 1_000;
  if (!Number.isInteger(durationMs) || durationMs <= 0) {
    throw Object.assign(new Error("即梦视频时长必须是整秒"), { status: 400 });
  }
  return {
    providerModel: input.model,
    prompt,
    references: [...input.references],
    capabilityFields: [...fields],
    options: {
      aspectRatio: input.aspectRatio || "16:9",
      resolution: String(input.resolution ?? "").trim(),
      durationMs,
      mode: input.cliMode,
      audio: input.audio === true,
    },
    workbenchOrigin: {
      origin: "workbench",
      projectId: input.projectId,
      scriptId: input.scriptId,
      trackId: input.trackId,
    },
  };
}

function resolveWorkbenchClientOperationId(raw: unknown): string {
  // 中文注释：只有字段真正缺省才生成 ID；非法调用方输入必须稳定 400，不能悄悄变成另一笔收费操作。
  return raw === undefined
    ? crypto.randomUUID()
    : normalizeDreaminaClientOperationId(raw);
}

function createWorkbenchRequestIntentDigest(input: {
  projectUuid: string;
  paidBatchConfirmed: boolean;
  items: readonly WorkbenchDreaminaItemInput[];
}): string {
  return createEnqueueRequestIntentDigest({
    projectUuid: input.projectUuid,
    action: "generate",
    paidBatchConfirmed: input.paidBatchConfirmed,
    // 中文注释：意图摘要只使用用户请求身份，不包含 CLI 能力、文件内容哈希或数据库可变状态。
    items: input.items.map((item) => ({
      projectId: item.projectId,
      scriptId: item.scriptId,
      trackId: item.trackId,
      prompt: String(item.prompt ?? "").trim(),
      model: String(item.model ?? "").trim(),
      mode: String(item.mode ?? ""),
      resolution: String(item.resolution ?? "").trim(),
      duration: Number(item.duration),
      audio: item.audio === true,
      uploadData: (item.uploadData ?? []).map((reference) => ({
        id: reference.id,
        sources: reference.sources,
      })),
    })),
  });
}

async function bindWorkbenchVideosAtomic(input: {
  records: Array<{
    taskUuid: string;
    item: { request: FinalGenerationRequest };
  }>;
}): Promise<Array<{ videoId: number; trackId: number; taskId: string }>> {
  if (!(await activeDb.schema.hasColumn("o_video", "generationTaskUuid"))) {
    throw Object.assign(new Error("工作台历史记录缺失"), {
      status: 500,
      code: "WORKBENCH_VIDEO_HISTORY_MISSING",
    });
  }
  return activeDb.transaction(async (trx) => {
    const bound: Array<{ videoId: number; trackId: number; taskId: string }> = [];
    for (let index = 0; index < input.records.length; index += 1) {
      if (bindItemHookForTests) await bindItemHookForTests(index);
      const record = input.records[index]!;
      const origin = readWorkbenchGenerationOrigin(record.item.request);
      if (!origin) {
        throw Object.assign(new Error("工作台即梦任务缺少来源身份"), {
          status: 400,
          code: "DREAMINA_INVALID_ARGUMENT",
        });
      }
      const existing = await trx("o_video").where({ generationTaskUuid: record.taskUuid }).select();
      if (existing.length > 0) {
        const row = existing[0];
        const valid = existing.length === 1
          && Number.isInteger(Number(row?.id))
          && Number(row?.id) > 0
          && Number(row?.projectId) === origin.projectId
          && Number(row?.scriptId) === origin.scriptId
          && Number(row?.videoTrackId) === origin.trackId;
        if (!valid) {
          throw Object.assign(new Error("工作台历史记录缺失"), {
            status: 500,
            code: "WORKBENCH_VIDEO_HISTORY_MISSING",
          });
        }
        bound.push({
          videoId: Number(row.id),
          trackId: origin.trackId,
          taskId: record.taskUuid,
        });
        continue;
      }
      const [videoId] = await trx("o_video").insert({
        filePath: "",
        time: Date.now(),
        state: "生成中",
        scriptId: origin.scriptId,
        projectId: origin.projectId,
        videoTrackId: origin.trackId,
        generationTaskUuid: record.taskUuid,
      });
      if (!Number.isInteger(Number(videoId)) || Number(videoId) <= 0) {
        throw Object.assign(new Error("工作台历史记录缺失"), {
          status: 500,
          code: "WORKBENCH_VIDEO_HISTORY_MISSING",
        });
      }
      bound.push({
        videoId: Number(videoId),
        trackId: origin.trackId,
        taskId: record.taskUuid,
      });
    }
    return bound;
  });
}

export async function enqueueWorkbenchDreaminaVideos(input: {
  projectUuid: string;
  items: WorkbenchDreaminaItemInput[];
  paidBatchConfirmed: boolean;
  clientOperationId?: string;
}): Promise<Array<{ videoId: number; trackId: number; taskId: string }>> {
  if (input.items.length === 0) {
    throw new DreaminaEnqueueError("DREAMINA_EMPTY_BATCH", "没有可提交的生成任务");
  }
  const clientOperationId = resolveWorkbenchClientOperationId(input.clientOperationId);
  const requestIntentDigest = createWorkbenchRequestIntentDigest(input);
  let bound: Array<{ videoId: number; trackId: number; taskId: string }> = [];
  const replay = await replayAcceptedDreaminaEnqueue({
    projectUuid: input.projectUuid,
    clientOperationId,
    requestIntentDigest,
    onAcceptedBeforeReady: async ({ records }) => {
      bound = await bindWorkbenchVideosAtomic({ records });
    },
  });
  if (replay) {
    if (bound.length !== replay.length || bound.some((item) => item.videoId <= 0)) {
      throw Object.assign(new Error("工作台历史记录缺失"), {
        status: 500,
        code: "WORKBENCH_VIDEO_HISTORY_MISSING",
      });
    }
    return bound;
  }
  const { ensureDreaminaExecuteReady } = await import(
    "@/tianjiang/model-providers/dreamina-cli/cli-truth"
  );
  // 中文注释：预检全部条目后再入队，任一失败都不得留下 operation/task/dispatch/o_video。
  const prepared: Array<{
    item: WorkbenchDreaminaItemInput;
    cliMode: ReturnType<typeof mapWorkbenchVideoModeToDreamina>;
    request: FinalGenerationRequest;
    identityUuid: string;
  }> = [];
  for (const [index, item] of input.items.entries()) {
    if (!String(item.model ?? "").trim()) {
      throw Object.assign(new Error("请先选择模型"), {
        status: 400,
        code: "WORKBENCH_MODEL_REQUIRED",
      });
    }
    try {
      parseDreaminaVideoModel(item.model);
    } catch {
      throw Object.assign(new Error("当前即梦模型不支持"), {
        status: 400,
        code: "DREAMINA_CLI_MODEL_UNSUPPORTED",
      });
    }
    await assertWorkbenchTrack(item);
    const project = await activeDb("o_project").select("videoRatio").where("id", item.projectId).first();
    const references = await resolveWorkbenchReferences(input.projectUuid, item.uploadData);
    const cliMode = mapWorkbenchVideoModeToDreamina(item.mode);
    await ensureDreaminaExecuteReady();
    try {
      resolveDreaminaGenerationMode({
        mediaType: "video",
        requestedMode: cliMode,
        references,
        capabilityPolicy: "execute",
      });
    } catch {
      throw Object.assign(new Error("参考素材与当前模式不兼容"), {
        status: 400,
        code: "WORKBENCH_REFERENCE_INVALID",
      });
    }
    const request = buildWorkbenchDreaminaRequest({
      ...item,
      resolution: item.resolution,
      cliMode,
      aspectRatio: String(project?.videoRatio ?? "16:9"),
      references,
    });
    assertDreaminaGenerationRequest({
      projectUuid: input.projectUuid,
      mediaType: "video",
      providerModel: item.model,
      mode: cliMode,
      request,
    }, { verifyReferenceIdentity: false });
    prepared.push({
      item,
      cliMode,
      request,
      identityUuid: stableDreaminaTaskUuid(input.projectUuid, clientOperationId, index),
    });
  }
  const queued = await enqueueAsyncMediaTasks({
    projectUuid: input.projectUuid,
    clientOperationId,
    requestIntentDigest,
    paidBatchConfirmed: input.paidBatchConfirmed,
    onPersistedBeforeReady: async ({ records }) => {
      if (afterTaskPersistBeforeVideoHookForTests) await afterTaskPersistBeforeVideoHookForTests();
      bound = await bindWorkbenchVideosAtomic({ records });
      if (afterVideoBeforeDispatchReadyHookForTests) await afterVideoBeforeDispatchReadyHookForTests();
    },
    items: prepared.map((entry) => ({
      // 中文注释：shotUuid 仅作为既有任务表身份槽，不得写入 o_storyboardShot。
      shotUuid: entry.identityUuid,
      mediaType: "video" as const,
      providerModel: entry.item.model,
      mode: entry.cliMode,
      request: entry.request,
      requestReferenceIdentityVerified: true,
      origin: "workbench" as const,
    })),
  });
  if (bound.length !== queued.length || bound.some((item) => item.videoId <= 0)) {
    throw Object.assign(new Error("工作台历史记录缺失"), {
      status: 500,
      code: "WORKBENCH_VIDEO_HISTORY_MISSING",
    });
  }
  return bound;
}
