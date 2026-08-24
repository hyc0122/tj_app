/**
 * 分镜/塑角造景共用的资产导入与批量文件规范化。
 * 只做解析和校验，不写库、不碰磁盘路径。
 */
import { parse } from "csv-parse/sync";

export const ASSET_TYPES = new Set(["role", "scene", "tool"]);
export const MAX_ASSET_NAME = 80;
export const MAX_ASSET_DESCRIBE = 2000;
export const MAX_ASSET_REMARK = 200;
export const MAX_ASSET_PROMPT = 2000;
export const MAX_ASSET_MEDIA_BYTES = 8 * 1024 * 1024;
export const MAX_BATCH_FILES = 30;
export const MAX_IMPORT_BYTES = 256 * 1024;
export const MAX_IMPORT_RECORDS = 200;

export const IMAGE_RATIOS = new Set(["16:9", "9:16"]);
export const UNSUPPORTED_IMPORT_FIELDS = ["character_kind", "video_prompt"] as const;

export function normalizeImageRatio(value: unknown, fallback = "16:9"): string {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  if (!IMAGE_RATIOS.has(raw)) throw safeAssetError("图片尺寸只允许 16:9 或 9:16");
  return raw;
}

export function displayImageRatio(value: unknown): string {
  const raw = String(value ?? "").trim();
  return IMAGE_RATIOS.has(raw) ? raw : "16:9";
}

const TYPE_ALIASES: Record<string, "role" | "scene" | "tool"> = {
  character: "role",
  role: "role",
  角色: "role",
  scene: "scene",
  场景: "scene",
  prop: "tool",
  tool: "tool",
  道具: "tool",
};

export interface SafeAssetError extends Error {
  status: number;
}

export function safeAssetError(message: string, status = 400): SafeAssetError {
  return Object.assign(new Error(message), { status });
}

export function normalizeAssetType(value: unknown): "role" | "scene" | "tool" | null {
  const key = String(value ?? "").trim().toLowerCase();
  return TYPE_ALIASES[key] ?? TYPE_ALIASES[String(value ?? "").trim()] ?? null;
}

export function normalizeRemark(value: unknown): string {
  const parts = Array.isArray(value)
    ? value.map((item) => String(item ?? "").trim())
    : String(value ?? "").split(/[,，、\n\r]+/).map((item) => item.trim());
  return parts.filter(Boolean).join(",");
}

export function safeFileStem(filename: string): string {
  const base = String(filename ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  if (!base || base.includes(":") || base.includes("..")) {
    throw safeAssetError("文件名不合法");
  }
  const stem = base.replace(/\.[^.]+$/, "").trim();
  if (!stem) throw safeAssetError("文件名不合法");
  if (stem.length > MAX_ASSET_NAME) throw safeAssetError("资产名称必填且长度须合理");
  return stem;
}

export function detectAllowedImage(buffer: Buffer, declaredMime: string): { extension: string; mime: string } | null {
  const mime = declaredMime.trim().toLowerCase();
  const png = buffer.length >= 8
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47;
  const jpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const webp = buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  // 中文注释：扩展名不可信，必须文件头与允许 MIME 同时命中。
  if (png && mime === "image/png") return { extension: "png", mime };
  if (jpeg && (mime === "image/jpeg" || mime === "image/jpg")) return { extension: "jpg", mime: "image/jpeg" };
  if (webp && mime === "image/webp") return { extension: "webp", mime };
  return null;
}

export function detectAllowedAudio(buffer: Buffer, declaredMime: string, filename = ""): { extension: string; mime: string } | null {
  const mime = declaredMime.trim().toLowerCase();
  const ext = String(filename).replace(/\\/g, "/").split("/").pop()?.split(".").pop()?.toLowerCase() ?? "";
  const wav = buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WAVE";
  const ogg = buffer.length >= 4 && buffer.subarray(0, 4).toString("ascii") === "OggS";
  const mp3 = (buffer.length >= 3 && buffer.subarray(0, 3).toString("ascii") === "ID3")
    || (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1]! & 0xe0) === 0xe0);
  const aac = buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] === 0xf1 || buffer[1] === 0xf9);
  const m4a = buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp";
  if (wav && ["audio/wav", "audio/wave", "audio/x-wav"].includes(mime) && (!ext || ext === "wav")) {
    return { extension: "wav", mime: "audio/wav" };
  }
  if (mp3 && ["audio/mpeg", "audio/mp3"].includes(mime) && (!ext || ext === "mp3")) {
    return { extension: "mp3", mime: "audio/mpeg" };
  }
  if (m4a && ["audio/mp4", "audio/m4a", "audio/x-m4a"].includes(mime) && (!ext || ext === "m4a")) {
    return { extension: "m4a", mime: "audio/mp4" };
  }
  if (aac && mime === "audio/aac" && (!ext || ext === "aac")) {
    return { extension: "aac", mime: "audio/aac" };
  }
  if (ogg && mime === "audio/ogg" && (!ext || ext === "ogg")) {
    return { extension: "ogg", mime: "audio/ogg" };
  }
  return null;
}

export interface ParsedImportRecord {
  index: number;
  type: "role" | "scene" | "tool";
  name: string;
  remark: string;
  describe: string;
  prompt: string;
  imageRatio: string;
}

export interface ImportParseResult {
  records: ParsedImportRecord[];
  skipped: number;
}

const SUPPORTED_IMPORT_KEYS = new Set([
  "type",
  "name",
  "aliases",
  "description",
  "describe",
  "prompt",
  "image_params",
  "image_ratio",
]);

function collectUnsupportedFields(row: Record<string, unknown>): string[] {
  return UNSUPPORTED_IMPORT_FIELDS.filter((field) => (
    Object.prototype.hasOwnProperty.call(row, field)
    || Object.keys(row).some((key) => key.trim().toLowerCase() === field)
  ));
}

function validateImportRow(row: Record<string, unknown>, index: number): ParsedImportRecord | "skip" {
  const unsupported = collectUnsupportedFields(row);
  if (unsupported.length > 0) {
    throw safeAssetError(`第 ${index} 条记录包含不支持字段：${unsupported.join("、")}`);
  }
  const keys = Object.keys(row);
  for (const key of keys) {
    if (!SUPPORTED_IMPORT_KEYS.has(key.trim().toLowerCase()) && !SUPPORTED_IMPORT_KEYS.has(key)) {
      // 中文注释：未知列不得猜测含义；本轮仅对明确未扩列字段 fail-closed。
      continue;
    }
  }
  const rawType = row.type;
  const rawName = row.name;
  if ((rawType == null || String(rawType).trim() === "") && (rawName == null || String(rawName).trim() === "")) {
    return "skip";
  }
  const type = normalizeAssetType(rawType);
  const name = String(rawName ?? "").trim();
  if (!type) throw safeAssetError(`第 ${index} 条记录类型无效`);
  if (!name) throw safeAssetError(`第 ${index} 条记录缺少名称`);
  if (name.length > MAX_ASSET_NAME) throw safeAssetError(`第 ${index} 条记录名称过长`);
  const describe = String(row.description ?? row.describe ?? "").trim();
  const prompt = String(row.prompt ?? row.image_params ?? "").trim();
  const remark = normalizeRemark(row.aliases);
  if (describe.length > MAX_ASSET_DESCRIBE) throw safeAssetError(`第 ${index} 条记录描述过长`);
  if (prompt.length > MAX_ASSET_PROMPT) throw safeAssetError(`第 ${index} 条记录提示词过长`);
  if (remark.length > MAX_ASSET_REMARK) throw safeAssetError(`第 ${index} 条记录别名过长`);
  const imageRatio = normalizeImageRatio(row.image_ratio ?? row.imageRatio);
  return { index, type, name, remark, describe, prompt, imageRatio };
}

export function parseAssetImportText(format: string, text: string): ImportParseResult {
  const raw = String(text ?? "");
  if (Buffer.byteLength(raw, "utf8") > MAX_IMPORT_BYTES) {
    throw safeAssetError("导入内容超过上限");
  }
  const kind = String(format ?? "").trim().toLowerCase();
  if (kind !== "json" && kind !== "csv") {
    throw safeAssetError("导入格式只支持 JSON 或 CSV");
  }
  const rows = kind === "json" ? parseJsonRows(raw) : parseCsvRows(raw);
  if (rows.length > MAX_IMPORT_RECORDS) {
    throw safeAssetError(`导入记录超过 ${MAX_IMPORT_RECORDS} 条上限`);
  }
  const records: ParsedImportRecord[] = [];
  let skipped = 0;
  rows.forEach((row, offset) => {
    const parsed = validateImportRow(row, offset + 1);
    if (parsed === "skip") {
      skipped += 1;
      return;
    }
    records.push(parsed);
  });
  return { records, skipped };
}

function parseJsonRows(text: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw safeAssetError("JSON 格式无效");
  }
  if (Array.isArray(parsed)) return parsed.map(asObjectRow);
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { assets?: unknown }).assets)) {
    return (parsed as { assets: unknown[] }).assets.map(asObjectRow);
  }
  throw safeAssetError("JSON 必须是对象数组");
}

function asObjectRow(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw safeAssetError("JSON 记录必须是对象");
  }
  return value as Record<string, unknown>;
}

function parseCsvRows(text: string): Record<string, unknown>[] {
  try {
    return parse(text, {
      columns: (header: string[]) => header.map((item) => String(item ?? "").trim().toLowerCase()),
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      bom: true,
    }) as Record<string, unknown>[];
  } catch {
    throw safeAssetError("CSV 格式无效");
  }
}
