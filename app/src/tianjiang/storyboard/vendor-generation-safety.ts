export type VendorGenerationPhase = "prepare" | "stage" | "execute";
export const VENDOR_MEDIA_STAGING_STEPS = [
  "resolver",
  "upload_session",
  "oss_put",
  "confirm",
  "sign_url",
] as const;
export type VendorMediaStagingStep = typeof VENDOR_MEDIA_STAGING_STEPS[number];

export const VENDOR_PREPARE_FAILURE_CODE = "VENDOR_PREPARE_FAILED";
export const VENDOR_PREPARE_FAILURE_MESSAGE = "当前视频模型配置或请求参数不可用";
export const VENDOR_MEDIA_STAGING_FAILURE_CODE = "VENDOR_MEDIA_STAGING_FAILED";
export const VENDOR_MEDIA_STAGING_FAILURE_MESSAGE = "参考素材暂存失败，请检查网络或稍后重试";
export const VENDOR_GENERATION_FAILURE_CODE = "VENDOR_GENERATION_FAILED";
export const VENDOR_GENERATION_FAILURE_MESSAGE = "普通供应商生成失败，请检查模型配置或稍后重试";
export const VENDOR_REFERENCE_UNSUPPORTED_CODE = "VENDOR_REFERENCE_UNSUPPORTED";
export const VENDOR_REFERENCE_UNSUPPORTED_MESSAGE = "当前视频模型不支持参考素材输入";

/** 供应商合同不支持参考素材：必须在写入 operation 前失败关闭，不能伪装成网络暂存失败。 */
export class VendorReferenceUnsupportedError extends Error {
  readonly status = 400;
  readonly code = VENDOR_REFERENCE_UNSUPPORTED_CODE;

  constructor() {
    super(VENDOR_REFERENCE_UNSUPPORTED_MESSAGE);
    this.name = "VendorReferenceUnsupportedError";
  }
}

/** 普通供应商阶段错误：只允许固定安全码，禁止按 message 猜阶段。 */
export class VendorGenerationPhaseError extends Error {
  readonly status: number;
  readonly code: string;
  readonly phase: VendorGenerationPhase;
  readonly stagingStep?: VendorMediaStagingStep;
  readonly providerMessage?: string;

  constructor(
    phase: VendorGenerationPhase,
    status = 400,
    stagingStep?: VendorMediaStagingStep,
    providerMessage?: string,
  ) {
    const mapped = vendorPhaseFailure(phase);
    super(mapped.message);
    this.name = "VendorGenerationPhaseError";
    this.phase = phase;
    this.status = status;
    this.code = mapped.code;
    if (phase === "stage" && stagingStep && VENDOR_MEDIA_STAGING_STEPS.includes(stagingStep)) {
      this.stagingStep = stagingStep;
    }
    const normalizedProviderMessage = String(providerMessage ?? "").trim();
    if (normalizedProviderMessage) this.providerMessage = normalizedProviderMessage;
  }
}

function vendorPhaseFailure(phase: VendorGenerationPhase): { code: string; message: string } {
  if (phase === "prepare") {
    return { code: VENDOR_PREPARE_FAILURE_CODE, message: VENDOR_PREPARE_FAILURE_MESSAGE };
  }
  if (phase === "stage") {
    return { code: VENDOR_MEDIA_STAGING_FAILURE_CODE, message: VENDOR_MEDIA_STAGING_FAILURE_MESSAGE };
  }
  return { code: VENDOR_GENERATION_FAILURE_CODE, message: VENDOR_GENERATION_FAILURE_MESSAGE };
}

/**
 * 普通供应商模板、暂存、远端和保存异常都可能携带密钥、签名 URL 或本机路径。
 * 对外响应和持久任务原因只允许固定安全文案，原始异常不得跨越该边界。
 */
export function createSafeVendorGenerationError(status = 400): Error & { status: number; code: string } {
  return createSafeVendorPhaseError("execute", status);
}

export function createSafeVendorPhaseError(
  phase: VendorGenerationPhase,
  status = 400,
  stagingStep?: VendorMediaStagingStep,
  providerMessage?: string,
): VendorGenerationPhaseError {
  return new VendorGenerationPhaseError(phase, status, stagingStep, providerMessage);
}

export function createSafeVendorStagingError(
  step: VendorMediaStagingStep,
  status = 400,
  providerMessage?: string,
): VendorGenerationPhaseError {
  return new VendorGenerationPhaseError("stage", status, step, providerMessage);
}

export function readSafeVendorStagingStep(error: unknown): VendorMediaStagingStep | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as { stagingStep?: unknown; code?: unknown };
  if (
    typeof record.stagingStep === "string"
    && (VENDOR_MEDIA_STAGING_STEPS as readonly string[]).includes(record.stagingStep)
  ) {
    return record.stagingStep as VendorMediaStagingStep;
  }
  if (record.code === "VENDOR_STAGING_UPLOAD_SESSION") return "upload_session";
  if (record.code === "VENDOR_STAGING_OSS_PUT") return "oss_put";
  if (record.code === "VENDOR_STAGING_CONFIRM") return "confirm";
  if (record.code === "VENDOR_STAGING_SIGN_URL") return "sign_url";
  return undefined;
}

export function rethrowVendorPhaseOr(phase: VendorGenerationPhase, error: unknown): never {
  if (error instanceof VendorReferenceUnsupportedError) throw error;
  if (error instanceof VendorGenerationPhaseError) throw error;
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (code === VENDOR_REFERENCE_UNSUPPORTED_CODE || code === "STORYBOARD_REFERENCE_IDENTITY_MISMATCH") {
    throw error;
  }
  const providerMessage = readVendorFailureMessage(error);
  if (phase === "stage") {
    throw createSafeVendorStagingError(readSafeVendorStagingStep(error) ?? "resolver", 400, providerMessage);
  }
  throw createSafeVendorPhaseError(phase, 400, undefined, providerMessage);
}

export function safeVendorGenerationErrorSummary(): string {
  return VENDOR_GENERATION_FAILURE_MESSAGE;
}

/** 后台任务保留供应商正常返回的错误文本；非供应商异常仍使用稳定兜底文案。 */
export function safeVendorGenerationFailure(error: unknown): { code: string; message: string } {
  if (error instanceof VendorGenerationPhaseError) {
    return { code: error.code, message: error.providerMessage ?? error.message };
  }
  return {
    code: VENDOR_GENERATION_FAILURE_CODE,
    message: VENDOR_GENERATION_FAILURE_MESSAGE,
  };
}

/** 只读取供应商抛出的文本本身，不把 Error 堆栈附加到任务中心。 */
function readVendorFailureMessage(error: unknown): string | undefined {
  if (error instanceof Error) {
    const message = error.message.trim();
    return message || undefined;
  }
  if (typeof error === "string") {
    const message = error.trim();
    return message || undefined;
  }
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    const message = String((error as { message: string }).message).trim();
    return message || undefined;
  }
  return undefined;
}

/** 内部诊断只允许非敏感枚举，禁止密钥、URL、提示词、路径、SQL 和堆栈。 */
export function safeVendorPhaseDiagnostic(input: {
  phase: VendorGenerationPhase;
  providerModel?: string;
  mediaType?: "image" | "video";
}): { phase: VendorGenerationPhase; providerModel?: string; mediaType?: "image" | "video" } {
  const providerModel = String(input.providerModel ?? "").trim();
  return {
    phase: input.phase,
    ...(providerModel && !/sk-|api[_-]?key|https?:|[A-Za-z]:\\/i.test(providerModel)
      ? { providerModel } : {}),
    ...(input.mediaType ? { mediaType: input.mediaType } : {}),
  };
}
