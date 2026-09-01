/**
 * 唯一、带版本号的生成任务完成合同。
 * 所有视频/图片/资产/分镜生产路由必须在供应商调用前用本构造器生成并写入 o_tasks.relatedObjects。
 * 禁止手工拼装 relatedObjects。
 */
export const GENERATION_COMPLETION_CONTRACT_VERSION = 1 as const;

export type GenerationCompletionKind =
  | "video"
  | "image"
  | "workflow-image"
  | "asset-image"
  | "storyboard-image"
  | "vendor-storyboard"
  | "dreamina"
  | "canvas-generation";

export type GenerationCompletionMediaType = "image" | "video" | "audio";

export interface GenerationCompletionContractV1 {
  version: typeof GENERATION_COMPLETION_CONTRACT_VERSION;
  kind: GenerationCompletionKind;
  mediaType: GenerationCompletionMediaType;
  relativePath: string;
  videoId?: number;
  imageId?: number;
  storyboardId?: number;
  assetsId?: number;
  taskUuid?: string;
  shotUuid?: string;
  projectId?: number;
  scriptId?: number;
  canvasRunUuid?: string;
  canvasNodeUuid?: string;
}

export type GenerationCompletionContract = GenerationCompletionContractV1;

const KINDS = new Set<GenerationCompletionKind>([
  "video",
  "image",
  "workflow-image",
  "asset-image",
  "storyboard-image",
  "vendor-storyboard",
  "dreamina",
  "canvas-generation",
]);

const MEDIA_TYPES = new Set<GenerationCompletionMediaType>(["image", "video", "audio"]);

export function createGenerationCompletionContract(
  input: Omit<GenerationCompletionContractV1, "version">,
): GenerationCompletionContractV1 {
  if (!KINDS.has(input.kind)) throw new Error("完成合同业务类型无效");
  if (!MEDIA_TYPES.has(input.mediaType)) throw new Error("完成合同媒体类型无效");
  const relativePath = normalizeContractRelativePath(input.relativePath);
  const contract: GenerationCompletionContractV1 = {
    version: GENERATION_COMPLETION_CONTRACT_VERSION,
    kind: input.kind,
    mediaType: input.mediaType,
    relativePath,
  };
  const videoId = asPositiveInt(input.videoId);
  const imageId = asPositiveInt(input.imageId);
  const storyboardId = asPositiveInt(input.storyboardId);
  const assetsId = asPositiveInt(input.assetsId);
  const projectId = asPositiveInt(input.projectId);
  const scriptId = asPositiveInt(input.scriptId);
  const taskUuid = asUuid(input.taskUuid);
  const shotUuid = asUuid(input.shotUuid);
  const canvasRunUuid = asUuid(input.canvasRunUuid);
  const canvasNodeUuid = asUuid(input.canvasNodeUuid);
  if (videoId) contract.videoId = videoId;
  if (imageId) contract.imageId = imageId;
  if (storyboardId) contract.storyboardId = storyboardId;
  if (assetsId) contract.assetsId = assetsId;
  if (projectId) contract.projectId = projectId;
  if (scriptId) contract.scriptId = scriptId;
  if (taskUuid) contract.taskUuid = taskUuid;
  if (shotUuid) contract.shotUuid = shotUuid;
  if (canvasRunUuid) contract.canvasRunUuid = canvasRunUuid;
  if (canvasNodeUuid) contract.canvasNodeUuid = canvasNodeUuid;
  assertPrimaryKey(contract);
  return contract;
}

export function stringifyGenerationCompletionContract(
  contract: GenerationCompletionContractV1,
): string {
  return JSON.stringify(createGenerationCompletionContract(contract));
}

export function parseGenerationCompletionContract(
  raw: string | null | undefined,
): GenerationCompletionContractV1 {
  if (!raw || !raw.trim()) throw new Error("完成合同缺失");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("完成合同不是合法 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("完成合同格式无效");
  }
  const record = parsed as Record<string, unknown>;
  const version = Number(record.version);
  if (version !== GENERATION_COMPLETION_CONTRACT_VERSION) {
    throw new Error("完成合同版本不受支持");
  }
  return createGenerationCompletionContract({
    kind: record.kind as GenerationCompletionKind,
    mediaType: record.mediaType as GenerationCompletionMediaType,
    relativePath: String(record.relativePath ?? ""),
    videoId: asPositiveInt(record.videoId),
    imageId: asPositiveInt(record.imageId),
    storyboardId: asPositiveInt(record.storyboardId),
    assetsId: asPositiveInt(record.assetsId),
    taskUuid: typeof record.taskUuid === "string" ? record.taskUuid : undefined,
    shotUuid: typeof record.shotUuid === "string" ? record.shotUuid : undefined,
    projectId: asPositiveInt(record.projectId),
    scriptId: asPositiveInt(record.scriptId),
    canvasRunUuid: typeof record.canvasRunUuid === "string" ? record.canvasRunUuid : undefined,
    canvasNodeUuid: typeof record.canvasNodeUuid === "string" ? record.canvasNodeUuid : undefined,
  });
}

function assertPrimaryKey(contract: GenerationCompletionContractV1): void {
  if (contract.kind === "video" && !contract.videoId) {
    throw new Error("视频完成合同缺少 videoId");
  }
  if (
    (contract.kind === "image" || contract.kind === "workflow-image" || contract.kind === "asset-image")
    && !contract.imageId
  ) {
    throw new Error("图片完成合同缺少 imageId");
  }
  if (contract.kind === "storyboard-image" && !contract.storyboardId) {
    throw new Error("分镜图片完成合同缺少 storyboardId");
  }
  if (
    (contract.kind === "vendor-storyboard" || contract.kind === "dreamina")
    && (!contract.taskUuid || !contract.shotUuid)
  ) {
    throw new Error("分镜完成合同缺少 taskUuid/shotUuid");
  }
  if (contract.kind === "canvas-generation" && (!contract.canvasRunUuid || !contract.canvasNodeUuid)) {
    throw new Error("画布生成完成合同缺少 canvasRunUuid/canvasNodeUuid");
  }
}

function normalizeContractRelativePath(relativePath: string): string {
  const trimmed = String(relativePath ?? "").replace(/^\/+/, "").replace(/\\/g, "/");
  if (!trimmed.startsWith("files/")) throw new Error("完成合同目标路径必须位于 files/");
  const parts = trimmed.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("完成合同目标路径无效");
  }
  return trimmed;
}

function asPositiveInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

function asUuid(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^[0-9a-f-]{36}$/i.test(value) ? value : undefined;
}
