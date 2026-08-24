import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { db as activeDb } from "@/utils/db";
import getPath from "@/utils/getPath";
import { getStableDeviceUUID } from "@/tianjiang/auth/device";
import type { ReferenceList } from "@/utils/ai";
import { readDreaminaCapabilityCache } from "../model-providers/dreamina-cli/capability-cache";
import {
  DREAMINA_IMAGE_MODELS,
  DREAMINA_IMAGE_MODES,
  DREAMINA_MODES,
  DREAMINA_VIDEO_MODELS,
  DREAMINA_VIDEO_MODES,
  type DreaminaImageModel,
  type DreaminaMode,
  type DreaminaVideoModel,
} from "../model-providers/dreamina-cli/contracts";
import { classifyProjectFile, resolveProjectFilePath } from "../media/project-file-store";
import { hashProjectFileIdentity } from "../media/project-file-inventory";
import { currentUserStorage, runWithProjectStorage } from "../runtime/user-storage-context";
import {
  assertStoryboardVideoDurationAgainstModel,
  buildSafeReferenceSummary,
  loadStoryboardAssetsByUuid,
  parseStoryboardVideoDurationMs,
  resolveCanonicalStoryboardVideoPrompt,
} from "./storyboard-video-prompt";

export interface StoryboardWorkspaceSettings {
  globalImagePrompt: string;
  globalVideoPrompt: string;
  globalNegativePrompt: string;
  textModel: string | null;
  imageModel: string | null;
  videoModel: string | null;
  aspectRatio: string;
  resolution: string;
  durationMs: number;
  imageConcurrency: number;
  videoConcurrency: number;
  videoPromptTemplateId?: number | null;
  videoPromptTemplateContent?: string | null;
}

export interface ProjectMediaReference {
  assetUuid?: string;
  relativePath?: string;
  mediaType?: "image" | "video" | "audio";
  md5?: string;
  size?: number;
}

export interface WorkbenchGenerationOrigin {
  origin: "workbench";
  projectId: number;
  scriptId: number;
  trackId: number;
  videoId?: number;
}

export interface FinalGenerationRequest {
  providerModel: string;
  prompt: string;
  negativePrompt?: string;
  references: readonly ProjectMediaReference[];
  /** 入队时的 CLI 能力字段快照；调度重启后必须按它精确传参。 */
  capabilityFields?: readonly string[];
  options: Readonly<Record<string, string | number | boolean>>;
  workbenchOrigin?: WorkbenchGenerationOrigin;
}

export type StoryboardGenerationRouteKind = "dreamina-cli" | "vendor";

/**
 * 普通供应商受理只读取当前账号已启用目录，不执行 prepare、供应商函数或网络请求。
 */
export async function assertVendorProviderModelAvailable(input: {
  providerModel: string;
  mediaType: "image" | "video";
}): Promise<void> {
  const separator = input.providerModel.indexOf(":");
  const vendorId = separator > 0 ? input.providerModel.slice(0, separator) : "";
  const modelName = separator > 0 ? input.providerModel.slice(separator + 1) : "";
  const unavailable = () => Object.assign(new Error("当前普通供应商模型不可用"), {
    status: 400,
    code: "STORYBOARD_VENDOR_MODEL_UNAVAILABLE",
  });
  if (!vendorId || !modelName) throw unavailable();
  try {
    const { accountDb } = await import("@/utils/db");
    const { buildMergedVendorModelList } = await import("@/utils/vendor");
    const row = await accountDb("o_vendorConfig")
      .where({ id: vendorId, enable: 1 })
      .first("models");
    if (!row) throw unavailable();
    const models = buildMergedVendorModelList(vendorId, row.models, { networkPolicy: "blocked" });
    const available = models.some((model) => (
      String(model.modelName ?? "") === modelName
      && String(model.type ?? "") === input.mediaType
    ));
    if (!available) throw unavailable();
  } catch (error) {
    if (String((error as { code?: unknown })?.code) === "STORYBOARD_VENDOR_MODEL_UNAVAILABLE") {
      throw error;
    }
    throw unavailable();
  }
}

/** providerModel 是路由真源；项目默认或客户端字段都不得覆盖它。 */
export function classifyStoryboardGenerationRoute(providerModel: string): StoryboardGenerationRouteKind {
  return providerModel.trim().startsWith("dreamina-cli:") ? "dreamina-cli" : "vendor";
}

/** 收费入口必须复核预览确认的路由类型，避免模型切换后落入另一条执行链。 */
export function assertStoryboardGenerationRoute(input: {
  providerModel: string;
  routeKind: StoryboardGenerationRouteKind;
}): StoryboardGenerationRouteKind {
  const actual = classifyStoryboardGenerationRoute(input.providerModel);
  if (actual !== input.routeKind) {
    throw Object.assign(new Error("生成路由已变化，请重新预览确认"), {
      status: 409,
      code: "STORYBOARD_GENERATION_ROUTE_MISMATCH",
    });
  }
  return actual;
}

/** 从已入队请求中读取工作台身份；缺字段时不得假装成分镜任务。 */
export function readWorkbenchGenerationOrigin(request: unknown): WorkbenchGenerationOrigin | null {
  if (!request || typeof request !== "object") return null;
  const origin = (request as FinalGenerationRequest).workbenchOrigin;
  if (!origin || origin.origin !== "workbench") return null;
  if (!Number.isInteger(origin.projectId) || origin.projectId <= 0) return null;
  if (!Number.isInteger(origin.scriptId) || origin.scriptId <= 0) return null;
  if (!Number.isInteger(origin.trackId) || origin.trackId <= 0) return null;
  return origin;
}

function userConfirmGenerationRequest(request: FinalGenerationRequest): Omit<FinalGenerationRequest, "capabilityFields"> {
  // 中文注释：用户确认摘要不得纳入运行时 capabilityFields，避免 preview 兜底字段与 execute 实时字段漂移。
  const { capabilityFields: _capabilityFields, ...confirm } = request;
  return confirm;
}

/**
 * 预览确认摘要只返回 SHA-256，不回传或记录提示词、引用路径等摘要输入。
 * 对象键递归排序，确保 preview 与正式提交在不同进程也得到同一结果。
 */
export function createStoryboardGenerationPreviewDigest(input: {
  projectUuid: string;
  shotUuid: string;
  mediaType: "image" | "video";
  request: FinalGenerationRequest;
}): string {
  return crypto.createHash("sha256")
    .update(JSON.stringify(stableCanonicalValue({
      projectUuid: input.projectUuid,
      shotUuid: input.shotUuid,
      mediaType: input.mediaType,
      request: userConfirmGenerationRequest(input.request),
    })))
    .digest("hex");
}

export interface ShotGenerationOverride {
  visualDescription?: string | null;
  imagePrompt?: string | null;
  videoPrompt?: string | null;
  negativePrompt?: string | null;
  aspectRatio?: string | null;
  durationMs?: number | null;
  era?: string | null;
  cameraMovement?: string | null;
  bindings?: readonly StoryboardAssetBindingInput[];
}

export interface SafeGenerationReferenceSummary {
  image: { count: number; labels: string[] };
  video: { count: number; labels: string[] };
  audio: { count: number; labels: string[] };
}

/** preview 只回页面确认所需白名单；完整引用、负向词和能力快照只参与内部摘要与执行。 */
export async function sanitizeStoryboardGenerationPreview(input: {
  projectUuid: string;
  shotUuid: string;
  mediaType: "image" | "video";
  request: FinalGenerationRequest;
}): Promise<{
  previewDigest: string;
  providerModel: string;
  routeKind: StoryboardGenerationRouteKind;
  prompt: string;
  options: {
    aspectRatio: string | number | boolean;
    resolution: string | number | boolean;
    durationMs: string | number | boolean;
    mode: string | number | boolean;
  };
  referenceSummary: SafeGenerationReferenceSummary;
}> {
  const assetsByUuid = await loadStoryboardAssetsByUuid(input.projectUuid, input.request.references);
  return {
    previewDigest: createStoryboardGenerationPreviewDigest(input),
    providerModel: input.request.providerModel,
    routeKind: classifyStoryboardGenerationRoute(input.request.providerModel),
    prompt: input.request.prompt,
    options: {
      aspectRatio: input.request.options.aspectRatio ?? "",
      resolution: input.request.options.resolution ?? "",
      durationMs: input.request.options.durationMs ?? 0,
      mode: input.request.options.mode ?? "",
    },
    referenceSummary: buildSafeReferenceSummary(input.request.references, assetsByUuid),
  };
}

export interface VendorImageGenerationInput {
  prompt: string;
  referenceList: Extract<ReferenceList, { type: "image" }>[];
  size: "1K" | "2K" | "4K";
  aspectRatio: `${number}:${number}`;
}

type VendorVideoMode =
  | "singleImage"
  | "startEndRequired"
  | "endFrameOptional"
  | "startFrameOptional"
  | "text"
  | (`videoReference:${number}` | `imageReference:${number}` | `audioReference:${number}`)[];

export interface VendorVideoGenerationInput {
  duration: number;
  resolution: string;
  aspectRatio: "16:9" | "9:16";
  prompt: string;
  referenceList: ReferenceList[];
  audio: boolean;
  mode: VendorVideoMode[];
}

export type AdaptedVendorGenerationRequest =
  | { mediaType: "image"; config: VendorImageGenerationInput }
  | { mediaType: "video"; config: VendorVideoGenerationInput };

const IMAGE_GENERATION_RESOLUTIONS = new Set(["1K", "2K", "4K"]);
const VIDEO_GENERATION_RESOLUTIONS = new Set(["480p", "720p", "1080p"]);

export function generationResolutionForMedia(
  mediaType: "image" | "video",
  rawResolution: unknown,
): string {
  const raw = String(rawResolution ?? "").trim();
  const imageResolution = raw.toUpperCase();
  if (mediaType === "image") {
    return IMAGE_GENERATION_RESOLUTIONS.has(imageResolution) ? imageResolution : "1K";
  }
  // 中文注释：只允许真正缺失的旧项目按 720p 迁移；任何显式非法值都必须 fail-closed。
  if (!raw) return "720p";
  const videoResolution = raw.toLowerCase();
  if (VIDEO_GENERATION_RESOLUTIONS.has(videoResolution)) return videoResolution;
  throw Object.assign(new Error("当前视频模型不支持所选分辨率"), {
    status: 400,
    code: "STORYBOARD_VIDEO_RESOLUTION_UNSUPPORTED",
  });
}

/**
 * 最终请求唯一合并器：提供商能力硬门 > 分镜覆盖 > 项目全局设置 > 模型默认值。
 */
export async function mergeFinalGenerationRequest(input: {
  mediaType: "image" | "video";
  providerModel: string;
  settings: Partial<StoryboardWorkspaceSettings>;
  shot?: ShotGenerationOverride;
  capabilities?: { aspectRatios?: string[]; maxDurationMs?: number };
  references?: readonly ProjectMediaReference[];
  mode?: string;
  projectUuid?: string;
}): Promise<FinalGenerationRequest> {
  const settings = input.settings;
  const shot = input.shot ?? {};
  const references = input.references ?? [];
  let prompt: string;
  if (input.mediaType === "video") {
    if (!input.projectUuid) {
      throw Object.assign(new Error("视频提示词缺少项目身份"), { status: 400 });
    }
    // 中文注释：Dreamina/普通供应商、单项/批量、preview/generate 必须共用这一份渲染结果。
    prompt = await resolveCanonicalStoryboardVideoPrompt({
      projectUuid: input.projectUuid,
      settings,
      shot,
      references,
    });
  } else {
    const globalPrompt = settings.globalImagePrompt ?? "";
    const shotPrompt = shot.imagePrompt || shot.visualDescription || "";
    prompt = [globalPrompt, shotPrompt].map((part) => part.trim()).filter(Boolean).join(" ");
  }
  const negative = shot.negativePrompt || settings.globalNegativePrompt || undefined;
  let aspectRatio = shot.aspectRatio || settings.aspectRatio || "16:9";
  if (input.capabilities?.aspectRatios?.length && !input.capabilities.aspectRatios.includes(aspectRatio)) {
    aspectRatio = input.capabilities.aspectRatios[0]!;
  }
  const rawDuration = shot.durationMs ?? settings.durationMs ?? 4000;
  const durationMs = input.mediaType === "video"
    ? parseStoryboardVideoDurationMs(rawDuration)
    : Number(rawDuration);
  if (input.mediaType === "video") {
    assertStoryboardVideoDurationAgainstModel(durationMs, input.capabilities?.maxDurationMs);
  }
  const mode = String(input.mode || "").trim()
    || (input.mediaType === "video" ? "text2video" : "text2image");
  return {
    providerModel: input.providerModel,
    prompt,
    negativePrompt: negative,
    references,
    options: {
      aspectRatio,
      resolution: generationResolutionForMedia(input.mediaType, settings.resolution),
      durationMs,
      mode,
    },
  };
}

/** 普通供应商 preview 与正式执行共用引用解析及最终请求合并，禁止摘要只确认 assetUuid。 */
export async function prepareVendorStoryboardGenerationRequest(input: {
  projectUuid: string;
  mediaType: "image" | "video";
  providerModel: string;
  requestedMode: string;
  settings: Partial<StoryboardWorkspaceSettings>;
  shot: ShotGenerationOverride & { bindings?: readonly StoryboardAssetBindingInput[] };
}): Promise<FinalGenerationRequest> {
  assertTextModeRejectsBoundAssets(input.requestedMode, input.shot.bindings);
  const projectReferences = await resolveStoryboardProjectReferences({
    projectUuid: input.projectUuid,
    bindings: input.shot.bindings ?? [],
  });
  const references = enrichVendorReferenceIdentity(input.projectUuid, projectReferences);
  // 中文注释：auto 必须在引用解析后由服务端收成显式模式，禁止前端按绑定数量猜收费请求。
  const mode = resolveVendorGenerationMode({
    mediaType: input.mediaType,
    requestedMode: input.requestedMode,
    references,
  });
  assertTextModeRejectsBoundAssets(mode, input.shot.bindings);
  return mergeFinalGenerationRequest({
    projectUuid: input.projectUuid,
    mediaType: input.mediaType,
    providerModel: input.providerModel,
    settings: input.settings,
    shot: input.shot,
    mode,
    references,
  });
}

/**
 * 工作台 VideoModel 模式 → CLI 模式。未知值 fail-closed，禁止静默改成 text2video。
 */
export function mapWorkbenchVideoModeToDreamina(mode: string): DreaminaMode {
  const raw = String(mode ?? "").trim();
  if (raw === "text" || raw === "text2video") return "text2video";
  if (raw === "singleImage" || raw === "image2video") return "image2video";
  if (raw === "startEndRequired" || raw === "frames2video") return "frames2video";
  if (raw === "multiframe2video" || raw === "multiframe") return "multiframe2video";
  if (raw === "multimodal2video" || raw === "multimodal") return "multimodal2video";
  const reference = /^(imageReference|videoReference|audioReference):([1-9]\d*)$/.exec(raw);
  if (reference) {
    const kind = reference[1];
    const count = Number(reference[2]);
    if (kind === "imageReference" && count === 1) return "image2video";
    if (kind === "imageReference" && count >= 2) return "multiframe2video";
    return "multimodal2video";
  }
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((item) => typeof item === "string")) {
        const mixed = parsed.some((item) => /^(videoReference|audioReference)/.test(item));
        return mixed ? "multimodal2video" : "multiframe2video";
      }
    } catch {
      // 中文注释：非法 JSON 不得猜测模式。
    }
  }
  if (DREAMINA_VIDEO_MODES.includes(raw as DreaminaMode)) return raw as DreaminaMode;
  throw Object.assign(new Error("当前即梦 CLI 不支持当前模式"), {
    status: 400,
    code: "STORYBOARD_DREAMINA_MODE_UNSUPPORTED",
  });
}

/** 将目录/模板中的模式别名收敛为分镜显式模式，未知值原样保留以便 fail-closed。 */
function normalizeVendorStoryboardMode(mode: string): string {
  const raw = String(mode ?? "").trim();
  if (raw === "text" || raw === "text2video") return "text2video";
  if (raw === "single" || raw === "singleImage" || raw === "image2video") return "image2video";
  if (raw === "startEnd" || raw === "startEndRequired" || raw === "frames2video") return "frames2video";
  if (raw === "multiframe" || raw === "multiframe2video") return "multiframe2video";
  if (raw === "multimodal" || raw === "multimodal2video") return "multimodal2video";
  if (raw === "text2image" || raw === "image2image") return raw;
  return raw;
}

/** 引用解析完成后统一解析普通供应商模式；未知模式不得静默降级成 text2video。 */
export function resolveVendorGenerationMode(input: {
  mediaType: "image" | "video";
  requestedMode: string;
  references: readonly ProjectMediaReference[];
  supportedModes?: readonly string[];
}): string {
  const requested = normalizeVendorStoryboardMode(input.requestedMode);
  const mediaTypes = input.references.map((item) => item.mediaType);
  const supported = new Set(
    (input.supportedModes ?? []).map((item) => normalizeVendorStoryboardMode(item)).filter(Boolean),
  );
  let selected: string;
  if (requested && requested !== "auto") {
    selected = requested;
  } else if (input.mediaType === "image") {
    selected = mediaTypes.length === 0 ? "text2image" : "image2image";
  } else if (mediaTypes.length === 0) {
    selected = "text2video";
  } else if (mediaTypes.length === 1 && mediaTypes[0] === "image") {
    selected = "image2video";
  } else if (mediaTypes.length === 2 && mediaTypes.every((item) => item === "image")) {
    selected = supported.size === 0 || supported.has("frames2video")
      ? "frames2video"
      : "multiframe2video";
  } else if (mediaTypes.every((item) => item === "image") && mediaTypes.length >= 2 && mediaTypes.length <= 8) {
    selected = "multiframe2video";
  } else if (mediaTypes.length >= 1 && mediaTypes.length <= 8) {
    selected = "multimodal2video";
  } else {
    throw Object.assign(new Error("普通供应商不支持当前参考素材形态"), {
      status: 400,
      code: "STORYBOARD_VENDOR_MODE_UNSUPPORTED",
    });
  }
  if (selected === "auto" || !selected) {
    throw Object.assign(new Error("普通供应商模式无效"), {
      status: 400,
      code: "STORYBOARD_VENDOR_MODE_UNSUPPORTED",
    });
  }
  if (supported.size > 0 && !supported.has(selected)) {
    throw Object.assign(new Error("当前模型不支持该参考素材形态"), {
      status: 400,
      code: "STORYBOARD_VENDOR_MODE_UNSUPPORTED",
    });
  }
  return selected;
}

/** 将分镜最终请求显式适配为 Ai.Image/Video 的顶层参数，禁止依赖不安全类型强转。 */
export function adaptVendorGenerationRequest(input: {
  projectUuid: string;
  mediaType: "image" | "video";
  request: FinalGenerationRequest;
}): AdaptedVendorGenerationRequest {
  const references = input.request.references.map((reference) =>
    toVendorMediaReference(input.projectUuid, reference));
  const aspectRatio = String(input.request.options.aspectRatio ?? "");
  if (!/^[1-9]\d{0,3}:[1-9]\d{0,3}$/.test(aspectRatio)) {
    throw Object.assign(new Error("普通供应商画幅无效"), { status: 400 });
  }
  if (input.mediaType === "image") {
    if (references.some((reference) => reference.type !== "image")) {
      throw Object.assign(new Error("图片生成只允许图片参考素材"), { status: 400 });
    }
    assertVendorImageReferenceContract(String(input.request.options.mode ?? ""), references.length);
    const rawSize = String(input.request.options.resolution ?? "").toUpperCase() || "1K";
    if (rawSize !== "1K" && rawSize !== "2K" && rawSize !== "4K") {
      throw Object.assign(new Error("普通供应商图片尺寸无效"), { status: 400 });
    }
    return {
      mediaType: "image",
      config: {
        prompt: input.request.prompt,
        referenceList: references as Extract<ReferenceList, { type: "image" }>[],
        size: rawSize,
        aspectRatio: aspectRatio as `${number}:${number}`,
      },
    };
  }
  if (aspectRatio !== "16:9" && aspectRatio !== "9:16") {
    throw Object.assign(new Error("普通供应商视频画幅仅支持 16:9 或 9:16"), { status: 400 });
  }
  const durationMs = Number(input.request.options.durationMs);
  const resolution = String(input.request.options.resolution ?? "").trim();
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw Object.assign(new Error("普通供应商视频时长无效"), { status: 400 });
  }
  if (!resolution) {
    throw Object.assign(new Error("普通供应商视频分辨率缺失"), { status: 400 });
  }
  return {
    mediaType: "video",
    config: {
      duration: durationMs / 1_000,
      resolution,
      aspectRatio,
      prompt: input.request.prompt,
      referenceList: references,
      audio: references.some((reference) => reference.type === "audio"),
      mode: mapStoryboardModeToVendorVideoMode(
        String(input.request.options.mode ?? ""),
        references,
      ),
    },
  };
}

export interface StoryboardAssetBindingInput {
  sourceProjectUuid: string;
  assetUuid: string;
  assetType?: string;
  relationRole?: string;
  voiceEnabled?: boolean;
}

function assertTextModeRejectsBoundAssets(
  requestedMode: string,
  bindings: readonly StoryboardAssetBindingInput[] | undefined,
): void {
  const mode = requestedMode.trim();
  if (mode !== "text2video" && mode !== "text2image") return;
  const bound = (bindings ?? []).some((binding) =>
    ["role", "scene", "tool"].includes(String(binding.assetType ?? "")),
  );
  if (bound) {
    throw Object.assign(new Error("有角色、场景或道具绑定时不能使用纯文本生成"), {
      status: 400,
      code: "STORYBOARD_BOUND_TEXT_MODE",
    });
  }
}

/** 正式生成与只读 preview 共用同一解析器，防止模式、模型或引用在两条路径漂移。 */
export async function prepareDreaminaStoryboardGenerationRequest(input: {
  projectUuid: string;
  mediaType: "image" | "video";
  providerModel: string;
  requestedMode: string;
  settings: Partial<StoryboardWorkspaceSettings>;
  shot: ShotGenerationOverride & { bindings?: readonly StoryboardAssetBindingInput[] };
  referenceIdentityCache?: Map<string, { md5: string; size: number }>;
  /** preview/enqueue 可使用已发布字段；只有后台 execute 越过 CLI 边界前必须走实时能力。 */
  capabilityPolicy?: DreaminaCapabilityPolicy;
}): Promise<{ mode: DreaminaMode; request: FinalGenerationRequest }> {
  const capabilityPolicy = input.capabilityPolicy ?? "execute";
  const { assertDreaminaCliEnabled } = await import("../model-providers/dreamina-cli/session-store");
  await assertDreaminaCliEnabled();
  if (capabilityPolicy === "execute") {
    const { ensureDreaminaExecuteReady } = await import("../model-providers/dreamina-cli/cli-truth");
    // 中文注释：正式执行必须等待当前用户同一套启动检测/能力缓存，禁止读取默认 local。
    await ensureDreaminaExecuteReady();
  }
  assertTextModeRejectsBoundAssets(input.requestedMode, input.shot.bindings);
  const projectReferences = await resolveStoryboardProjectReferences({
    projectUuid: input.projectUuid,
    bindings: input.shot.bindings ?? [],
  });
  const references = enrichDreaminaReferenceIdentity(
    input.projectUuid,
    projectReferences,
    input.referenceIdentityCache,
  );
  const mode = resolveDreaminaGenerationMode({
    mediaType: input.mediaType,
    requestedMode: input.requestedMode,
    references,
    capabilityPolicy,
  });
  assertDreaminaProviderModelForMedia({
    mediaType: input.mediaType,
    providerModel: input.providerModel,
    mode,
  });
  const request = await mergeFinalGenerationRequest({
    projectUuid: input.projectUuid,
    mediaType: input.mediaType,
    providerModel: input.providerModel,
    settings: input.settings,
    shot: input.shot,
    mode,
    references,
  });
  assertDreaminaDurationContract(input.mediaType, request.options.durationMs);
  const capabilityFields = readDreaminaModeFields(mode, capabilityPolicy);
  const preparedRequest: FinalGenerationRequest = {
    ...request,
    capabilityFields,
  };
  // 中文注释：preview 与耐久入队共用同一必需值校验，禁止把缺参数任务留到 CLI 才失败。
  assertDreaminaRequiredCliValues(mode, preparedRequest);
  return {
    mode,
    request: preparedRequest,
  };
}

/** 即梦图片模型合同固定为本机 CLI 已证明的 Seedream 版本。 */
export function parseDreaminaImageModel(
  providerModel: string,
  options: { allowLegacyMode?: boolean } = {},
): DreaminaImageModel | undefined {
  const prefix = "dreamina-cli:";
  const model = providerModel.startsWith(prefix) ? providerModel.slice(prefix.length) : "";
  if (DREAMINA_IMAGE_MODELS.includes(model as DreaminaImageModel)) {
    return model as DreaminaImageModel;
  }
  if (options.allowLegacyMode && DREAMINA_IMAGE_MODES.includes(model as DreaminaMode)) {
    return undefined;
  }
  throw Object.assign(new Error("即梦图片模型无效，禁止提交"), { status: 400 });
}

/** 即梦视频模型合同固定为 UI 公布的五个 Seedance 版本。 */
export function parseDreaminaVideoModel(providerModel: string): DreaminaVideoModel {
  const prefix = "dreamina-cli:";
  const model = providerModel.startsWith(prefix) ? providerModel.slice(prefix.length) : "";
  if (!DREAMINA_VIDEO_MODELS.includes(model as DreaminaVideoModel)) {
    throw Object.assign(new Error("即梦视频模型无效，禁止提交"), { status: 400 });
  }
  return model as DreaminaVideoModel;
}

/** 模型选择与媒体类型必须一致，禁止把 Seedance 视频模型静默降级为图片模式。 */
export function assertDreaminaProviderModelForMedia(input: {
  mediaType: "image" | "video";
  providerModel: string;
  mode?: DreaminaMode;
}): void {
  if (input.mediaType === "video") {
    parseDreaminaVideoModel(input.providerModel);
    return;
  }
  const suffix = input.providerModel.startsWith("dreamina-cli:")
    ? input.providerModel.slice("dreamina-cli:".length)
    : "";
  if (DREAMINA_IMAGE_MODELS.includes(suffix as DreaminaImageModel)) return;
  if (!DREAMINA_IMAGE_MODES.includes(suffix as DreaminaMode) || (input.mode && suffix !== input.mode)) {
    throw Object.assign(new Error("即梦图片模型与生成模式不一致"), { status: 400 });
  }
}

/** 只由用户请求内容决定模式，禁止按 CLI 缓存是否 ready 再选另一个 mode。 */
export function resolveCanonicalDreaminaMode(input: {
  mediaType: "image" | "video";
  requestedMode: string;
  references: readonly ProjectMediaReference[];
}): DreaminaMode {
  const requested = input.requestedMode.trim() || "auto";
  const mediaTypes = input.references.map((item) => item.mediaType);
  if (mediaTypes.some((item) => item !== "image" && item !== "video" && item !== "audio")) {
    throw Object.assign(new Error("即梦参考素材类型无效"), { status: 400 });
  }
  let selected: DreaminaMode;
  if (requested === "auto") {
    if (input.mediaType === "image") {
      selected = input.references.length === 0 ? "text2image" : "image2image";
    } else if (input.references.length === 0) {
      selected = "text2video";
    } else if (mediaTypes.length === 1 && mediaTypes[0] === "image") {
      selected = "image2video";
    } else if (mediaTypes.every((item) => item === "image") && mediaTypes.length >= 2) {
      selected = "multiframe2video";
    } else {
      selected = "multimodal2video";
    }
  } else {
    if (!DREAMINA_MODES.includes(requested as DreaminaMode)) {
      throw Object.assign(new Error("即梦生成模式无效"), { status: 400 });
    }
    selected = requested as DreaminaMode;
  }
  const family = input.mediaType === "video" ? DREAMINA_VIDEO_MODES : DREAMINA_IMAGE_MODES;
  if (!family.includes(selected)) {
    throw Object.assign(new Error("即梦生成模式与媒体类型不匹配"), { status: 400 });
  }
  assertReferenceContract(selected, mediaTypes);
  return selected;
}

function assertDreaminaExecuteAvailability(mode: DreaminaMode, mediaType: "image" | "video"): void {
  const cached = readDreaminaCapabilityCache();
  const snapshot = cached.snapshot;
  // 中文注释：安装/登录/能力探测失败/模式不支持必须分码，禁止把 failed 缓存伪装成未安装。
  if (snapshot?.installed === false) {
    throw Object.assign(new Error("未安装即梦 CLI 或无法执行"), {
      status: 400,
      code: "DREAMINA_CLI_NOT_INSTALLED",
    });
  }
  if (snapshot?.loggedIn === false) {
    throw Object.assign(new Error("未登录即梦账号"), {
      status: 400,
      code: "DREAMINA_CLI_NOT_LOGGED_IN",
    });
  }
  if (cached.state === "failed" || cached.state !== "ready" || snapshot?.installed !== true || snapshot.loggedIn == null) {
    // 中文注释：failed/null 不得仅因 installed!==true 推断未安装；只有 snapshot.installed===false 才是未安装。
    throw Object.assign(new Error("即梦 CLI 不可用"), {
      status: 400,
      code: "STORYBOARD_DREAMINA_CLI_UNAVAILABLE",
    });
  }
  const requiredFields = mediaType === "video" ? ["--model_version"] : [];
  if (!isDreaminaModeEnabled(mode, requiredFields, "execute")) {
    throw Object.assign(new Error(`当前即梦 CLI 不支持 ${mode}`), {
      status: 400,
      code: "STORYBOARD_DREAMINA_MODE_UNSUPPORTED",
    });
  }
}

/** preview 与 generate 共用同一份 canonical mode；execute 只验证不再改选。 */
export function resolveDreaminaGenerationMode(input: {
  mediaType: "image" | "video";
  requestedMode: string;
  references: readonly ProjectMediaReference[];
  capabilityPolicy?: DreaminaCapabilityPolicy;
}): DreaminaMode {
  const selected = resolveCanonicalDreaminaMode(input);
  if ((input.capabilityPolicy ?? "execute") !== "execute") return selected;
  assertDreaminaExecuteAvailability(selected, input.mediaType);
  return selected;
}

/** 将分镜绑定解析为当前项目 files/ 内的真实文件，队列只保存相对路径。 */
export async function resolveStoryboardProjectReferences(input: {
  projectUuid: string;
  bindings: readonly StoryboardAssetBindingInput[];
}): Promise<ProjectMediaReference[]> {
  const context = currentUserStorage();
  if (!context) throw Object.assign(new Error("缺少账号上下文，无法解析分镜素材"), { status: 403 });
  const resolved: ProjectMediaReference[] = [];
  const seenAudioPaths = new Set<string>();
  for (const binding of input.bindings) {
    if (binding.sourceProjectUuid !== input.projectUuid) {
      throw Object.assign(new Error("分镜参考素材不属于当前项目"), { status: 400 });
    }
    const asset = await runWithProjectStorage(input.projectUuid, () =>
      activeDb("o_assets").where({ assetUuid: binding.assetUuid }).first());
    const image = asset?.imageId != null
      ? await runWithProjectStorage(input.projectUuid, () =>
          activeDb("o_image").where({ id: asset.imageId }).first())
      : null;
    const relativePath = String(image?.filePath ?? "");
    if (!asset || !relativePath) {
      throw Object.assign(new Error("分镜参考素材记录缺失"), {
        status: 400,
        code: "STORYBOARD_REFERENCE_MISSING",
      });
    }
    let absolutePath: string;
    try {
      absolutePath = resolveProjectFilePath(getPath(), input.projectUuid, context.segment, relativePath);
    } catch {
      throw Object.assign(new Error("分镜参考素材路径越出当前项目"), { status: 400 });
    }
    let readableFile = false;
    try {
      readableFile = fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile();
    } catch {
      // 中文注释：stat 可能携带设备绝对路径，HTTP 边界只能返回固定安全错误。
      throw Object.assign(new Error("分镜参考素材文件不可读取"), { status: 400 });
    }
    if (!readableFile) {
      throw Object.assign(new Error("分镜参考素材文件缺失"), {
        status: 400,
        code: "STORYBOARD_REFERENCE_FILE_MISSING",
      });
    }
    const mediaType = classifyProjectFile(relativePath).mediaType;
    if (mediaType !== "image" && mediaType !== "video" && mediaType !== "audio") {
      throw Object.assign(new Error("分镜参考素材类型不受模型生成支持"), { status: 400 });
    }
    // 中文注释：持久化 POSIX 相对路径，禁止泄露设备盘符或跨设备绝对路径。
    resolved.push({
      assetUuid: binding.assetUuid,
      relativePath: path.posix.normalize(relativePath),
      mediaType,
    });
    const roleType = String(binding.assetType ?? asset.type ?? "");
    const voiceEnabled = binding.voiceEnabled !== false;
    if (roleType === "role" && voiceEnabled) {
      const audioPath = await runWithProjectStorage(input.projectUuid, () => resolveRoleAudioRelativePath(Number(asset.id)));
      if (audioPath && !seenAudioPaths.has(audioPath)) {
        seenAudioPaths.add(audioPath);
        let audioAbsolute: string;
        try {
          audioAbsolute = resolveProjectFilePath(getPath(), input.projectUuid, context.segment, audioPath);
        } catch {
          throw Object.assign(new Error("分镜参考素材路径越出当前项目"), { status: 400 });
        }
        let audioReadable = false;
        try {
          audioReadable = fs.existsSync(audioAbsolute) && fs.statSync(audioAbsolute).isFile();
        } catch {
          throw Object.assign(new Error("分镜参考素材文件不可读取"), { status: 400 });
        }
        if (audioReadable) {
          resolved.push({
            assetUuid: binding.assetUuid,
            relativePath: path.posix.normalize(audioPath),
            mediaType: "audio",
          });
        }
      }
    }
  }
  return resolved;
}

async function resolveRoleAudioRelativePath(roleAssetId: number): Promise<string | null> {
  if (!Number.isInteger(roleAssetId) || roleAssetId <= 0) return null;
  const { loadBoundRoleAudioInputs, resolveSafeProjectAudioLogicalPath } = await import("./related-audio-dto");
  const grouped = await loadBoundRoleAudioInputs(activeDb, [roleAssetId]);
  const first = grouped[roleAssetId]?.[0];
  return resolveSafeProjectAudioLogicalPath(first?.filePath);
}

function enrichDreaminaReferenceIdentity(
  projectUuid: string,
  references: readonly ProjectMediaReference[],
  identityCache?: Map<string, { md5: string; size: number }>,
): ProjectMediaReference[] {
  return references.map((reference) => {
    const cacheKey = [projectUuid.toLowerCase(), reference.relativePath, reference.mediaType].join("\0");
    let identity = identityCache?.get(cacheKey);
    if (!identity) {
      identity = readDreaminaReferenceContentIdentity(projectUuid, reference);
      // 中文注释：同一批次可重复引用大视频，只缓存内容身份，不缓存或暴露本机绝对路径。
      identityCache?.set(cacheKey, { md5: identity.md5, size: identity.size });
    }
    return {
      ...reference,
      // 中文注释：preview 摘要和持久任务只保存内容身份，不回传本机绝对路径。
      md5: identity.md5,
      size: identity.size,
    };
  });
}

/** scheduler 调用真实 CLI 前复核入队时的内容身份，并只向内部返回安全解析后的绝对路径。 */
export function resolveDreaminaReferenceForExecution(
  projectUuid: string,
  reference: ProjectMediaReference,
): ProjectMediaReference & { absolutePath: string; md5: string; size: number } {
  if (typeof reference.md5 !== "string" || typeof reference.size !== "number") {
    throw Object.assign(new Error("即梦参考素材缺少持久内容身份"), { status: 400 });
  }
  const expectedMd5 = reference.md5.toLowerCase();
  const expectedSize = reference.size;
  if (!/^[a-f0-9]{32}$/.test(expectedMd5)
    || !Number.isSafeInteger(expectedSize)
    || expectedSize < 0) {
    throw Object.assign(new Error("即梦参考素材缺少持久内容身份"), { status: 400 });
  }
  const actual = readDreaminaReferenceContentIdentity(projectUuid, reference);
  if (actual.md5 !== expectedMd5 || actual.size !== expectedSize) {
    throw Object.assign(new Error("即梦参考素材内容已变化"), { status: 400 });
  }
  return { ...reference, md5: expectedMd5, size: expectedSize, absolutePath: actual.absolutePath };
}

function readDreaminaReferenceContentIdentity(
  projectUuid: string,
  reference: ProjectMediaReference,
): { absolutePath: string; md5: string; size: number } {
  const context = currentUserStorage();
  if (!context) throw Object.assign(new Error("缺少账号上下文，无法解析即梦素材"), { status: 403 });
  if (!reference.relativePath
    || !reference.mediaType
    || reference.relativePath.includes("\\")
    || classifyProjectFile(reference.relativePath).mediaType !== reference.mediaType) {
    throw Object.assign(new Error("即梦参考素材合同无效"), { status: 400 });
  }
  try {
    // 中文注释：项目边界、NTFS 文件身份与摘要必须绑定同一个 fd，禁止先 resolve 再普通 open。
    const identity = hashProjectFileIdentity(
      getPath(),
      projectUuid,
      context.segment,
      reference.relativePath,
    );
    return { absolutePath: identity.absolutePath, md5: identity.md5.toLowerCase(), size: identity.size };
  } catch {
    throw Object.assign(new Error("即梦参考素材内容不可读取"), { status: 400 });
  }
}

function enrichVendorReferenceIdentity(
  projectUuid: string,
  references: readonly ProjectMediaReference[],
): ProjectMediaReference[] {
  const context = currentUserStorage();
  if (!context) throw Object.assign(new Error("缺少账号上下文，无法解析供应商素材"), { status: 403 });
  return references.map((reference) => {
    if (!reference.relativePath) {
      throw Object.assign(new Error("普通供应商参考素材路径缺失"), { status: 400 });
    }
    let digest: { md5: string; size: number };
    try {
      digest = hashProjectFileIdentity(
        getPath(),
        projectUuid,
        context.segment,
        reference.relativePath,
      );
    } catch {
      // 中文注释：文件系统异常不得把设备绝对路径回显到 preview 响应。
      throw Object.assign(new Error("普通供应商参考素材不可读取"), { status: 400 });
    }
    return {
      ...reference,
      // 中文注释：普通供应商 preview 摘要绑定文件内容，执行 staging 会再次核对。
      md5: digest.md5,
      size: digest.size,
    };
  });
}

function toVendorMediaReference(
  projectUuid: string,
  reference: ProjectMediaReference,
): ReferenceList {
  if (
    !reference.relativePath
    || (reference.mediaType !== "image" && reference.mediaType !== "video" && reference.mediaType !== "audio")
    || !/^[a-f0-9]{32}$/i.test(String(reference.md5 ?? ""))
    || !Number.isSafeInteger(reference.size)
    || Number(reference.size) < 0
  ) {
    throw Object.assign(new Error("普通供应商参考素材缺少持久内容身份"), { status: 400 });
  }
  return {
    type: reference.mediaType,
    media: {
      projectUuid,
      relativePath: reference.relativePath,
      md5: String(reference.md5).toLowerCase(),
      size: Number(reference.size),
    },
  } as ReferenceList;
}

function mapStoryboardModeToVendorVideoMode(
  mode: string,
  references: readonly ReferenceList[],
): VendorVideoMode[] {
  const onlyImages = references.every((reference) => reference.type === "image");
  if (mode === "text2video" || mode === "text") {
    assertVendorReferenceCount(references.length === 0, "文本视频模式不允许参考素材");
    return ["text"];
  }
  if (mode === "image2video" || mode === "singleImage" || mode === "single") {
    assertVendorReferenceCount(references.length === 1 && onlyImages, "单图视频模式必须恰好包含 1 张图片");
    return ["singleImage"];
  }
  if (mode === "frames2video" || mode === "startEndRequired" || mode === "startEnd") {
    assertVendorReferenceCount(references.length === 2 && onlyImages, "首尾帧模式必须恰好包含 2 张图片");
    return ["startEndRequired"];
  }
  if (mode === "endFrameOptional" || mode === "startFrameOptional" || mode === "optional") {
    assertVendorReferenceCount(
      references.length >= 1 && references.length <= 2 && onlyImages,
      "可选首尾帧模式必须包含 1 至 2 张图片",
    );
    return [mode === "optional" ? "endFrameOptional" : mode];
  }
  if (mode === "multiframe2video" || mode === "multiframe") {
    assertVendorReferenceCount(
      references.length >= 2 && references.length <= 8 && onlyImages,
      "多帧视频模式必须包含 2 至 8 张图片",
    );
    return [buildVendorReferenceDescriptor(references)];
  }
  if (mode === "multimodal2video" || mode === "multimodal") {
    assertVendorReferenceCount(
      references.length >= 1 && references.length <= 8,
      "多模态视频模式必须包含 1 至 8 个支持的参考素材",
    );
    return [buildVendorReferenceDescriptor(references)];
  }
  if (mode.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(mode);
    } catch {
      throw Object.assign(new Error("普通供应商视频模式无效"), { status: 400 });
    }
    if (
      Array.isArray(parsed)
      && parsed.length > 0
      && parsed.every((item) => /^(image|video|audio)Reference:[1-9]\d*$/.test(String(item)))
    ) {
      const descriptor = parsed as (`videoReference:${number}` | `imageReference:${number}` | `audioReference:${number}`)[];
      assertVendorDescriptorMatchesReferences(descriptor, references);
      return [descriptor];
    }
  }
  throw Object.assign(new Error("普通供应商视频模式无效"), { status: 400 });
}

function assertVendorImageReferenceContract(mode: string, referenceCount: number): void {
  const valid = mode === "text2image"
    ? referenceCount === 0
    : mode === "image2image"
      ? referenceCount >= 1 && referenceCount <= 4
      : false;
  if (!valid) {
    throw Object.assign(new Error("普通供应商图片模式与参考素材数量不一致"), { status: 400 });
  }
}

function assertVendorReferenceCount(valid: boolean, message: string): void {
  if (!valid) throw Object.assign(new Error(message), { status: 400 });
}

function buildVendorReferenceDescriptor(
  references: readonly ReferenceList[],
): (`videoReference:${number}` | `imageReference:${number}` | `audioReference:${number}`)[] {
    const counts = new Map<ReferenceList["type"], number>();
    for (const reference of references) {
      counts.set(reference.type, (counts.get(reference.type) ?? 0) + 1);
    }
    const descriptor: (`videoReference:${number}` | `imageReference:${number}` | `audioReference:${number}`)[] = [];
    for (const type of ["image", "video", "audio"] as const) {
      const count = counts.get(type) ?? 0;
      if (count > 0) descriptor.push(`${type}Reference:${count}`);
    }
  return descriptor;
}

function assertVendorDescriptorMatchesReferences(
  descriptor: readonly (`videoReference:${number}` | `imageReference:${number}` | `audioReference:${number}`)[],
  references: readonly ReferenceList[],
): void {
  assertVendorReferenceCount(references.length >= 1 && references.length <= 8, "多参考描述必须对应 1 至 8 个素材");
  const expected = buildVendorReferenceDescriptor(references);
  const normalized = [...descriptor].sort();
  const normalizedExpected = [...expected].sort();
  if (
    normalized.length !== normalizedExpected.length
    || normalized.some((item, index) => item !== normalizedExpected[index])
  ) {
    throw Object.assign(new Error("普通供应商多参考描述与实际素材数量不一致"), { status: 400 });
  }
}

/** 调度前的二次校验；调用方必须先校验完整批次，之后才能写任一队列行。 */
export function assertDreaminaGenerationRequest(input: {
  projectUuid: string;
  mediaType: "image" | "video";
  providerModel: string;
  mode: string;
  request: FinalGenerationRequest;
}, options: {
  verifyReferenceIdentity?: boolean;
  capabilityPolicy?: DreaminaCapabilityPolicy;
} = {}): void {
  if (input.request.providerModel !== input.providerModel) {
    throw Object.assign(new Error("即梦请求模型与队列模型不一致"), { status: 400 });
  }
  const capabilityPolicy = options.capabilityPolicy ?? "execute";
  const resolved = resolveDreaminaGenerationMode({
    mediaType: input.mediaType,
    requestedMode: input.mode,
    references: input.request.references,
    capabilityPolicy,
  });
  assertDreaminaProviderModelForMedia({
    mediaType: input.mediaType,
    providerModel: input.providerModel,
    mode: resolved,
  });
  if (resolved !== input.mode || input.request.options.mode !== input.mode) {
    throw Object.assign(new Error("即梦请求仍含未解析模式，禁止入队"), { status: 400 });
  }
  assertDreaminaDurationContract(input.mediaType, input.request.options.durationMs);
  const capabilityFields = input.request.capabilityFields;
  if (!Array.isArray(capabilityFields) || capabilityFields.some((field) => typeof field !== "string" || !field.startsWith("--"))) {
    throw Object.assign(new Error("即梦请求缺少有效 CLI 能力快照"), { status: 400 });
  }
  const allowedFields = new Set(readDreaminaModeFields(resolved, capabilityPolicy));
  const actualFields = [...new Set(capabilityFields)].sort();
  const expectedFields = [...allowedFields].sort();
  if (actualFields.length !== expectedFields.length
    || actualFields.some((field, index) => field !== expectedFields[index])) {
    throw Object.assign(new Error("即梦请求的 CLI 能力快照与当前模式不一致"), { status: 400 });
  }
  assertDreaminaRequiredCliValues(resolved, input.request);
  if (input.mediaType === "video" && !capabilityFields.includes("--model_version")) {
    throw Object.assign(new Error("当前即梦模式不能精确传递视频模型"), { status: 400 });
  }
  const context = currentUserStorage();
  if (!context) throw Object.assign(new Error("缺少账号上下文，禁止即梦任务入队"), { status: 403 });
  for (const reference of input.request.references) {
    if (!reference.relativePath || !reference.mediaType || reference.relativePath.includes("\\")) {
      throw Object.assign(new Error("即梦参考素材未完成项目内解析"), { status: 400 });
    }
    if (classifyProjectFile(reference.relativePath).mediaType !== reference.mediaType) {
      throw Object.assign(new Error("即梦参考素材类型与文件不一致"), { status: 400 });
    }
    if (typeof reference.md5 !== "string"
      || !/^[a-fA-F0-9]{32}$/.test(reference.md5)
      || typeof reference.size !== "number"
      || !Number.isSafeInteger(reference.size)
      || reference.size < 0) {
      throw Object.assign(new Error("即梦参考素材缺少持久内容身份"), { status: 400 });
    }
    if (options.verifyReferenceIdentity !== false) {
      // 中文注释：重试等持久请求必须重核；刚由本进程流式生成的身份可跳过同链路重复读取。
      resolveDreaminaReferenceForExecution(input.projectUuid, reference);
    }
  }
}

function assertDreaminaRequiredCliValues(
  mode: DreaminaMode,
  request: FinalGenerationRequest,
): void {
  if (!String(request.prompt ?? "").trim()) {
    throw Object.assign(new Error("即梦生成提示词不能为空"), { status: 400 });
  }
  const resolution = String(request.options.resolution ?? "").trim();
  // 中文注释：help 字段是“支持集合”而非“必填集合”；只按各模式真实必需值强制校验。
  if ((mode === "text2image" || mode === "image2image" || mode === "text2video") && !resolution) {
    throw Object.assign(new Error("即梦生成分辨率不能为空"), { status: 400 });
  }
  if ((mode === "text2image" || mode === "text2video")
    && !String(request.options.aspectRatio ?? "").trim()) {
    throw Object.assign(new Error("即梦生成画幅不能为空"), { status: 400 });
  }
}

function stableCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stableCanonicalValue(item));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const current = (value as Record<string, unknown>)[key];
    if (current !== undefined) output[key] = stableCanonicalValue(current);
  }
  return output;
}

/** 产品已发布的即梦模式字段，供非付费预览在尚未探测 CLI 时构造同一份请求。 */
const PUBLISHED_DREAMINA_MODE_FIELDS: Record<DreaminaMode, readonly string[]> = {
  text2image: ["--prompt", "--ratio", "--resolution_type", "--model_version"],
  image2image: ["--prompt", "--images", "--ratio", "--resolution_type"],
  text2video: ["--prompt", "--duration", "--ratio", "--video_resolution", "--model_version"],
  image2video: ["--prompt", "--image", "--duration", "--video_resolution", "--model_version"],
  frames2video: ["--prompt", "--first", "--last", "--duration", "--video_resolution", "--model_version"],
  multiframe2video: ["--prompt", "--images", "--duration", "--video_resolution"],
  multimodal2video: [
    "--prompt",
    "--image",
    "--video",
    "--audio",
    "--duration",
    "--ratio",
    "--video_resolution",
    "--model_version",
  ],
};

export type DreaminaCapabilityPolicy = "preview" | "enqueue" | "execute";

function readDreaminaModeFields(
  mode: DreaminaMode,
  policy: DreaminaCapabilityPolicy = "execute",
): readonly string[] {
  const cached = readDreaminaCapabilityCache();
  const liveReady = cached.state === "ready" && cached.snapshot?.installed === true;
  if (liveReady) {
    const capability = cached.snapshot?.modes[mode];
    return capability?.enabled === true ? [...capability.fields] : [];
  }
  // 中文注释：预览与 SQLite 耐久入队必须生成同一能力快照；后台 execute 再验证实时 CLI 能力。
  if (policy !== "execute") {
    return PUBLISHED_DREAMINA_MODE_FIELDS[mode] ?? [];
  }
  return [];
}

function isDreaminaModeEnabled(
  mode: DreaminaMode,
  requiredFields: readonly string[] = [],
  policy: DreaminaCapabilityPolicy = "execute",
): boolean {
  const fields = readDreaminaModeFields(mode, policy);
  return fields.length > 0 && requiredFields.every((field) => fields.includes(field));
}

/** 即梦 CLI 时长以整数秒计费，禁止 preview 与执行端发生隐式取整漂移。 */
function assertDreaminaDurationContract(mediaType: "image" | "video", rawDurationMs: unknown): void {
  if (mediaType !== "video") return;
  const durationMs = Number(rawDurationMs);
  if (!Number.isInteger(durationMs) || durationMs <= 0 || durationMs % 1_000 !== 0) {
    throw Object.assign(new Error("即梦视频时长必须是整秒"), { status: 400 });
  }
}

function assertReferenceContract(
  mode: DreaminaMode,
  mediaTypes: readonly (ProjectMediaReference["mediaType"])[],
): void {
  const onlyImages = mediaTypes.every((item) => item === "image");
  const hasVisual = mediaTypes.some((item) => item === "image" || item === "video");
  const withinLimit = mode === "image2image"
    ? mediaTypes.length <= 4
    : mode === "multiframe2video" || mode === "multimodal2video"
      ? mediaTypes.length <= 8
      : true;
  const valid = mode === "text2image" || mode === "text2video"
    ? mediaTypes.length === 0
    : mode === "image2image"
      ? mediaTypes.length >= 1 && onlyImages
      : mode === "image2video"
        ? mediaTypes.length === 1 && onlyImages
        : mode === "frames2video"
          ? mediaTypes.length === 2 && onlyImages
          : mode === "multiframe2video"
            ? mediaTypes.length >= 2 && onlyImages
            : mediaTypes.length >= 1 && hasVisual;
  if (!valid || !withinLimit) {
    throw Object.assign(new Error(`参考素材不满足 ${mode} 的 CLI 合同`), { status: 400 });
  }
}

export function assertCandidateInstallWritable(projectUuid: string): void {
  const { syncCoordinator } = require("../runtime/runtime") as typeof import("../runtime/runtime");
  const { currentTeamWriteGuard } = require("../runtime/project-operation-port") as typeof import("../runtime/project-operation-port");
  let item: {
    kind?: string;
    myRole?: string;
    openMode?: string;
    lockStatus?: string;
    lockId?: string;
    lockDeviceUuid?: string;
    fencingToken?: number;
  } | undefined;
  try {
    item = syncCoordinator.listProjects(undefined).find((row) => row.projectUuid === projectUuid);
  } catch {
    item = syncCoordinator.peekProject(projectUuid);
  }
  if (!item) {
    throw Object.assign(new Error("缺少项目运行时或权限上下文，禁止安装候选"), { status: 403 });
  }
  if (item.myRole === "viewer" || item.openMode === "readonly") {
    throw Object.assign(new Error("当前身份不能写入该项目"), { status: 403 });
  }
  if (item.kind !== "team") return;
  const guard = currentTeamWriteGuard();
  if (!guard?.lockId || !guard.deviceUuid) {
    throw Object.assign(new Error("Team 写入缺少设备或锁"), { status: 403 });
  }
  const expectedDevice = item.lockDeviceUuid || getStableDeviceUUID(getPath());
  if (guard.deviceUuid !== expectedDevice) {
    throw Object.assign(new Error("Team 写入设备不匹配"), { status: 403 });
  }
  if (item.lockStatus !== "active" || !item.lockId || guard.lockId !== item.lockId) {
    throw Object.assign(new Error("Team 编辑锁无效"), { status: 403 });
  }
  if (Number(item.fencingToken) !== Number(guard.fencingToken)) {
    throw Object.assign(new Error("Team 栅栏令牌已失效"), { status: 403 });
  }
}



let afterVendorVideoWrittenForTests: ((dest: string) => void) | null = null;

export function setAfterVendorVideoWrittenForTests(hook: ((dest: string) => void) | null): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  afterVendorVideoWrittenForTests = hook;
}

export async function persistVendorGenerationResult(input: {
  projectUuid: string;
  shotUuid: string;
  mediaType: "image" | "video";
  request: FinalGenerationRequest;
  candidateUuid?: string;
  runner: {
    run: (request: FinalGenerationRequest) => Promise<{ save?: (target: string) => Promise<unknown> | unknown }>;
  };
}): Promise<{ relativePath: string; candidateUuid: string }> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { randomUUID } = await import("node:crypto");
  const getPath = (await import("@/utils/getPath")).default;
  const { currentUserStorage } = await import("../runtime/user-storage-context");
  const { projectDirectory } = await import("../data/paths");
  const context = currentUserStorage();
  if (!context) throw Object.assign(new Error("缺少账号上下文，无法保存生成结果"), { status: 403 });
  const handle = await input.runner.run(input.request);
  const folder = input.mediaType === "video" ? "videos" : "images";
  const ext = input.mediaType === "video" ? ".mp4" : ".png";
  const fileName = `${randomUUID()}${ext}`;
  const relativePath = `files/${folder}/storyboard/${input.shotUuid}/${fileName}`;
  const dest = path.join(projectDirectory(getPath(), input.projectUuid, context.segment), ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (typeof handle?.save === "function") {
    // 中文注释：generate 端口只有用户 ALS；save 必须进入项目 ALS 才写入 files/，否则会落到账号 OSS。
    await runWithProjectStorage(input.projectUuid, () => handle.save!(relativePath));
  }
  if (!fs.existsSync(dest) || fs.statSync(dest).size <= 0) {
    throw Object.assign(new Error("供应商返回结果为空，禁止假完成"), { status: 422 });
  }
  if (input.mediaType === "video") {
    try {
      const {
        assertAdoptableMp4Fd,
        assertOpenedFileIdentity,
        hashOpenFile,
        openNoFollowRead,
      } = await import("../media/adoptable-generated-video");
      const fd = openNoFollowRead(dest);
      try {
        const before = fs.fstatSync(fd);
        const digest = hashOpenFile(fd, before.size);
        if (afterVendorVideoWrittenForTests) afterVendorVideoWrittenForTests(dest);
        assertOpenedFileIdentity(fd, dest);
        if (hashOpenFile(fd, before.size) !== digest) {
          throw Object.assign(new Error("生成结果不是可采用的视频"), {
            status: 422,
            code: "DREAMINA_RESULT_VIDEO_INVALID",
          });
        }
        assertAdoptableMp4Fd(fd, before.size);
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ }
      throw error;
    }
  }
  const candidateUuid = await installStoryboardCandidate({
    projectUuid: input.projectUuid,
    shotUuid: input.shotUuid,
    mediaType: input.mediaType,
    relativePath,
    select: true,
    candidateUuid: input.candidateUuid,
  });
  return { relativePath, candidateUuid };
}

export async function installStoryboardCandidate(input: {
  projectUuid: string;
  shotUuid: string;
  mediaType: "image" | "video";
  relativePath: string;
  select: boolean;
  candidateUuid?: string;
}): Promise<string> {
  assertCandidateInstallWritable(input.projectUuid);
  const { db: activeDb } = await import("@/utils/db");
  const { runWithProjectStorage } = await import("../runtime/user-storage-context");
  const { upsertPendingMutationJournalInTrx } = await import("../runtime/legacy-mutation-journal");
  const { randomUUID } = await import("node:crypto");
  return runWithProjectStorage(input.projectUuid, async () => {
    // 中文注释：即梦结果使用 taskUuid 作为候选键，重启重放只能命中原记录，禁止重复候选。
    const candidateUuid = input.candidateUuid ?? randomUUID();
    await activeDb.transaction(async (trx) => {
      const existing = await trx("o_storyboardCandidate").where({ candidateUuid }).first();
      if (existing) {
        if (String(existing.shotUuid) !== input.shotUuid
          || String(existing.mediaType) !== input.mediaType
          || String(existing.relativePath) !== input.relativePath) {
          throw Object.assign(new Error("候选幂等键与既有结果冲突"), { status: 409 });
        }
        if (input.select) {
          await trx("o_storyboardCandidate").where({ shotUuid: input.shotUuid }).update({ selected: 0 });
          await trx("o_storyboardCandidate").where({ candidateUuid }).update({ selected: 1 });
        }
        await upsertPendingMutationJournalInTrx(trx, "storyboardCandidate");
        return;
      }
      if (input.select) {
        await trx("o_storyboardCandidate").where({ shotUuid: input.shotUuid }).update({ selected: 0 });
      }
      await trx("o_storyboardCandidate").insert({
        candidateUuid,
        shotUuid: input.shotUuid,
        mediaType: input.mediaType,
        relativePath: input.relativePath,
        selected: input.select ? 1 : 0,
        createdAt: new Date().toISOString(),
      });
      await upsertPendingMutationJournalInTrx(trx, "storyboardCandidate");
    });
    return candidateUuid;
  });
}
