import axios from "@/utils/axios";
import {
  normalizeStoryboardVideoResolution,
  type StoryboardGenerationItem,
  type WorkspaceShot,
} from "./storyboard-workbench-types";

export interface SafeGenerationReferenceSummary {
  image: { count: number; labels: string[] };
  video: { count: number; labels: string[] };
  audio: { count: number; labels: string[] };
}

export interface SafeStoryboardGenerationPreview {
  previewDigest: string;
  providerModel: string;
  routeKind: StoryboardGenerationRouteKind;
  prompt: string;
  options: Record<string, string | number | boolean>;
  referenceSummary?: SafeGenerationReferenceSummary;
}

export type StoryboardGenerationRouteKind = "dreamina-cli" | "vendor";

function routeKindForProviderModel(providerModel: string): StoryboardGenerationRouteKind {
  return providerModel.startsWith("dreamina-cli:") ? "dreamina-cli" : "vendor";
}

export interface StoryboardGenerationPreviewInput extends Omit<StoryboardGenerationItem, "mode"> {
  /** auto 只允许发给非收费预览；正式生成必须使用服务端返回的显式模式。 */
  mode: StoryboardGenerationItem["mode"] | "auto";
  shot?: Partial<WorkspaceShot>;
  settings?: {
    globalImagePrompt?: string;
    globalVideoPrompt?: string;
    globalNegativePrompt?: string;
  };
}

const SAFE_OPTION_KEYS = new Set(["aspectRatio", "resolution", "durationMs", "mode"]);

const PUBLIC_GENERATION_PREVIEW_MESSAGES: Record<string, string> = {
  STORYBOARD_SHOT_NOT_FOUND: "分镜不存在",
  STORYBOARD_REFERENCE_MISSING: "分镜参考素材记录缺失",
  STORYBOARD_REFERENCE_FILE_MISSING: "分镜参考素材文件缺失",
  STORYBOARD_DREAMINA_MODE_UNSUPPORTED: "当前即梦模式暂不可预览",
  STORYBOARD_BOUND_TEXT_MODE: "有角色、场景或道具绑定时不能使用纯文本生成",
  STORYBOARD_IMPORT_FORBIDDEN: "当前身份不能写入该项目",
  DREAMINA_CLI_DISABLED: "即梦 CLI 已关闭",
  DREAMINA_CLI_NOT_INSTALLED: "未安装即梦 CLI 或无法执行",
  DREAMINA_CLI_NOT_LOGGED_IN: "未登录即梦账号",
  DREAMINA_CLI_START_FAILED: "即梦 CLI 启动失败",
  DREAMINA_CLI_INVALID_ARGUMENT: "即梦 CLI 请求参数不合法",
  STORYBOARD_VIDEO_RESOLUTION_UNSUPPORTED: "当前视频模型不支持所选分辨率",
};

export const PUBLIC_GENERATION_SUBMIT_MESSAGES: Record<string, string> = {
  STORYBOARD_SHOT_NOT_FOUND: "分镜不存在",
  STORYBOARD_REFERENCE_MISSING: "分镜参考素材记录缺失",
  STORYBOARD_REFERENCE_FILE_MISSING: "分镜参考素材文件缺失",
  STORYBOARD_DREAMINA_MODE_UNSUPPORTED: "当前即梦 CLI 不支持当前模式",
  STORYBOARD_BOUND_TEXT_MODE: "有角色、场景或道具绑定时不能使用纯文本生成",
  STORYBOARD_IMPORT_FORBIDDEN: "当前身份不能写入该项目",
  STORYBOARD_VIDEO_DURATION_INVALID: "视频时长必须是 4 到 30 的整数秒",
  STORYBOARD_DURATION_EXCEEDS_MODEL: "当前模型不支持该视频时长",
  STORYBOARD_VENDOR_MODE_UNSUPPORTED: "当前模型不支持该参考素材形态",
  STORYBOARD_PREVIEW_REQUIRED: "生成前必须先完成最终请求预览确认",
  STORYBOARD_PREVIEW_STALE: "最终请求已变化，请重新预览确认",
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
  STORYBOARD_VIDEO_RESOLUTION_UNSUPPORTED: "当前视频模型不支持所选分辨率",
};

export function readSafeGenerationSubmitError(error: unknown, fallback: string): string {
  if (!error || typeof error !== "object") return fallback;
  const record = error as { message?: unknown; code?: unknown; response?: { data?: { message?: unknown; code?: unknown } } };
  const payload = record.response?.data && typeof record.response.data === "object" ? record.response.data : record;
  const code = typeof payload.code === "string" ? payload.code.trim() : "";
  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  if (code === "STORYBOARD_DREAMINA_MODE_UNSUPPORTED" && /^当前即梦 CLI 不支持 [A-Za-z0-9_]+$/.test(message)) {
    return message;
  }
  if (code && PUBLIC_GENERATION_SUBMIT_MESSAGES[code]) return PUBLIC_GENERATION_SUBMIT_MESSAGES[code];
  if (message && Object.values(PUBLIC_GENERATION_SUBMIT_MESSAGES).includes(message)) return message;
  return fallback;
}

export function readSafeGenerationPreviewError(error: unknown, fallback: string): string {
  // 中文注释：只展示白名单稳定 code/message，未知错误回退通用文案，禁止回显路径或堆栈。
  if (!error || typeof error !== "object") return fallback;
  const record = error as { message?: unknown; code?: unknown; response?: { data?: { message?: unknown; code?: unknown } } };
  // 中文注释：Axios 会把服务端公开错误放在 response.data；直接错误对象仅用于本地校验失败。
  const payload = record.response?.data && typeof record.response.data === "object" ? record.response.data : record;
  const code = typeof payload.code === "string" ? payload.code.trim() : "";
  if (code && PUBLIC_GENERATION_PREVIEW_MESSAGES[code]) return PUBLIC_GENERATION_PREVIEW_MESSAGES[code];
  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  if (message && Object.values(PUBLIC_GENERATION_PREVIEW_MESSAGES).includes(message)) return message;
  return fallback;
}

function unwrapData(payload: unknown): unknown {
  let current = payload;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!current || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, "data")) break;
    current = (current as { data?: unknown }).data;
  }
  return current;
}

/**
 * 只接收最终请求预览的公开白名单字段，禁止把响应中的凭据、路径或调试对象带进 DOM。
 */
function normalizePreview(payload: unknown): SafeStoryboardGenerationPreview {
  if (!payload || typeof payload !== "object") throw new Error("生成预览响应无效");
  const row = payload as Record<string, unknown>;
  const providerModel = typeof row.providerModel === "string" ? row.providerModel.trim() : "";
  const routeKind = row.routeKind === "dreamina-cli" || row.routeKind === "vendor"
    ? row.routeKind
    : "";
  // 中文注释：摘要参与原子收费确认，必须逐字节匹配服务端规范值，不能 trim 后宽松接受。
  const previewDigest = typeof row.previewDigest === "string" ? row.previewDigest : "";
  const prompt = typeof row.prompt === "string" ? row.prompt : "";
  const rawOptions = row.options && typeof row.options === "object"
    ? row.options as Record<string, unknown>
    : {};
  const options: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(rawOptions)) {
    if (!SAFE_OPTION_KEYS.has(key) || !["string", "number", "boolean"].includes(typeof value)) continue;
    options[key] = value as string | number | boolean;
  }
  // 中文注释：摘要是后端原子确认合同，只接受规范的小写 SHA-256，禁止空值或宽松转换。
  if (!/^[0-9a-f]{64}$/.test(previewDigest)) throw new Error("生成预览摘要无效");
  if (!providerModel || !prompt || !routeKind) throw new Error("生成预览响应缺少必要字段");
  if (routeKind !== routeKindForProviderModel(providerModel)) {
    // 中文注释：服务端模型与执行路由必须成对确认，禁止即梦预览被普通供应商收费路径复用。
    throw new Error("生成预览与当前参数不一致");
  }
  const rawSummary = row.referenceSummary && typeof row.referenceSummary === "object"
    ? row.referenceSummary as Record<string, unknown>
    : null;
  const readBucket = (value: unknown) => {
    const bucket = value && typeof value === "object" ? value as { count?: unknown; labels?: unknown } : {};
    const count = Number(bucket.count);
    const labels = Array.isArray(bucket.labels)
      ? bucket.labels.map((item) => String(item)).filter((item) => item && !/filePath|md5|assetUuid|[A-Za-z]:\\|\\\\/.test(item))
      : [];
    return { count: Number.isFinite(count) && count > 0 ? count : 0, labels };
  };
  return {
    previewDigest,
    providerModel,
    routeKind,
    prompt,
    options,
    ...(rawSummary ? {
      referenceSummary: {
        image: readBucket(rawSummary.image),
        video: readBucket(rawSummary.video),
        audio: readBucket(rawSummary.audio),
      },
    } : {}),
  };
}

const IMAGE_MODES = new Set<string>(["text2image", "image2image"]);
const VIDEO_MODES = new Set<string>([
  "text2video",
  "image2video",
  "frames2video",
  "multiframe2video",
  "multimodal2video",
]);

/**
 * 服务端必须把 auto 解析成当前媒体类型允许的显式模式；该返回值可安全用于正式收费请求。
 */
export function resolvedStoryboardGenerationMode(
  preview: SafeStoryboardGenerationPreview,
  mediaType: StoryboardGenerationItem["mediaType"],
): StoryboardGenerationItem["mode"] {
  const mode = String(preview.options.mode ?? "") as StoryboardGenerationItem["mode"];
  const allowed = mediaType === "image" ? IMAGE_MODES : VIDEO_MODES;
  if (!allowed.has(mode)) throw new Error("生成预览未返回有效显式模式");
  return mode;
}

export function buildGenerationPreviewBody(input: StoryboardGenerationPreviewInput): Record<string, unknown> {
  const aspectRatio = String(input.aspectRatio ?? input.shot?.aspectRatio ?? "").trim();
  const durationMs = Number(input.durationMs ?? input.shot?.durationMs ?? 0);
  // 中文注释：图片与视频使用不同分辨率参数域；预览按媒体显式声明安全默认值，
  // 禁止把项目中的 720p 当作图片尺寸，或把 1K 当作视频分辨率。
  const resolution = input.mediaType === "image"
    ? "1K"
    : normalizeStoryboardVideoResolution(input.resolution);
  if (!resolution) {
    throw new Error("当前选择的视频分辨率不受支持");
  }
  const shot = {
    ...(input.shot ?? {}),
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(durationMs > 0 ? { durationMs } : {}),
  };
  return {
    shotUuid: input.shotUuid,
    mediaType: input.mediaType,
    providerModel: input.providerModel,
    mode: input.mode,
    settings: {
      ...(input.settings ?? {}),
      ...(aspectRatio ? { aspectRatio } : {}),
      ...(durationMs > 0 ? { durationMs } : {}),
      resolution,
    },
    shot,
  };
}

/**
 * 调用既有非收费 preview 路由，并校验响应仍对应当前模型、模式、画幅与时长。
 */
export async function requestStoryboardGenerationPreview(
  projectUuid: string,
  input: StoryboardGenerationPreviewInput,
): Promise<SafeStoryboardGenerationPreview> {
  const body = buildGenerationPreviewBody(input);
  const response = await axios.post(
    `/tianjiang/runtime/projects/${encodeURIComponent(projectUuid)}/storyboard/generate/preview`,
    body,
  );
  const preview = normalizePreview(unwrapData(response));
  const options = preview.options;
  const resolvedMode = resolvedStoryboardGenerationMode(preview, input.mediaType);
  if (
    preview.providerModel !== input.providerModel
    || (input.mode !== "auto" && resolvedMode !== input.mode)
    || String(options.aspectRatio ?? "") !== String(input.aspectRatio ?? input.shot?.aspectRatio ?? "")
    || Number(options.durationMs ?? 0) !== Number(input.durationMs ?? input.shot?.durationMs ?? 0)
    || String(options.resolution ?? "") !== String(body.settings && typeof body.settings === "object"
      ? (body.settings as Record<string, unknown>).resolution ?? ""
      : "")
  ) {
    throw new Error("生成预览与当前参数不一致");
  }
  return preview;
}
