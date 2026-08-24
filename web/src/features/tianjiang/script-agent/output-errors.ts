/**
 * 剧本 Agent 执行层错误码 → i18n key / 安全中文 fallback。
 * 禁止把英文供应商异常直接展示给用户。
 * 禁止把「产物已保存」安全文案重新映射为「工作区未修改」。
 */
import i18n from "@/locales";

export type ScriptAgentClientErrorCode =
  | "SCRIPT_AGENT_OUTPUT_INCOMPLETE"
  | "SCRIPT_AGENT_OUTPUT_TRUNCATED"
  | "SCRIPT_AGENT_OUTPUT_EMPTY_XML"
  | "SCRIPT_AGENT_OUTPUT_INVALID_SCRIPT"
  | "SCRIPT_AGENT_OUTPUT_PARTIAL_COMMIT"
  | "SCRIPT_AGENT_ABORTED";

/** 稳定 i18n key，七语均需存在 */
export const SCRIPT_AGENT_ERROR_I18N_KEYS: Record<ScriptAgentClientErrorCode, string> = {
  SCRIPT_AGENT_OUTPUT_INCOMPLETE: "workbench.scriptAgent.outputError.incomplete",
  SCRIPT_AGENT_OUTPUT_TRUNCATED: "workbench.scriptAgent.outputError.truncated",
  SCRIPT_AGENT_OUTPUT_EMPTY_XML: "workbench.scriptAgent.outputError.emptyXml",
  SCRIPT_AGENT_OUTPUT_INVALID_SCRIPT: "workbench.scriptAgent.outputError.invalidScript",
  SCRIPT_AGENT_OUTPUT_PARTIAL_COMMIT: "workbench.scriptAgent.outputError.partialCommit",
  SCRIPT_AGENT_ABORTED: "workbench.scriptAgent.outputError.aborted",
};

/** 阶段细化文案（incomplete 时） */
export const SCRIPT_AGENT_STAGE_I18N_KEYS: Record<string, string> = {
  storySkeleton: "workbench.scriptAgent.outputError.incompleteStorySkeleton",
  adaptationStrategy: "workbench.scriptAgent.outputError.incompleteAdaptationStrategy",
  script: "workbench.scriptAgent.outputError.incompleteScript",
  supervision: "workbench.scriptAgent.outputError.incompleteSupervision",
};

const FALLBACK_ZH: Record<ScriptAgentClientErrorCode, string> = {
  SCRIPT_AGENT_OUTPUT_INCOMPLETE: "执行层输出不完整，工作区未修改，请重试",
  SCRIPT_AGENT_OUTPUT_TRUNCATED: "模型输出被截断，工作区未修改，请调整模型输出上限后重试",
  SCRIPT_AGENT_OUTPUT_EMPTY_XML: "执行层未生成完整产物，工作区未修改，请重试",
  SCRIPT_AGENT_OUTPUT_INVALID_SCRIPT: "执行层未生成有效剧本条目，工作区未修改，请重试",
  SCRIPT_AGENT_OUTPUT_PARTIAL_COMMIT: "后续阶段未完成，已保存的产物仍保留，请查看工作区后重试",
  SCRIPT_AGENT_ABORTED: "已停止生成",
};

/** 安全中文是否表达「产物已保存 / 部分提交」 */
export function messageIndicatesPartialCommit(message?: string): boolean {
  const msg = message?.trim() ?? "";
  if (!msg) return false;
  if (/工作区未修改/.test(msg)) return false;
  return /已保存|仍保留|产物仍|工作区后重试|后续阶段未完成/.test(msg);
}

export function resolveScriptAgentErrorI18nKey(code: string, stage?: string): string {
  if (code === "SCRIPT_AGENT_OUTPUT_PARTIAL_COMMIT") {
    return SCRIPT_AGENT_ERROR_I18N_KEYS.SCRIPT_AGENT_OUTPUT_PARTIAL_COMMIT;
  }
  if (
    (code === "SCRIPT_AGENT_OUTPUT_INCOMPLETE" || code === "SCRIPT_AGENT_OUTPUT_EMPTY_XML") &&
    stage &&
    stage in SCRIPT_AGENT_STAGE_I18N_KEYS
  ) {
    return SCRIPT_AGENT_STAGE_I18N_KEYS[stage];
  }
  if (code in SCRIPT_AGENT_ERROR_I18N_KEYS) {
    return SCRIPT_AGENT_ERROR_I18N_KEYS[code as ScriptAgentClientErrorCode];
  }
  return SCRIPT_AGENT_ERROR_I18N_KEYS.SCRIPT_AGENT_OUTPUT_INCOMPLETE;
}

function tSafe(key: string, fallback: string): string {
  try {
    const translated = i18n.global.t(key);
    if (typeof translated === "string" && translated && translated !== key) {
      return translated;
    }
  } catch {
    // ignore
  }
  return fallback;
}

/** 将服务端 errorCode / 中文消息规范为可展示文案（经 i18n） */
export function mapScriptAgentOutputError(input: {
  code?: string;
  stage?: string;
  message?: string;
}): string {
  // 1) 明确 PARTIAL_COMMIT
  if (input.code === "SCRIPT_AGENT_OUTPUT_PARTIAL_COMMIT") {
    return tSafe(
      SCRIPT_AGENT_ERROR_I18N_KEYS.SCRIPT_AGENT_OUTPUT_PARTIAL_COMMIT,
      FALLBACK_ZH.SCRIPT_AGENT_OUTPUT_PARTIAL_COMMIT,
    );
  }

  // 2) INCOMPLETE 等码 + 安全「已保存」文案：不得映射回「工作区未修改」
  if (messageIndicatesPartialCommit(input.message)) {
    const msg = input.message!.trim();
    if (/[\u3400-\u9fff]/.test(msg) && !/Error while|stack|at\s+\w+/i.test(msg)) {
      return msg;
    }
    return tSafe(
      SCRIPT_AGENT_ERROR_I18N_KEYS.SCRIPT_AGENT_OUTPUT_PARTIAL_COMMIT,
      FALLBACK_ZH.SCRIPT_AGENT_OUTPUT_PARTIAL_COMMIT,
    );
  }

  if (input.code && input.code in SCRIPT_AGENT_ERROR_I18N_KEYS) {
    const code = input.code as ScriptAgentClientErrorCode;
    const key = resolveScriptAgentErrorI18nKey(code, input.stage);
    return tSafe(key, FALLBACK_ZH[code]);
  }

  const msg = input.message?.trim() ?? "";
  if (msg && /[\u3400-\u9fff]/.test(msg) && !/Error while|stack|at\s+\w+/i.test(msg)) {
    return msg;
  }
  if (/截断|length|max.?token/i.test(msg)) {
    return tSafe(
      SCRIPT_AGENT_ERROR_I18N_KEYS.SCRIPT_AGENT_OUTPUT_TRUNCATED,
      FALLBACK_ZH.SCRIPT_AGENT_OUTPUT_TRUNCATED,
    );
  }
  return tSafe(
    SCRIPT_AGENT_ERROR_I18N_KEYS.SCRIPT_AGENT_OUTPUT_INCOMPLETE,
    FALLBACK_ZH.SCRIPT_AGENT_OUTPUT_INCOMPLETE,
  );
}
