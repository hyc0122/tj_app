export type ParsedVideoMode = string | string[] | null;

export interface ReferenceMedia {
  id: number | null;
  sources: string;
  src?: string;
}

export interface ReferencePreview {
  type: "image" | "video" | "audio";
  src: string;
}

const FRAME_MODES = new Set(["startEndRequired", "endFrameOptional", "startFrameOptional"]);
const SCALAR_VIDEO_MODES = new Set(["singleImage", "startEndRequired", "endFrameOptional", "startFrameOptional", "text"]);
const REFERENCE_MODE_TYPES = new Set(["videoReference", "imageReference", "audioReference", "textReference"]);

export interface ParsedVideoModelDetail {
  name: string;
  modelName: string;
  type: "video";
  audio: true | false | "optional";
  mode: Array<string | string[]>;
  durationResolutionMap: Array<{ duration: number[]; resolution: string[] }>;
}

function unwrapModelPayload(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (record.data && typeof record.data === "object" && !Array.isArray(record.data)) {
    return record.data as Record<string, unknown>;
  }
  return record;
}

function isValidReferenceToken(value: string): boolean {
  if (REFERENCE_MODE_TYPES.has(value)) return true;
  const match = /^(imageReference|videoReference|audioReference|textReference):(\d+)$/.exec(value);
  if (!match) return false;
  const digits = match[2];
  if (digits.startsWith("0")) return false;
  const count = Number(digits);
  return Number.isInteger(count) && count > 0 && String(count) === digits;
}

function isValidVideoMode(value: unknown): value is string | string[] {
  if (typeof value === "string") return SCALAR_VIDEO_MODES.has(value) || isValidReferenceToken(value);
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === "string" && isValidReferenceToken(item));
}

function isValidDurationMap(value: unknown): value is Array<{ duration: number[]; resolution: string[] }> {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((item) => (
    item
    && typeof item === "object"
    && Array.isArray((item as { duration?: unknown }).duration)
    && (item as { duration: unknown[] }).duration.length > 0
    && (item as { duration: unknown[] }).duration.every((entry) => (
      typeof entry === "number" && Number.isFinite(entry) && entry > 0
    ))
    && Array.isArray((item as { resolution?: unknown }).resolution)
    && (item as { resolution: unknown[] }).resolution.length > 0
    && (item as { resolution: unknown[] }).resolution.every((entry) => typeof entry === "string" && entry.trim() !== "")
  ));
}

export function parseVideoModelDetail(raw: unknown): { ok: true; detail: ParsedVideoModelDetail } | { ok: false; reason: string } {
  const payload = unwrapModelPayload(raw);
  if (!payload) return { ok: false, reason: "视频模型详情无效" };
  const mediaType = String(payload.type ?? payload.mediaType ?? "");
  if (mediaType !== "video") return { ok: false, reason: "不是视频模型详情" };
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  const modelName = typeof payload.modelName === "string"
    ? payload.modelName.trim()
    : (typeof payload.id === "string" ? payload.id.trim() : "");
  if (!name && !modelName) return { ok: false, reason: "视频模型名称无效" };
  if (!Array.isArray(payload.mode) || payload.mode.length === 0 || !payload.mode.every(isValidVideoMode)) {
    return { ok: false, reason: "视频模型模式无效" };
  }
  // 中文注释：audio 必须是明确布尔或 optional；缺失不得默认启用。
  if (payload.audio !== true && payload.audio !== false && payload.audio !== "optional") {
    return { ok: false, reason: "视频模型音频参数无效" };
  }
  if (!isValidDurationMap(payload.durationResolutionMap)) {
    return { ok: false, reason: "视频模型分辨率映射无效" };
  }
  return {
    ok: true,
    detail: {
      name: name || modelName,
      modelName: modelName || name,
      type: "video",
      audio: payload.audio,
      mode: payload.mode as Array<string | string[]>,
      durationResolutionMap: payload.durationResolutionMap,
    },
  };
}

const MODE_LABELS: Record<string, string> = {
  singleImage: "单图",
  startEndRequired: "首尾帧",
  endFrameOptional: "尾帧可选",
  startFrameOptional: "首帧可选",
  text: "文本生视频",
  videoReference: "视频",
  imageReference: "图片",
  audioReference: "音频",
  textReference: "文本",
};

export function parseVideoMode(value: string): ParsedVideoMode {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
  } catch {
    return value;
  }
  return value;
}

export function clampTrackDuration(trackDuration: number, supportedDurations: number[] | undefined): number {
  if (!Array.isArray(supportedDurations) || supportedDurations.length === 0) {
    return trackDuration;
  }
  return Math.max(Math.min(...supportedDurations), Math.min(trackDuration, Math.max(...supportedDurations)));
}

function referencePriority(item: ReferenceMedia): number {
  if (item.src) return item.sources === "assets" ? 0 : 1;
  return 2;
}

export function sortReferenceMedia<T extends ReferenceMedia>(items: T[]): T[] {
  // 现代 JS 排序稳定，因此同优先级素材继续保持用户原来的选择顺序。
  return [...items].sort((left, right) => referencePriority(left) - referencePriority(right));
}

function parseReferenceLabel(mode: string): string {
  const match = mode.match(/^(videoReference|imageReference|audioReference|textReference):(\d+)$/);
  if (!match) return MODE_LABELS[mode] || mode;
  return `${MODE_LABELS[match[1]] || match[1]} ×${match[2]}`;
}

export function formatVideoModeOptions(modes: Array<string | string[]> | undefined): Array<{ value: string; label: string }> {
  if (!modes) return [];
  return modes.map((mode) =>
    Array.isArray(mode)
      ? {
          value: JSON.stringify(mode),
          label: `${mode.map(parseReferenceLabel).join(" + ")}参考`,
        }
      : {
          value: mode,
          label: MODE_LABELS[mode] || mode,
        },
  );
}

function limitMediaByMode<T>(items: T[], mode: string): T[] {
  if (FRAME_MODES.has(mode)) return items.slice(0, 2);
  if (mode === "singleImage") return items.slice(0, 1);
  return items;
}

export function selectPromptMedia(items: ReferenceMedia[], mode: string): Array<{ id: number | null; sources: string }> {
  if (mode === "text") {
    return items.map(({ id, sources }) => ({ id, sources }));
  }
  return limitMediaByMode(items, mode)
    .filter((item): item is ReferenceMedia & { id: number } => typeof item.id === "number" && !Number.isNaN(item.id))
    .map(({ id, sources }) => ({ id, sources }));
}

export function selectVideoMedia(items: ReferenceMedia[], mode: string): Array<{ id: number; sources: string }> {
  if (mode === "text") return [];
  return limitMediaByMode(items, mode)
    .filter(
      (item): item is ReferenceMedia & { id: number } =>
        Boolean(item.src) && typeof item.id === "number" && !Number.isNaN(item.id),
    )
    .map(({ id, sources }) => ({ id, sources }));
}

function mediaTypeFromSource(src: string): ReferencePreview["type"] {
  const cleanSource = src.split("?")[0].split("#")[0];
  const extension = cleanSource.split(".").pop()?.toLowerCase() ?? "";
  if (["mp4", "webm", "mov", "avi", "mkv"].includes(extension)) return "video";
  if (["mp3", "wav", "ogg", "aac", "flac", "m4a"].includes(extension)) return "audio";
  return "image";
}

export function buildReferencePreviews(items: ReferenceMedia[]): ReferencePreview[] {
  return items
    .filter((item): item is ReferenceMedia & { src: string } => Boolean(item.src))
    .map((item) => ({
      type: mediaTypeFromSource(item.src),
      src: item.src,
    }));
}
