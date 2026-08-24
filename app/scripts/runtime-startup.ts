import fs from "node:fs";
import path from "node:path";

export type RuntimeStartupCode =
  | "STARTING"
  | "STARTUP_RESOURCE_INVALID"
  | "NATIVE_MODULE_LOAD_FAILED"
  | "SQLITE_DATABASE_INVALID"
  | "LOCAL_PORT_UNAVAILABLE"
  | "LOCAL_SERVICE_START_FAILED";

export type RuntimeStartupState =
  | {
      ok: false;
      state: "starting";
      code: "STARTING";
      message: string;
      logPath: string;
    }
  | {
      ok: true;
      state: "ready";
      url: string;
      port: number;
      logPath: string;
    }
  | {
      ok: false;
      state: "failed";
      code: Exclude<RuntimeStartupCode, "STARTING">;
      message: string;
      logPath: string;
      technicalMessage: string;
    };

export interface ClassifiedStartupError {
  code: Exclude<RuntimeStartupCode, "STARTING">;
  message: string;
  technicalMessage: string;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

const SENSITIVE_BASE_KEY_PATTERN =
  "api[_-]?key|client[_-]?secret|access[_-]?key(?:[_-]?(?:id|secret))?|secret[_-]?access[_-]?key|secret[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|password|passwd|secret|token";
const SENSITIVE_KEY_PATTERN =
  `(?:[a-z0-9]+[_-])*(?:${SENSITIVE_BASE_KEY_PATTERN})`;

/**
 * 启动诊断可能来自第三方依赖，写日志和 stderr 前必须统一清除常见凭据形态。
 */
export function sanitizeDiagnosticText(value: unknown): string {
  let text = errorText(value);
  text = text.replace(
    /(https?:\/\/)[^@\s/]+@/gi,
    "$1[REDACTED]@",
  );
  text = text.replace(
    new RegExp(`([?&](?:${SENSITIVE_KEY_PATTERN})=)[^&#\\s]*`, "gi"),
    "$1[REDACTED]",
  );
  text = text.replace(
    new RegExp(
      `(["']?(?:${SENSITIVE_KEY_PATTERN})["']?\\s*:\\s*["'])([^"']*)(["'])`,
      "gi",
    ),
    "$1[REDACTED]$3",
  );
  text = text.replace(
    /(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi,
    "$1[REDACTED]",
  );
  text = text.replace(
    new RegExp(
      `\\b(${SENSITIVE_KEY_PATTERN})\\b(\\s*[=:]\\s*)([^\\s,;}&]+)`,
      "gi",
    ),
    "$1$2[REDACTED]",
  );
  text = text.replace(
    /\bbearer\s+[A-Za-z0-9._~+/=-]+/gi,
    "Bearer [REDACTED]",
  );
  return text;
}

/**
 * 启动错误必须按真实原因分类，不能把端口、数据库或中央网络问题统称为“缺少 VC++”。
 */
export function classifyStartupError(error: unknown): ClassifiedStartupError {
  const rawTechnicalMessage = errorText(error);
  const technicalMessage = sanitizeDiagnosticText(rawTechnicalMessage);
  if (
    error
    && typeof error === "object"
    && "code" in error
    && error.code === "STARTUP_RESOURCE_INVALID"
  ) {
    return {
      code: "STARTUP_RESOURCE_INVALID",
      message: "客户端安装资源校验失败。请使用官方安装程序执行修复或重新安装。",
      technicalMessage,
    };
  }
  if (
    /NODE_MODULE_VERSION|Module did not self-register|\.node\b|specified module could not be found|找不到指定的模块|specified procedure could not be found|动态链接库/i
      .test(rawTechnicalMessage)
  ) {
    return {
      code: "NATIVE_MODULE_LOAD_FAILED",
      message: "安装包运行组件加载失败。请使用官方安装程序执行修复或重新安装，无需手工下载运行库。",
      technicalMessage,
    };
  }
  if (
    /SQLITE_CORRUPT|SQLITE_NOTADB|database disk image is malformed|file is not a database|数据库磁盘映像格式不正确/i
      .test(rawTechnicalMessage)
  ) {
    return {
      code: "SQLITE_DATABASE_INVALID",
      message: "本地数据库无法安全打开。应用已停止启动以保护数据，请打开诊断日志处理。",
      technicalMessage,
    };
  }
  if (/EADDRINUSE|EACCES|EMFILE|ENOBUFS|address already in use|端口.*占用/i.test(rawTechnicalMessage)) {
    return {
      code: "LOCAL_PORT_UNAVAILABLE",
      message: "本地服务端口无法使用，请关闭重复运行的应用后重新启动。",
      technicalMessage,
    };
  }
  return {
    code: "LOCAL_SERVICE_START_FAILED",
    message: "应用内置本地服务未能启动，请重新启动应用并查看诊断日志。",
    technicalMessage,
  };
}

/**
 * renderer 只能获得用户可操作的脱敏字段，技术堆栈只写本机日志。
 */
export function publicStartupPayload(
  state: RuntimeStartupState,
): Omit<RuntimeStartupState, "technicalMessage"> {
  if (state.state !== "failed") return state;
  const { technicalMessage: _technicalMessage, ...payload } = state;
  return payload;
}

export function writeStartupFailureLog(
  logPath: string,
  state: Extract<RuntimeStartupState, { state: "failed" }>,
  error: unknown,
): void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const stack = sanitizeDiagnosticText(
    error instanceof Error ? error.stack ?? error.message : String(error),
  );
  const record = {
    timestamp: new Date().toISOString(),
    state: state.state,
    code: state.code,
    message: sanitizeDiagnosticText(state.technicalMessage),
    stack,
  };
  // 启动日志只追加本机错误，不记录环境变量、账号或密钥。
  fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
