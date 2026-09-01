/**
 * 完整项目创建流水线：
 * 1) 中央创建 2) 刷新本地运行时目录 3) open 4) editProject 写本地字段。
 * 中央成功后本地失败时保留 projectUuid，重试不得再次 POST 中央创建。
 */
import axios from "@/utils/axios";
import {
  openCatalogProject,
  refreshRuntimeProjectCatalog,
  type OpenProjectResult,
} from "./catalog";
import { createScopedProject, type CreateScope } from "./create-project";
import { toLocalProjectId } from "./local-project-id";
import projectStore from "@/stores/project";
import { syncCatalogProjectNow } from "./project-actions";

export interface FullProjectCreateFields {
  name: string;
  projectType: string;
  intro: string;
  type: string;
  artStyle: string;
  directorManual: string;
  videoRatio: string;
  imageModel: string;
  videoModel: string;
  imageQuality: string;
  mode: string;
  scope: CreateScope;
  teamUuid?: string;
  defaultLanguage?: string;
  assetSourceProjectUuid?: string;
}

export class LocalProjectInitError extends Error {
  readonly projectUuid: string;

  constructor(projectUuid: string, cause: unknown) {
    super(normalizeProjectOperationError(cause, "项目已创建，但本地初始化失败，请重试"));
    this.name = "LocalProjectInitError";
    this.projectUuid = projectUuid;
  }
}

const DEFAULT_PROJECT_ERROR = "项目创建失败，请稍后重试";
const ERROR_CODE_MESSAGES: Record<string, string> = {
  CREATE_PROJECT_UUID_MISSING: "项目创建成功但未返回项目编号，请重试",
  LOCAL_PROJECT_ID_MISSING: "项目已创建，但本地初始化失败，请重试",
  PROJECT_NAME_REQUIRED: "请输入项目名称",
  TEAM_UUID_REQUIRED: "请选择可创建项目的团队",
};

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
    ERROR_CODE_MESSAGES[String(row.code ?? "")],
  ];
}

function safeChineseMessage(value: unknown): string {
  if (typeof value !== "string") return "";
  const message = value.replace(/\s+/g, " ").trim();
  if (!message || message === "[object Object]") return "";
  if (ERROR_CODE_MESSAGES[message]) return ERROR_CODE_MESSAGES[message];
  // 用户提示禁止携带本地路径、URL、认证信息或调用栈片段。
  if (/(?:[a-z]:[\\/]|\\\\|(?:^|[\s("'])\.{1,2}[\\/]|(?:^|[\s("'])\/(?:users|home|var|tmp|etc|opt|srv|app)\b|https?:\/\/|bearer\b|authorization\b|api[_ -]?key|access[_ -]?key|secret\b|token\b|stack\b|\bat\s+[\w$.]+\s*\()/i.test(message)) {
    return "";
  }
  if (!/[\u3400-\u9fff]/u.test(message)) return "";
  return message.slice(0, 160);
}

/** 只投影可公开的中文业务提示，禁止直接字符串化响应对象。 */
export function normalizeProjectOperationError(
  error: unknown,
  fallback = DEFAULT_PROJECT_ERROR,
): string {
  for (const candidate of errorMessageCandidates(error)) {
    const safe = safeChineseMessage(candidate);
    if (safe) return safe;
  }
  return safeChineseMessage(fallback) || DEFAULT_PROJECT_ERROR;
}

export function extractCreatedProjectUuid(data: unknown): string {
  const row = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const nested = row.data && typeof row.data === "object"
    ? row.data as Record<string, unknown>
    : row;
  const uuid = String(nested.projectUuid ?? nested.uuid ?? row.projectUuid ?? "").trim();
  if (!uuid) throw new Error("CREATE_PROJECT_UUID_MISSING");
  return uuid;
}

/**
 * 将 open 返回的本地主键规范为正安全整数。
 * 禁止以字符串发送 id 规避 editProject 的 z.number() 契约。
 * 与 toLocalProjectId 同一叶子边界，避免重复实现。
 */
export function toPositiveSafeIntegerId(raw: unknown): number {
  try {
    return toLocalProjectId(raw);
  } catch {
    throw new Error("LOCAL_PROJECT_ID_MISSING");
  }
}

/** 仅刷新、打开、本地字段保存与首次同步；禁止中央重复创建。 */
export async function completeLocalProjectInit(
  projectUuid: string,
  fields: FullProjectCreateFields,
): Promise<OpenProjectResult> {
  await refreshRuntimeProjectCatalog();
  const opened = await openCatalogProject(projectUuid);
  // JSON number：与 editProject 的正安全整数契约对齐。
  const localId = toPositiveSafeIntegerId(opened.project?.id);
  // open 已建立真实运行时访问模式；必须在旧项目字段写入前同步到前端访问门。
  projectStore().activateProject(opened.project, {
    projectUuid: opened.projectUuid,
    mode: opened.accessMode,
    reason: opened.readonlyReason ?? "",
    lockHolder: opened.lockHolder ?? "",
    runtimeGeneration: opened.runtimeGeneration,
  });
  await axios.post("/project/editProject", {
    id: localId,
    name: fields.name,
    intro: fields.intro,
    type: fields.type,
    artStyle: fields.artStyle,
    directorManual: fields.directorManual,
    videoRatio: fields.videoRatio,
    imageModel: fields.imageModel,
    videoModel: fields.videoModel,
    projectType: fields.projectType || "novel",
    defaultLanguage: fields.defaultLanguage,
    imageQuality: fields.imageQuality,
    mode: fields.mode,
  });
  // 新建成功后必须立即形成首个云端版本，不能等 30 秒定时器或应用退出。
  await syncCatalogProjectNow(projectUuid);
  return opened;
}

/**
 * @param existingProjectUuid 中央已创建成功后的重试标记；有值则跳过中央 POST。
 */
export async function createProjectWithLocalInit(
  fields: FullProjectCreateFields,
  existingProjectUuid?: string,
): Promise<{ projectUuid: string; opened: OpenProjectResult }> {
  let projectUuid = existingProjectUuid?.trim() || "";
  if (!projectUuid) {
    const created = await createScopedProject({
      name: fields.name,
      scope: fields.scope,
      teamUuid: fields.scope === "team" ? fields.teamUuid : undefined,
      businessType: fields.projectType,
      description: fields.intro,
      artStyle: fields.artStyle,
      aspectRatio: fields.videoRatio,
      defaultLanguage: fields.defaultLanguage,
      assetSourceProjectUuid: fields.assetSourceProjectUuid,
    });
    projectUuid = extractCreatedProjectUuid(created);
  }
  try {
    const opened = await completeLocalProjectInit(projectUuid, fields);
    return { projectUuid, opened };
  } catch (error) {
    throw new LocalProjectInitError(projectUuid, error);
  }
}
