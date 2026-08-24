export interface PendingOperationReservation {
  fingerprint: string;
  clientOperationId: string;
}

/**
 * 递归规范化请求意图，确保对象字段顺序不同但内容相同时仍得到同一指纹。
 * 中文注释：指纹只留在当前页面内存，不写日志、不持久化提示词或素材信息。
 */
function canonicalizeRequestIntent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeRequestIntent);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalizeRequestIntent(child)]),
    );
  }
  return value;
}

export function fingerprintWorkbenchRequestIntent(intent: unknown): string {
  return JSON.stringify(canonicalizeRequestIntent(intent));
}

/**
 * 为当前 composable 实例维护待确认请求身份。
 * 失败不清除；成功只清除仍指向本次 UUID 的记录，防止旧并发响应误删新请求。
 */
export function createPendingOperationIdentity() {
  const pendingIds = new Map<string, string>();

  function reserve(intent: unknown): PendingOperationReservation {
    const fingerprint = fingerprintWorkbenchRequestIntent(intent);
    const existing = pendingIds.get(fingerprint);
    if (existing) return { fingerprint, clientOperationId: existing };
    const clientOperationId = crypto.randomUUID();
    pendingIds.set(fingerprint, clientOperationId);
    return { fingerprint, clientOperationId };
  }

  function complete(reservation: PendingOperationReservation): void {
    if (pendingIds.get(reservation.fingerprint) === reservation.clientOperationId) {
      pendingIds.delete(reservation.fingerprint);
    }
  }

  return { reserve, complete };
}

const SAFE_WORKBENCH_VIDEO_ERRORS = new Map<string, string>([
  ["DREAMINA_CLI_DISABLED", "即梦 CLI 已关闭"],
  ["DREAMINA_CLI_NOT_INSTALLED", "未安装即梦 CLI 或无法执行"],
  ["DREAMINA_CLI_NOT_LOGGED_IN", "未登录即梦账号"],
  ["STORYBOARD_DREAMINA_CLI_UNAVAILABLE", "即梦 CLI 不可用"],
  ["STORYBOARD_DREAMINA_MODE_UNSUPPORTED", "当前即梦 CLI 不支持当前模式"],
  ["DREAMINA_CLI_MODEL_UNSUPPORTED", "当前即梦模型不支持"],
  ["DREAMINA_BATCH_PERSIST_FAILED", "生成任务入队失败，请重试"],
  ["DREAMINA_EMPTY_BATCH", "没有可提交的生成任务"],
  ["DREAMINA_PAID_BATCH_CONFIRMATION_REQUIRED", "批量付费任务需要确认后才能写入"],
  ["DREAMINA_CLIENT_OPERATION_ID_INVALID", "生成操作 ID 无效"],
  ["DREAMINA_CLIENT_OPERATION_CONFLICT", "同一生成操作 ID 对应的请求意图已变化"],
  ["DREAMINA_ENQUEUE_RECOVERING", "生成操作已受理，正在恢复本机队列"],
  ["WORKBENCH_TRACK_REQUIRED", "请先选择轨道"],
  ["WORKBENCH_MODEL_REQUIRED", "请先选择模型"],
  ["WORKBENCH_PROMPT_REQUIRED", "即梦生成提示词不能为空"],
  ["WORKBENCH_PROJECT_NOT_FOUND", "项目不存在或不可见"],
  ["WORKBENCH_QUEUE_PAUSED", "即梦队列已暂停"],
  ["WORKBENCH_REFERENCE_INVALID", "参考素材与当前模式不兼容"],
  ["WORKBENCH_REFERENCE_UNSAFE", "参考素材不在当前项目内"],
  ["WORKBENCH_VIDEO_HISTORY_MISSING", "工作台历史记录缺失"],
]);

function readWorkbenchVideoErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const record = error as Record<string, unknown>;
  if (typeof record.code === "string") return record.code;
  const response = record.response;
  if (response && typeof response === "object") {
    const responseData = (response as Record<string, unknown>).data;
    if (responseData && typeof responseData === "object") {
      const responseCode = (responseData as Record<string, unknown>).code;
      if (typeof responseCode === "string") return responseCode;
    }
  }
  return "";
}

/**
 * 只按本地白名单业务码输出固定中文，永不采用服务端自由文本。
 * 中文注释：未知错误统一降级，因此路径、SQL、堆栈与凭据无需靠易遗漏的黑名单猜测。
 */
export function safeWorkbenchVideoError(error: unknown, fallback: string): string {
  return SAFE_WORKBENCH_VIDEO_ERRORS.get(readWorkbenchVideoErrorCode(error)) ?? fallback;
}
