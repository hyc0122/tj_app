import {
  DREAMINA_IMAGE_MODEL_LABELS,
  DREAMINA_IMAGE_MODELS,
  DREAMINA_IMAGE_MODES,
  DREAMINA_PROVIDER_ID,
  DREAMINA_VIDEO_MODELS,
  DREAMINA_VIDEO_MODES,
  type DreaminaMode,
  type DreaminaVideoModel,
} from "./dreamina-cli/contracts";
import { readDreaminaCapabilityCache } from "./dreamina-cli/capability-cache";

export interface NativeModelCatalogItem {
  id: string;
  label: string;
  value: string;
  type: "image" | "video";
  name: string;
  providerId: typeof DREAMINA_PROVIDER_ID;
  providerKind: "native-local";
  modes: string[];
  aspectRatios: string[];
  resolutions: string[];
  minReferences: number;
  maxReferences: number;
  disabled?: boolean;
  disabledReason?: string;
}

const MODE_LABEL: Record<DreaminaMode, string> = {
  text2image: "即梦 文生图",
  image2image: "即梦 图生图",
  text2video: "即梦 文生视频",
  image2video: "即梦 图生视频",
  frames2video: "即梦 多帧生视频",
  multiframe2video: "即梦 多参考生视频",
  multimodal2video: "即梦 多模态生视频",
};

const VIDEO_MODEL_LABEL: Record<DreaminaVideoModel, string> = {
  "seedance2.0": "Seedance 2.0",
  "seedance2.0fast": "Seedance 2.0 Fast",
  "seedance2.0mini": "Seedance 2.0 Mini",
  "seedance2.0_vip": "Seedance 2.0 VIP",
  "seedance2.0fast_vip": "Seedance 2.0 Fast VIP",
};

const MODE_LIMITS: Record<DreaminaMode, { minReferences: number; maxReferences: number }> = {
  text2image: { minReferences: 0, maxReferences: 0 },
  image2image: { minReferences: 1, maxReferences: 4 },
  text2video: { minReferences: 0, maxReferences: 0 },
  image2video: { minReferences: 1, maxReferences: 1 },
  frames2video: { minReferences: 2, maxReferences: 2 },
  multiframe2video: { minReferences: 2, maxReferences: 8 },
  multimodal2video: { minReferences: 1, maxReferences: 8 },
};

export function listNativeDreaminaModels(
  type: "text" | "image" | "video" | "all",
): NativeModelCatalogItem[] {
  if (type === "video") return listNativeDreaminaVideoModels();
  if (type !== "image" && type !== "all") return [];
  // 中文注释：新建项目只展示可选择的真实 CLI 图片版本，不探测、不启动 dreamina。
  const cached = readDreaminaCapabilityCache();
  const snapshot = cached.snapshot;
  const executableModes = DREAMINA_IMAGE_MODES.filter((mode) => snapshot?.modes[mode]?.enabled !== false);
  const modes = executableModes.length > 0 ? executableModes : [...DREAMINA_IMAGE_MODES];
  return DREAMINA_IMAGE_MODELS.map((model) => ({
    id: DREAMINA_PROVIDER_ID,
    label: DREAMINA_IMAGE_MODEL_LABELS[model],
    value: `${DREAMINA_PROVIDER_ID}:${model}`,
    type: "image",
    name: "即梦 CLI",
    providerId: DREAMINA_PROVIDER_ID,
    providerKind: "native-local",
    modes: [...modes],
    aspectRatios: ["1:1", "16:9", "9:16"],
    resolutions: ["2K", "4K"],
    minReferences: 0,
    maxReferences: MODE_LIMITS.image2image.maxReferences,
  }));
}

function listNativeDreaminaVideoModels(): NativeModelCatalogItem[] {
  // 中文注释：新建项目始终展示五个 Seedance 模型；CLI/登录/能力只在正式生成入口失败关闭。
  const cached = readDreaminaCapabilityCache();
  const snapshot = cached.snapshot;
  const catalogReady = cached.state === "ready" && snapshot?.installed === true;
  const probedModes = catalogReady
    ? DREAMINA_VIDEO_MODES.filter((mode) => {
        const capability = snapshot?.modes[mode];
        return capability?.enabled === true && capability.fields.includes("--model_version");
      })
    : [];
  const executableModes = probedModes.length > 0 ? probedModes : [...DREAMINA_VIDEO_MODES];
  const fields = new Set(executableModes.flatMap((mode) => [...(snapshot?.modes[mode]?.fields ?? [])]));
  const modeLimits = executableModes.map((mode) => MODE_LIMITS[mode]);

  return DREAMINA_VIDEO_MODELS.map((model) => ({
    id: DREAMINA_PROVIDER_ID,
    label: VIDEO_MODEL_LABEL[model],
    value: `${DREAMINA_PROVIDER_ID}:${model}`,
    type: "video",
    name: "即梦 CLI",
    providerId: DREAMINA_PROVIDER_ID,
    providerKind: "native-local",
    modes: [...executableModes],
    aspectRatios: fields.has("--ratio") || !catalogReady ? ["1:1", "16:9", "9:16"] : [],
    resolutions: fields.has("--video_resolution") || !catalogReady ? ["720p", "1080p"] : [],
    minReferences: modeLimits.length > 0 ? Math.min(...modeLimits.map((limit) => limit.minReferences)) : 0,
    maxReferences: modeLimits.length > 0 ? Math.max(...modeLimits.map((limit) => limit.maxReferences)) : 0,
  }));
}

export interface NativeDreaminaVideoDetail {
  type: "video";
  name: string;
  modelName: string;
  audio: boolean;
  mode: Array<string | string[]>;
  durationResolutionMap: Array<{ duration: number[]; resolution: string[] }>;
  minReferences: number;
  maxReferences: number;
  aspectRatios: string[];
  resolutions: string[];
}

function mapDreaminaModeToWorkbench(mode: DreaminaMode, maxReferences: number): string | string[] {
  if (mode === "text2video") return "text";
  if (mode === "image2video") return "singleImage";
  if (mode === "frames2video") return "startEndRequired";
  if (mode === "multiframe2video") return `imageReference:${Math.max(2, maxReferences)}`;
  if (mode === "multimodal2video") {
    return [
      `imageReference:${Math.max(1, maxReferences)}`,
      "videoReference:1",
      "audioReference:1",
    ];
  }
  return "text";
}

/** 工作台 VideoModel 详情：只读当前账号能力缓存，禁止 login/生成。 */
export function buildNativeDreaminaVideoDetail(modelId: string): NativeDreaminaVideoDetail | null {
  const prefix = `${DREAMINA_PROVIDER_ID}:`;
  if (!modelId.startsWith(prefix)) return null;
  const version = modelId.slice(prefix.length) as DreaminaVideoModel;
  if (!DREAMINA_VIDEO_MODELS.includes(version)) return null;
  const catalog = listNativeDreaminaVideoModels();
  const item = catalog.find((row) => row.value === modelId);
  if (!item) return null;
  const cached = readDreaminaCapabilityCache();
  const snapshot = cached.snapshot;
  const audio = snapshot?.modes.multimodal2video?.fields.includes("--audio") === true;
  const durations = [5, 10];
  const resolutions = item.resolutions.length > 0 ? [...item.resolutions] : ["720p", "1080p"];
  return {
    type: "video",
    name: item.label,
    modelName: item.value,
    audio,
    mode: item.modes.map((mode) => mapDreaminaModeToWorkbench(mode as DreaminaMode, item.maxReferences)),
    durationResolutionMap: [{ duration: durations, resolution: resolutions }],
    minReferences: item.minReferences,
    maxReferences: item.maxReferences,
    aspectRatios: [...item.aspectRatios],
    resolutions,
  };
}
