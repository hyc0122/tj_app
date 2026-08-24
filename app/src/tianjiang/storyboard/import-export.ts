import crypto from "node:crypto";
import ExcelJS from "exceljs";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

export type ImportFormat = "txt" | "csv" | "xlsx";

export interface ImportedStoryboardShot {
  sourceRow: number;
  sourceText: string;
  visualDescription: string;
  imagePrompt: string;
  videoPrompt: string;
  negativePrompt: string;
  durationMs: number | null;
  assetNames: Readonly<Record<"role" | "scene" | "tool" | "clip" | "audio", readonly string[]>>;
}

export interface StoryboardImportPlan {
  mode: "append" | "insertAfter";
  afterShotUuid: string | null;
  rows: readonly ImportedStoryboardShot[];
}

export interface ImportPreviewError {
  sourceRow: number;
  code: string;
  message: string;
}

export interface ImportPreviewResult {
  rows: ImportedStoryboardShot[];
  errors: ImportPreviewError[];
  digest: string;
}

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const CSV_HEADERS = [
  "脚本",
  "画面描述",
  "图片提示词",
  "视频提示词",
  "负向提示词",
  "时长毫秒",
  "角色",
  "场景",
  "道具",
  "素材",
  "音频",
] as const;

export const STORYBOARD_IMPORT_R10_MARKER = "R10_STORYBOARD_IMPORT_VOICE";

export type TxtDelimiterMode = "auto" | "custom";

/** 用户可多选的自动分镜规则；禁止接收自定义正则。 */
export const TXT_AUTO_RULES = ["section", "hash", "shot"] as const;
export type TxtAutoRule = (typeof TXT_AUTO_RULES)[number];

export interface TxtDelimiterConfig {
  mode: TxtDelimiterMode;
  delimiter?: string;
  autoRules?: readonly TxtAutoRule[];
}

export const STORYBOARD_IMPORT_TXT_EXAMPLE = `小节1：
场景：黑屏字卡。
人物：无
镜号1：【黑屏】画面完全漆黑。

小节2：
场景：靠山屯某村民家日。
人物：村民
道具：烂红薯干
镜号1：【室内广角缓推】昏暗土炕上，几个村民瑟缩成一团。
`;

export const STORYBOARD_IMPORT_CSV_EXAMPLE = `场景,人物,道具,分镜提示词
山路悬崖,"沈云禾,陆怀川,工作人员","白布担架,断裂竹篮","承接：无 -> 当前分镜救援队从山里抬出白布担架
场景：山路悬崖
人物：沈云禾、陆怀川、工作人员
▲俯拍，缓慢下压，全景。"
`;

export function normalizeTxtDelimiterConfig(raw: unknown): TxtDelimiterConfig {
  if (!raw || typeof raw !== "object") return { mode: "auto", autoRules: [...TXT_AUTO_RULES] };
  const record = raw as { mode?: unknown; delimiter?: unknown; autoRules?: unknown };
  const delimiter = String(record.delimiter ?? "").trim();
  if (record.mode === "custom" && delimiter) {
    return { mode: "custom", delimiter };
  }
  // 中文注释：旧请求未带 autoRules 时默认启用全部可选规则，保持向后兼容。
  return { mode: "auto", autoRules: normalizeAutoRules(record.autoRules) };
}

function normalizeAutoRules(raw: unknown): TxtAutoRule[] {
  if (!Array.isArray(raw)) return [...TXT_AUTO_RULES];
  const allowed = new Set<string>(TXT_AUTO_RULES);
  const seen = new Set<TxtAutoRule>();
  const rules: TxtAutoRule[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !allowed.has(item) || seen.has(item as TxtAutoRule)) continue;
    seen.add(item as TxtAutoRule);
    rules.push(item as TxtAutoRule);
  }
  return rules;
}

export function decodeImportPayload(contentBase64: string): Buffer {
  const buffer = Buffer.from(String(contentBase64 ?? ""), "base64");
  if (buffer.length > MAX_IMPORT_BYTES) {
    const error = Object.assign(new Error("导入文件超过 2MB 限制"), { status: 413, code: "STORYBOARD_IMPORT_TOO_LARGE" });
    throw error;
  }
  return buffer;
}

export function previewDigest(
  format: string,
  buffer: Buffer,
  txtDelimiter?: TxtDelimiterConfig,
): string {
  const token = format === "txt"
    ? digestTxtToken(normalizeTxtDelimiterConfig(txtDelimiter))
    : "n/a";
  return crypto.createHash("sha256").update(`${format}\n${token}\n`).update(buffer).digest("hex");
}

function digestTxtToken(config: TxtDelimiterConfig): string {
  if (config.mode === "custom" && config.delimiter) {
    return `custom:${config.delimiter}`;
  }
  // 中文注释：自动规则必须进入摘要；缺省与显式全选归一化为同一 token。
  const rules = [...(config.autoRules ?? TXT_AUTO_RULES)].slice().sort();
  return `auto:${rules.join(",")}`;
}

export async function parseImportBuffer(
  format: ImportFormat,
  buffer: Buffer,
  txtDelimiter?: TxtDelimiterConfig,
): Promise<{ rows: ImportedStoryboardShot[]; errors: ImportPreviewError[] }> {
  if (format === "txt") return parseTxt(buffer, normalizeTxtDelimiterConfig(txtDelimiter));
  if (format === "csv") return parseCsv(buffer);
  if (format === "xlsx") return parseXlsx(buffer);
  throw Object.assign(new Error("不支持的导入格式"), {
    status: 400,
    code: "STORYBOARD_IMPORT_UNSUPPORTED_FORMAT",
  });
}

export async function buildImportPreview(
  format: ImportFormat,
  contentBase64: string,
  txtDelimiter?: TxtDelimiterConfig,
): Promise<ImportPreviewResult> {
  const buffer = decodeImportPayload(contentBase64);
  const parsed = await parseImportBuffer(format, buffer, txtDelimiter);
  return {
    ...parsed,
    digest: previewDigest(format, buffer, txtDelimiter),
  };
}

export function assertPreviewDigest(
  format: ImportFormat,
  contentBase64: string,
  expected: string,
  txtDelimiter?: TxtDelimiterConfig,
): Buffer {
  const buffer = decodeImportPayload(contentBase64);
  const digest = previewDigest(format, buffer, txtDelimiter);
  if (digest !== expected) {
    throw Object.assign(new Error("导入内容已变化，请重新预览"), {
      status: 409,
      code: "STORYBOARD_IMPORT_CONTENT_CHANGED",
    });
  }
  return buffer;
}

export function escapeFormulaCell(value: string): string {
  if (/^[=+\-@]/.test(value)) return `'${value}`;
  return value;
}

export function shotsToCsv(rows: Array<{
  shotUuid: string;
  displayOrder: number;
  sourceText: string | null;
  visualDescription: string | null;
  imagePrompt?: string | null;
  videoPrompt?: string | null;
  negativePrompt?: string | null;
  durationMs?: number | null;
}>): string {
  return stringify([
    ["shotUuid", "序号", ...CSV_HEADERS],
    ...rows.map((row) => [
      row.shotUuid,
      String(row.displayOrder),
      escapeFormulaCell(row.sourceText ?? ""),
      escapeFormulaCell(row.visualDescription ?? ""),
      escapeFormulaCell(row.imagePrompt ?? ""),
      escapeFormulaCell(row.videoPrompt ?? ""),
      escapeFormulaCell(row.negativePrompt ?? ""),
      row.durationMs == null ? "" : String(row.durationMs),
      "",
      "",
      "",
      "",
      "",
    ]),
  ]);
}

function emptyAssets() {
  return { role: [], scene: [], tool: [], clip: [], audio: [] } as const;
}

function isVideoSegmentHeader(trimmed: string): boolean {
  // 中文注释：视频段兼容始终启用，不进入用户可关闭的 autoRules。
  return /^(?:視頻段|视频段)\s*\d+\s*[：:]?\s*$/.test(trimmed)
    || /^(?:視頻段|视频段)\s*[：:]\s*\d+/.test(trimmed);
}

function isNumberedLabelHeader(trimmed: string, label: string): boolean {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}\\s*\\d+\\s*[：:]?\\s*$`).test(trimmed)
    || new RegExp(`^${escaped}\\s*[：:]\\s*\\d+`).test(trimmed);
}

function isAutoShotHeader(line: string, rules: readonly TxtAutoRule[]): boolean {
  const trimmed = line.trim().replace(/^\uFEFF/, "");
  if (!trimmed) return false;
  if (isVideoSegmentHeader(trimmed)) return true;
  if (rules.includes("hash") && /^#\s*\d+\s*$/.test(trimmed)) return true;
  if (rules.includes("section") && isNumberedLabelHeader(trimmed, "小节")) return true;
  if (rules.includes("shot") && isNumberedLabelHeader(trimmed, "分镜")) return true;
  return false;
}

function isShotHeader(line: string, config: TxtDelimiterConfig): boolean {
  if (config.mode === "custom" && config.delimiter) {
    // 中文注释：自定义模式只做整行精确相等，禁止把分隔符当正则。
    return line.trim() === config.delimiter;
  }
  return isAutoShotHeader(line, config.autoRules ?? TXT_AUTO_RULES);
}

function parseTxt(
  buffer: Buffer,
  config: TxtDelimiterConfig,
): { rows: ImportedStoryboardShot[]; errors: ImportPreviewError[] } {
  const text = buffer.toString("utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text.split("\n");
  const headerIndexes: number[] = [];
  lines.forEach((line, index) => {
    if (isShotHeader(line, config)) headerIndexes.push(index);
  });
  const rows: ImportedStoryboardShot[] = [];
  const errors: ImportPreviewError[] = [];
  if (headerIndexes.length === 0) {
    const trimmed = text.trim();
    if (trimmed) rows.push(shotFromSegment(trimmed, 1, ""));
    return { rows, errors };
  }
  for (const [index, start] of headerIndexes.entries()) {
    const end = index + 1 < headerIndexes.length ? headerIndexes[index + 1]! : lines.length;
    const chunk = lines.slice(start, end);
    const header = chunk[0] ?? "";
    const raw = chunk.join("\n");
    const duration = parseDurationFromHeader(header);
    if (duration.error) {
      errors.push({ sourceRow: start + 1, code: "INVALID_DURATION", message: duration.error });
    }
    rows.push(shotFromSegment(raw, start + 1, header, duration.ms));
  }
  return { rows, errors };
}

function shotFromSegment(
  raw: string,
  sourceRow: number,
  header: string,
  durationMs: number | null = null,
): ImportedStoryboardShot {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const bodyLines = header ? lines.slice(1) : lines;
  const sourceText = raw.replace(/\s+$/g, "");
  const videoPrompt = bodyLines.join("\n").replace(/^\n+/, "").replace(/\s+$/g, "");
  return {
    sourceRow,
    sourceText: sourceText || header,
    visualDescription: "",
    imagePrompt: "",
    videoPrompt,
    negativePrompt: "",
    durationMs,
    assetNames: extractAssetNames(bodyLines),
  };
}

function extractAssetNames(lines: readonly string[]): ImportedStoryboardShot["assetNames"] {
  const names = { role: [] as string[], scene: [] as string[], tool: [] as string[], clip: [] as string[], audio: [] as string[] };
  for (const line of lines) {
    const match = line.match(/^\s*(场景|人物|道具)\s*[：:]\s*(.*)$/);
    if (!match) continue;
    const [, field, value] = match;
    const bucket = field === "人物" ? "role" : field === "场景" ? "scene" : "tool";
    names[bucket].push(...splitNames(value));
  }
  return names;
}

function parseDurationFromHeader(header: string): { ms: number | null; error?: string } {
  const match = header.match(/估时\s*(\d+)\s*秒/);
  if (!match) return { ms: null };
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return { ms: null, error: "非法时长" };
  return { ms: seconds * 1000 };
}

function parseCsv(buffer: Buffer): { rows: ImportedStoryboardShot[]; errors: ImportPreviewError[] } {
  const records = parse(buffer.toString("utf8").replace(/^\uFEFF/, ""), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as Array<Record<string, string>>;
  const rows: ImportedStoryboardShot[] = [];
  const errors: ImportPreviewError[] = [];
  records.forEach((record, index) => {
    const sourceRow = index + 2;
    const durationRaw = record["时长毫秒"] ?? record["durationMs"] ?? "";
    let durationMs: number | null = null;
    if (durationRaw) {
      const parsed = Number(durationRaw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        errors.push({ sourceRow, code: "INVALID_DURATION", message: "非法时长" });
      } else {
        durationMs = parsed;
      }
    }
    const officialPrompt = record["分镜提示词"] ?? "";
    const videoPrompt = officialPrompt || record["视频提示词"] || "";
    rows.push({
      sourceRow,
      sourceText: record["脚本"] ?? record["sourceText"] ?? (officialPrompt || videoPrompt),
      visualDescription: record["画面描述"] ?? "",
      imagePrompt: record["图片提示词"] ?? "",
      videoPrompt,
      negativePrompt: record["负向提示词"] ?? "",
      durationMs,
      assetNames: {
        role: splitNames(record["人物"] || record["角色"]),
        scene: splitNames(record["场景"]),
        tool: splitNames(record["道具"]),
        clip: splitNames(record["素材"]),
        audio: splitNames(record["音频"]),
      },
    });
  });
  return { rows, errors };
}

async function parseXlsx(buffer: Buffer): Promise<{ rows: ImportedStoryboardShot[]; errors: ImportPreviewError[] }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return { rows: [], errors: [] };
  const header: string[] = [];
  const rows: ImportedStoryboardShot[] = [];
  const errors: ImportPreviewError[] = [];
  sheet.eachRow((row, rowNumber) => {
    const values = (row.values as unknown[]).slice(1).map((value) => String(value ?? "").trim());
    if (rowNumber === 1) {
      header.push(...values);
      return;
    }
    const record: Record<string, string> = {};
    header.forEach((key, index) => {
      record[key] = values[index] ?? "";
    });
    const durationRaw = record["时长毫秒"] ?? "";
    let durationMs: number | null = null;
    if (durationRaw) {
      const parsed = Number(durationRaw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        errors.push({ sourceRow: rowNumber, code: "INVALID_DURATION", message: "非法时长" });
      } else durationMs = parsed;
    }
    rows.push({
      sourceRow: rowNumber,
      sourceText: record["脚本"] ?? "",
      visualDescription: record["画面描述"] ?? "",
      imagePrompt: record["图片提示词"] ?? "",
      videoPrompt: record["视频提示词"] ?? "",
      negativePrompt: record["负向提示词"] ?? "",
      durationMs,
      assetNames: emptyAssets(),
    });
  });
  return { rows, errors };
}

function splitNames(value: string | undefined): readonly string[] {
  return String(value ?? "")
    .split(/[、,，;；]/)
    .map((item) => item.trim())
    .filter((item) => item && item !== "无");
}
