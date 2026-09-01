/**
 * 账号生成偏好：写入 o_setting，字段白名单，模型必须存在、已启用、类型匹配。
 */
import u from "@/utils";

export type GenerationPrefs = {
  imageModel?: string;
  imageSize?: string;
  videoModel?: string;
  videoResolution?: string;
  videoAspect?: string;
};

const SETTING_KEY = "tapcanvas.generationPreferences.v1";
const IMAGE_SIZES = new Set(["1K", "2K", "4K", "512", "768", "1024", "1536", "2048"]);
const VIDEO_RESOLUTIONS = new Set(["480p", "720p", "1080p"]);
const VIDEO_ASPECTS = new Set(["16:9", "9:16", "1:1", "4:3", "3:4"]);

export class GenerationPrefsError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "GenerationPrefsError";
    this.code = code;
    this.status = status;
  }
}

export async function readGenerationPrefs(): Promise<GenerationPrefs | null> {
  const row = await u.accountDb("o_setting").where({ key: SETTING_KEY }).first();
  if (!row || typeof row.value !== "string" || !row.value.trim()) return null;
  try {
    const parsed = JSON.parse(row.value) as GenerationPrefs;
    return sanitizePrefs(parsed, { validateModels: false });
  } catch {
    return null;
  }
}

export async function writeGenerationPrefs(
  input: unknown,
  catalog: Array<{ requestModelKey: string; kind: string; enabled: boolean }>,
): Promise<GenerationPrefs> {
  const prefs = sanitizePrefs(input, { validateModels: true, catalog });
  const serialized = JSON.stringify(prefs);
  const exists = await u.accountDb("o_setting").where({ key: SETTING_KEY }).first();
  if (exists) await u.accountDb("o_setting").where({ key: SETTING_KEY }).update({ value: serialized });
  else await u.accountDb("o_setting").insert({ key: SETTING_KEY, value: serialized });
  return prefs;
}

function sanitizePrefs(
  input: unknown,
  options: {
    validateModels: boolean;
    catalog?: Array<{ requestModelKey: string; kind: string; enabled: boolean }>;
  },
): GenerationPrefs {
  if (!input || typeof input !== "object") return {};
  const raw = input as Record<string, unknown>;
  const output: GenerationPrefs = {};
  if (options.validateModels && "imageModel" in raw && (typeof raw.imageModel !== "string" || !raw.imageModel.trim())) {
    throw new GenerationPrefsError("generation_prefs_invalid_value", "imageModel 必须是非空字符串");
  }
  if (options.validateModels && "videoModel" in raw && (typeof raw.videoModel !== "string" || !raw.videoModel.trim())) {
    throw new GenerationPrefsError("generation_prefs_invalid_value", "videoModel 必须是非空字符串");
  }
  if (typeof raw.imageModel === "string" && raw.imageModel.trim()) {
    output.imageModel = raw.imageModel.trim();
  }
  if (typeof raw.videoModel === "string" && raw.videoModel.trim()) {
    output.videoModel = raw.videoModel.trim();
  }
  const copyEnum = <K extends "imageSize" | "videoResolution" | "videoAspect">(
    key: K,
    allowed: Set<string>,
  ): void => {
    if (!(key in raw)) return;
    const value = typeof raw[key] === "string" ? raw[key].trim() : "";
    if (!allowed.has(value)) {
      if (options.validateModels) {
        throw new GenerationPrefsError("generation_prefs_invalid_value", `${key} 取值无效`);
      }
      return;
    }
    output[key] = value;
  };
  copyEnum("imageSize", IMAGE_SIZES);
  copyEnum("videoResolution", VIDEO_RESOLUTIONS);
  copyEnum("videoAspect", VIDEO_ASPECTS);
  const forbidden = Object.keys(raw).filter((key) => !(key in {
    imageModel: 1, imageSize: 1, videoModel: 1, videoResolution: 1, videoAspect: 1,
  }));
  if (forbidden.length > 0) {
    throw new GenerationPrefsError("generation_prefs_unknown_field", `不支持的生成偏好字段：${forbidden.join(",")}`);
  }
  if (options.validateModels) {
    assertModel(output.imageModel, "image", options.catalog ?? []);
    assertModel(output.videoModel, "video", options.catalog ?? []);
  }
  return output;
}

function assertModel(
  modelKey: string | undefined,
  kind: "image" | "video",
  catalog: Array<{ requestModelKey: string; kind: string; enabled: boolean }>,
): void {
  if (!modelKey) return;
  const hit = catalog.find((item) => item.requestModelKey === modelKey);
  if (!hit || !hit.enabled) {
    throw new GenerationPrefsError("generation_prefs_model_unavailable", "所选模型不存在、未启用或不可执行");
  }
  if (hit.kind !== kind) {
    throw new GenerationPrefsError("generation_prefs_model_kind", `模型类型必须是 ${kind}`);
  }
}
