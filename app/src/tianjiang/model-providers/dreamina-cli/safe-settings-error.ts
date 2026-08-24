/**
 * 即梦设置接口错误脱敏。
 * 中文注释：未知异常只能返回稳定码与固定中文，禁止回显 SQL、路径、堆栈、Cookie 或令牌。
 */
import { DREAMINA_ERROR } from "./contracts";

export const DREAMINA_CLI_SET_ENABLED_FAILED = "DREAMINA_CLI_SET_ENABLED_FAILED";
export const DREAMINA_CLI_SET_ENABLED_FAILED_MESSAGE = "即梦 CLI 状态更新失败，请稍后重试";
export const DREAMINA_CLI_SETTINGS_SAVE_FAILED_MESSAGE = "保存即梦设置失败，请稍后重试";
export const DREAMINA_CLI_GET_STATUS_FAILED = "DREAMINA_CLI_GET_STATUS_FAILED";
export const DREAMINA_CLI_GET_STATUS_FAILED_MESSAGE = "读取即梦状态失败，请稍后重试";
export const DREAMINA_CLI_GET_SETTINGS_FAILED = "DREAMINA_CLI_GET_SETTINGS_FAILED";
export const DREAMINA_CLI_GET_SETTINGS_FAILED_MESSAGE = "读取即梦设置失败，请稍后重试";
export const DREAMINA_QUEUE_PAUSE_FAILED = "DREAMINA_QUEUE_PAUSE_FAILED";
export const DREAMINA_QUEUE_PAUSE_FAILED_MESSAGE = "即梦队列暂停失败，请稍后重试";
export const DREAMINA_QUEUE_RESUME_FAILED = "DREAMINA_QUEUE_RESUME_FAILED";
export const DREAMINA_QUEUE_RESUME_FAILED_MESSAGE = "即梦队列恢复失败，请稍后重试";

const KNOWN_MESSAGES: Record<string, string> = {
  DREAMINA_CLI_INVALID_CONCURRENCY: "即梦并发上限必须是 1 到 8 的整数",
  DREAMINA_CLI_DISABLED: "即梦 CLI 已关闭",
  DREAMINA_CLI_ENABLEMENT_STALE: "即梦 CLI 启停状态已变化",
  DREAMINA_CLI_ENABLED_ROUTE_REQUIRED: "请使用即梦 CLI 启停接口",
  [DREAMINA_CLI_SET_ENABLED_FAILED]: DREAMINA_CLI_SET_ENABLED_FAILED_MESSAGE,
  [DREAMINA_CLI_GET_STATUS_FAILED]: DREAMINA_CLI_GET_STATUS_FAILED_MESSAGE,
  [DREAMINA_CLI_GET_SETTINGS_FAILED]: DREAMINA_CLI_GET_SETTINGS_FAILED_MESSAGE,
  [DREAMINA_QUEUE_PAUSE_FAILED]: DREAMINA_QUEUE_PAUSE_FAILED_MESSAGE,
  [DREAMINA_QUEUE_RESUME_FAILED]: DREAMINA_QUEUE_RESUME_FAILED_MESSAGE,
};

function looksUnsafe(text: string): boolean {
  return /[A-Za-z]:\\/.test(text)
    || text.includes("SELECT ")
    || text.toLowerCase().includes("cookie")
    || text.includes("sk-")
    || /at\s+\S+\.(ts|js)/i.test(text)
    || text.includes("SQLITE");
}

export function toSafeDreaminaSettingsError(
  err: unknown,
  fallbackCode = DREAMINA_CLI_SET_ENABLED_FAILED,
  fallbackMessage = DREAMINA_CLI_SET_ENABLED_FAILED_MESSAGE,
): { status: number; code: string; message: string } {
  const rawCode = err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string"
    ? String((err as { code: string }).code)
    : "";
  const rawStatus = err && typeof err === "object" && typeof (err as { status?: unknown }).status === "number"
    ? Number((err as { status: number }).status)
    : 400;
  if (rawCode && KNOWN_MESSAGES[rawCode]) {
    return { status: rawStatus || 400, code: rawCode, message: KNOWN_MESSAGES[rawCode] };
  }
  const rawMessage = err instanceof Error ? err.message : "";
  if (rawMessage && Object.values(KNOWN_MESSAGES).includes(rawMessage) && !looksUnsafe(rawMessage)) {
    return {
      status: rawStatus || 400,
      code: rawCode || DREAMINA_ERROR.invalidConcurrency,
      message: rawMessage,
    };
  }
  return {
    status: rawStatus >= 400 && rawStatus < 600 ? rawStatus : 400,
    code: fallbackCode,
    message: fallbackMessage,
  };
}
