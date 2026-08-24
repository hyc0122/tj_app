/**
 * 本地项目 / 资源数字 ID 边界（叶子纯函数，无 Pinia/axios）。
 * Project.id 持久化为字符串；仅本地 App 业务路由的 projectId 在请求边界转为 JSON number。
 * 禁止 Axios 拦截器全局转换；禁止第二套项目 ID 转换逻辑。
 */

export class LocalProjectIdError extends Error {
  readonly code = "LOCAL_PROJECT_ID_INVALID";
  constructor(message = "本地项目标识无效") {
    super(message);
    this.name = "LocalProjectIdError";
  }
}

/**
 * 解析正安全整数：仅 number 正安全整数，或**纯**十进制数字字符串（无首尾空白）。
 * 拒绝：" 101 "、"01"、"1e2"、0、小数、对象、NaN、超安全整数。
 */
function parsePositiveSafeInteger(raw: unknown): number | undefined {
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw) || raw <= 0) return undefined;
    return raw;
  }
  if (typeof raw === "string") {
    // 中文注释：声称只接受纯数字串时，不得 trim 后放行 " 101 "
    if (!/^[1-9]\d*$/.test(raw)) return undefined;
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n <= 0) return undefined;
    return n;
  }
  return undefined;
}

/**
 * 将本地项目主键规范为正安全整数 number。
 * 允许：正安全整数 number、纯数字字符串（如 "101"）。
 */
export function toLocalProjectId(raw: unknown): number {
  const n = parsePositiveSafeInteger(raw);
  if (n === undefined) throw new LocalProjectIdError();
  return n;
}

/**
 * 剧本/分镜/资产等本地资源主键：与项目 ID 同一数字契约，错误文案区分字段语义。
 * 不是第二套「项目 ID」转换器。
 */
export function toPositiveSafeInteger(raw: unknown): number {
  const n = parsePositiveSafeInteger(raw);
  if (n === undefined) throw new LocalProjectIdError("资源标识无效");
  return n;
}

/** 尝试转换项目 ID；失败返回 undefined，不抛错。 */
export function tryLocalProjectId(raw: unknown): number | undefined {
  return parsePositiveSafeInteger(raw);
}

/** extraBody 禁止声明 projectId，避免类型层覆盖 */
type ExtraWithoutProjectId<T> = T & { projectId?: never };

/**
 * 构造本地 App 业务请求体：强制 projectId 为 number，并合并额外字段。
 * 运行时最后写入规范化 projectId，as any 注入的 projectId 也不能覆盖。
 * 仅由明确的本地项目路由调用；禁止挂到 Axios interceptor。
 */
export function localProjectBody<T extends Record<string, unknown>>(
  rawProjectId: unknown,
  extraBody?: ExtraWithoutProjectId<T>,
): { projectId: number } & Omit<T, "projectId"> {
  const projectId = toLocalProjectId(rawProjectId);
  const extra = { ...(extraBody ?? ({} as T)) } as Record<string, unknown>;
  // 中文注释：即使 extra 含 projectId（as any），规范化 number 必须最后写入
  delete extra.projectId;
  return {
    ...extra,
    projectId,
  } as { projectId: number } & Omit<T, "projectId">;
}
