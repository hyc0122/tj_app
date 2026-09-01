const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/i;

type TapCanvasTaskKind =
  | "text_to_image"
  | "image_edit"
  | "image_remove_bg"
  | "image_to_video"
  | "text_to_video"
  | "video_edit"
  | "video_enhance";

export type TapCanvasTaskStatus = "queued" | "running" | "succeeded" | "failed";

export interface ParsedTapCanvasTaskRequest {
  taskKind: TapCanvasTaskKind;
  mediaType: "image" | "video";
  projectUuid: string;
  nodeUuid: string;
  modelKey: string;
  confirmation: null | {
    confirmationUuid: string;
    requestDigest: string;
    baseRevision: number;
    clientRequestId: string;
  };
}

/** 中文注释：兼容层输入错误必须显式失败，绝不伪造“已执行”回执。 */
export class TapCanvasTaskContractError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 422, code = "TAPCANVAS_TASK_REQUEST_INVALID") {
    super(message);
    this.name = "TapCanvasTaskContractError";
    this.status = status;
    this.code = code;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredUuid(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!UUID_PATTERN.test(text)) throw new TapCanvasTaskContractError(`${label}不合法`);
  return text;
}

function mapTaskKind(value: unknown): { taskKind: TapCanvasTaskKind; mediaType: "image" | "video" } {
  const kind = String(value ?? "").trim() as TapCanvasTaskKind;
  if (kind === "text_to_image" || kind === "image_edit" || kind === "image_remove_bg") {
    return { taskKind: kind, mediaType: "image" };
  }
  if (kind === "image_to_video" || kind === "text_to_video" || kind === "video_edit" || kind === "video_enhance") {
    return { taskKind: kind, mediaType: "video" };
  }
  throw new TapCanvasTaskContractError("当前画布任务类型尚未接入天将模型路由", 422, "TAPCANVAS_TASK_KIND_UNSUPPORTED");
}

export function parseTapCanvasTaskRequest(value: unknown): ParsedTapCanvasTaskRequest {
  const body = asRecord(value);
  const request = asRecord(body.request);
  const extras = asRecord(request.extras);
  const context = asRecord(extras.generationContext);
  const mapped = mapTaskKind(request.kind);
  const projectUuid = requiredUuid(context.projectId, "画布项目 ID");
  const nodeUuid = requiredUuid(context.nodeId ?? extras.nodeId, "画布节点 ID");
  const modelKey = String(extras.modelKey ?? "").trim();
  if (!modelKey.includes(":")) {
    throw new TapCanvasTaskContractError("生成节点必须选择天将当前账号中的真实模型");
  }

  const confirmationValues = [
    body.confirmationUuid,
    body.requestDigest,
    body.baseRevision,
    body.clientRequestId,
  ];
  const hasConfirmation = confirmationValues.some((item) => item !== undefined && item !== null && item !== "");
  let confirmation: ParsedTapCanvasTaskRequest["confirmation"] = null;
  if (hasConfirmation) {
    if (confirmationValues.some((item) => item === undefined || item === null || item === "")) {
      throw new TapCanvasTaskContractError("确认合同不完整或已损坏");
    }
    const confirmationUuid = requiredUuid(body.confirmationUuid, "确认单 ID");
    const requestDigest = String(body.requestDigest ?? "").trim();
    const baseRevision = Number(body.baseRevision);
    const clientRequestId = requiredUuid(body.clientRequestId, "确认请求 ID");
    if (!DIGEST_PATTERN.test(requestDigest) || !Number.isInteger(baseRevision) || baseRevision < 0) {
      throw new TapCanvasTaskContractError("确认合同不完整或已损坏");
    }
    confirmation = { confirmationUuid, requestDigest, baseRevision, clientRequestId };
  }

  return {
    ...mapped,
    projectUuid,
    nodeUuid,
    modelKey,
    confirmation,
  };
}

export function encodeTapCanvasTaskId(projectUuid: string, runUuid: string): string {
  return `tc1:${requiredUuid(projectUuid, "画布项目 ID")}:${requiredUuid(runUuid, "画布运行 ID")}`;
}

export function decodeTapCanvasTaskId(taskId: string): { projectUuid: string; runUuid: string } {
  const match = /^tc1:([^:]+):([^:]+)$/.exec(String(taskId ?? "").trim());
  if (!match) throw new TapCanvasTaskContractError("任务标识不合法", 400);
  return {
    projectUuid: requiredUuid(match[1], "画布项目 ID"),
    runUuid: requiredUuid(match[2], "画布运行 ID"),
  };
}

export function mapCanvasRunState(state: string): TapCanvasTaskStatus {
  if (state === "succeeded" || state === "completed") return "succeeded";
  if (state === "failed" || state === "canceled" || state === "cancelled") return "failed";
  if (state === "running" || state === "submitting" || state === "submitted" || state === "leased") return "running";
  return "queued";
}
