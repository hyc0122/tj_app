/**
 * 小说导入契约：双层项目编号。
 * - toNovelProjectId：最终层，只接受 number 正安全整数，禁止字符串自动转数字。
 * - normalizeNovelProjectIdInput：UI/store 入口，可把纯数字串规范为 number，再交给 toNovelProjectId。
 * 数字解析与全局 toLocalProjectId 对齐（无 trim、拒空白串）；错误只投影一条安全中文。
 * 不得为通过 AST 门禁而放宽本契约。
 */
import { toLocalProjectId } from "@/features/tianjiang/project/local-project-id";

const DEFAULT_IMPORT_ERROR = "导入小说失败，请检查项目后重试";
const INVALID_PROJECT_ID = "项目编号无效，请返回项目目录重新打开";

/** 只接受 number 正安全整数，禁止字符串自动转数字。 */
export function toNovelProjectId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(INVALID_PROJECT_ID);
  }
  return value;
}

/**
 * 将 store/open 返回的 id（可能为纯数字字符串）规范为可发送的正安全整数。
 * 先按全局本地 ID 契约解析（与 toLocalProjectId 一致：拒 " 42 "），
 * 最终输出再交给 toNovelProjectId，保持最终层只接受 number。
 */
export function normalizeNovelProjectIdInput(value: unknown): number {
  try {
    const asNumber = toLocalProjectId(value);
    return toNovelProjectId(asNumber);
  } catch {
    throw new Error(INVALID_PROJECT_ID);
  }
}

/** 解析完成后默认全选：返回章节 index 列表。 */
export function allChapterRowKeys(rows: ReadonlyArray<{ index: number }>): number[] {
  return rows.map((row) => row.index);
}

export interface NovelListPage {
  rows: unknown[];
  total: number;
}

/**
 * 兼容 success({ data, total }) 与 axios 拦截后的多层 data 包装，禁止 list/total 混用。
 * 返回归一化的 { rows, total }；无法识别时 rows 为空、total 为 0。
 */
export function parseNovelListResponse(payload: unknown): NovelListPage {
  if (payload == null) return { rows: [], total: 0 };

  // axios 拦截器已返回 response.data，常见形态：
  // 1) { code, data: { data: Row[], total }, message }
  // 2) { data: Row[], total }
  // 3) Row[]（极少见）
  const root = payload as Record<string, unknown>;
  let body: unknown = root;
  if (root && typeof root === "object" && "data" in root && root.data != null) {
    body = root.data;
  }

  if (Array.isArray(body)) {
    return { rows: body, total: body.length };
  }

  if (body && typeof body === "object") {
    const page = body as Record<string, unknown>;
    const rowsCandidate = page.data ?? page.list ?? page.rows;
    const rows = Array.isArray(rowsCandidate) ? rowsCandidate : [];
    const totalRaw = page.total ?? page.count ?? rows.length;
    const total = typeof totalRaw === "number"
      ? totalRaw
      : typeof totalRaw === "string" && totalRaw.trim() !== "" && Number.isFinite(Number(totalRaw))
        ? Number(totalRaw)
        : rows.length;
    return {
      rows,
      total: Number.isFinite(total) && total >= 0 ? Math.trunc(total) : rows.length,
    };
  }

  return { rows: [], total: 0 };
}

/** 导入后列表是否真实可见：total>0 或当前页有行。 */
export function novelListHasVisibleRows(page: NovelListPage): boolean {
  return page.total > 0 || page.rows.length > 0;
}

function errorMessageCandidates(error: unknown): unknown[] {
  if (typeof error === "string") return [error];
  if (error instanceof Error) return [error.message];
  if (!error || typeof error !== "object") return [];
  const row = error as Record<string, any>;
  return [
    row.message,
    row.msg,
    row.detail,
    row.data?.message,
    row.data?.msg,
    row.response?.data?.message,
    row.response?.data?.msg,
  ];
}

function safeChineseMessage(value: unknown): string {
  if (typeof value !== "string") return "";
  const message = value.replace(/\s+/g, " ").trim();
  if (!message || message === "[object Object]") return "";
  // 禁止路径、URL、凭据与调用栈片段进入用户提示。
  if (
    /(?:[a-z]:[\\/]|\\\\|(?:^|[\s("'])\.{1,2}[\\/]|(?:^|[\s("'])\/(?:users|home|var|tmp|etc|opt|srv|app)\b|https?:\/\/|bearer\b|authorization\b|api[_ -]?key|access[_ -]?key|secret\b|token\b|stack\b|\bat\s+[\w$.]+\s*\()/i
      .test(message)
  ) {
    return "";
  }
  if (!/[\u3400-\u9fff]/u.test(message)) return "";
  return message.slice(0, 160);
}

/** 将任意失败归一化为一条可展示的中文提示。 */
export function novelImportErrorMessage(error: unknown): string {
  for (const candidate of errorMessageCandidates(error)) {
    const safe = safeChineseMessage(candidate);
    if (safe) return safe;
  }
  return DEFAULT_IMPORT_ERROR;
}
