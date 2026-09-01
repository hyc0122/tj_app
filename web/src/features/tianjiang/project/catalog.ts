import axios from "@/utils/axios";
import { buildClientAPIPath } from "@/features/tianjiang/contracts";
import type { Project, ProjectAccessMode } from "@/stores/project";

export interface CatalogProject {
  projectUuid: string;
  name: string;
  kind: "personal" | "team";
  /** 团队项目归属 UUID（外部标识，非内部数字 ID） */
  teamUuid?: string;
  /** 服务端返回的团队名称，客户端不信任自造 teamName */
  teamName?: string;
  myRole: "owner" | "editor" | "viewer";
  currentVersion: number;
  syncState: string;
  lastSyncedAt: string | null;
  updatedAt: string;
  lockStatus: "none" | "active" | "expired" | "revoked";
  lockHolderName: string;
  openMode: "editable" | "readonly";
  businessType: "novel" | "script" | "storyboard" | "canvas";
  description?: string;
  artStyle?: string;
  aspectRatio?: string;
  defaultLanguage?: string;
  assetSourceProjectUuid?: string;
}

export interface OpenProjectResult {
  projectUuid: string;
  kind: "personal" | "team";
  editable: boolean;
  readonlyReason?: string;
  lockHolder?: string;
  recoveryRequired: boolean;
  accessMode: ProjectAccessMode;
  project: Project;
  runtimeGeneration?: number;
}

const runtimeEndpoint = "/tianjiang/runtime/projects";

/** 非法归属类型必须阻断整批目录，错误只携带安全诊断字段。 */
function normalizeCatalogBusinessType(
  value: unknown,
  kind: unknown,
  projectUuid: string,
  rowIndex: number,
): CatalogProject["businessType"] {
  if (value === "canvas" && kind === "team") {
    throw new ProjectCatalogContractError(projectUuid, rowIndex, "CANVAS_TEAM_SCOPE_NOT_SUPPORTED");
  }
  if (value === "script" || value === "storyboard" || value === "novel" || value === "canvas") {
    return value;
  }
  if (value == null || value === "") return "novel";
  throw new ProjectCatalogContractError(projectUuid, rowIndex, "PROJECT_BUSINESS_TYPE_INVALID");
}

export class ProjectCatalogContractError extends Error {
  readonly code: string;

  constructor(
    readonly projectUuid: string,
    readonly rowIndex: number,
    code = "PROJECT_KIND_INVALID",
  ) {
    super(
      code === "CANVAS_TEAM_SCOPE_NOT_SUPPORTED"
        ? "无限画布首期不支持团队归属"
        : code === "PROJECT_BUSINESS_TYPE_INVALID"
          ? "PROJECT_BUSINESS_TYPE_INVALID"
          : `项目目录归属类型无效（第 ${rowIndex + 1} 项，projectUuid=${projectUuid}）`,
    );
    this.name = "ProjectCatalogContractError";
    this.code = code;
  }
}

/** 目录响应仅投影界面需要的公开字段，未知字段不会扩散到状态树。 */
export function projectCatalogItem(value: unknown, rowIndex = 0): CatalogProject {
  const row = value && typeof value === "object"
    ? value as Record<string, any>
    : {};
  if (row.kind !== "personal" && row.kind !== "team") {
    const projectUuid = String(row.projectUuid ?? "").trim() || "(missing)";
    throw new ProjectCatalogContractError(projectUuid, rowIndex);
  }
  return {
    projectUuid: String(row.projectUuid ?? ""),
    name: String(row.name ?? ""),
    kind: row.kind,
    teamUuid: row.teamUuid ? String(row.teamUuid) : undefined,
    teamName: row.teamName ? String(row.teamName) : undefined,
    myRole: row.myRole ?? row.role,
    currentVersion: Number(row.currentVersion ?? 0),
    syncState:
      row.syncState ??
      (row.myRole === "viewer" || row.role === "viewer" ? "readonly" : "synced"),
    lastSyncedAt: row.lastSyncedAt ?? null,
    updatedAt: row.updatedAt ?? row.UpdatedAt ?? row.lastSyncedAt ?? "",
    lockStatus: row.lockStatus ?? "none",
    lockHolderName: row.lockHolderName ?? "",
    openMode:
      row.openMode ??
      (row.myRole === "viewer" || row.role === "viewer" ? "readonly" : "editable"),
    businessType: normalizeCatalogBusinessType(row.businessType, row.kind, row.projectUuid, rowIndex),
    description: row.description ? String(row.description) : undefined,
    artStyle: row.artStyle ? String(row.artStyle) : undefined,
    aspectRatio: row.aspectRatio ? String(row.aspectRatio) : undefined,
    defaultLanguage: row.defaultLanguage ? String(row.defaultLanguage) : undefined,
    assetSourceProjectUuid: row.assetSourceProjectUuid
      ? String(row.assetSourceProjectUuid)
      : undefined,
  };
}

export async function fetchProjectCatalog(): Promise<CatalogProject[]> {
  const response = await axios.get(buildClientAPIPath("projectCatalog"));
  const rows = Array.isArray(response.data)
    ? response.data
    : Array.isArray(response.data?.projects)
      ? response.data.projects
      : [];
  return rows.map((row: unknown, rowIndex: number) => projectCatalogItem(row, rowIndex));
}

export async function openCatalogProject(projectUuid: string): Promise<OpenProjectResult> {
  const response = await axios.post(`${runtimeEndpoint}/${encodeURIComponent(projectUuid)}/open`);
  return unwrapOpenProjectResult(response);
}

export function unwrapOpenProjectResult(payload: unknown): OpenProjectResult {
  const row = payload && typeof payload === "object" ? payload as Record<string, any> : {};
  const body = row.data && typeof row.data === "object" && row.projectUuid == null
    ? row.data as Record<string, any>
    : row;
  return {
    projectUuid: String(body.projectUuid ?? ""),
    kind: body.kind === "team" ? "team" : "personal",
    editable: Boolean(body.editable),
    readonlyReason: body.readonlyReason ? String(body.readonlyReason) : undefined,
    lockHolder: body.lockHolder ? String(body.lockHolder) : undefined,
    recoveryRequired: Boolean(body.recoveryRequired),
    accessMode: body.accessMode ?? (body.editable ? "readwrite" : "readonly"),
    project: body.project,
    runtimeGeneration: Number.isSafeInteger(Number(body.runtimeGeneration))
      ? Number(body.runtimeGeneration)
      : undefined,
  };
}

export async function closeCatalogProject(
  projectUuid: string,
  runtimeGeneration?: number,
): Promise<unknown> {
  const body = Number.isSafeInteger(Number(runtimeGeneration)) && Number(runtimeGeneration) > 0
    ? { runtimeGeneration: Number(runtimeGeneration) }
    : {};
  return axios.post(`${runtimeEndpoint}/${encodeURIComponent(projectUuid)}/close`, body);
}

/** 刷新本地 SyncCoordinator 目录快照，供中央创建后立即 open。 */
export async function refreshRuntimeProjectCatalog(): Promise<CatalogProject[]> {
  const response = await axios.post(`${runtimeEndpoint}/refresh`);
  const rows = Array.isArray(response.data)
    ? response.data
    : Array.isArray(response.data?.projects)
      ? response.data.projects
      : [];
  return rows.map((row: unknown, rowIndex: number) => projectCatalogItem(row, rowIndex));
}

export async function createCatalogProject(input: {
  name: string;
  kind: "personal" | "team";
  teamUuid?: string;
  businessType?: string;
  description?: string;
  artStyle?: string;
  aspectRatio?: string;
  defaultLanguage?: string;
  assetSourceProjectUuid?: string;
}): Promise<CatalogProject> {
  const { buildCreateProjectBody } = await import("./create-project");
  const response = await axios.post(
    buildClientAPIPath("createProject"),
    buildCreateProjectBody({
      name: input.name,
      scope: input.kind,
      teamUuid: input.teamUuid,
      businessType: input.businessType,
      description: input.description,
      artStyle: input.artStyle,
      aspectRatio: input.aspectRatio,
      defaultLanguage: input.defaultLanguage,
      assetSourceProjectUuid: input.assetSourceProjectUuid,
    }),
  );
  return projectCatalogItem(response.data ?? {});
}

export interface ProjectRecovery {
  recoveryId: string;
  projectUuid: string;
  reason: string;
  createdAt: string;
  databaseMD5: string;
  resolved: boolean;
}

export async function fetchProjectRecoveries(projectUuid: string): Promise<ProjectRecovery[]> {
  const response = await axios.get(
    `${runtimeEndpoint}/${encodeURIComponent(projectUuid)}/recoveries`,
  );
  return Array.isArray(response.data) ? response.data : [];
}

export async function keepProjectRecovery(
  projectUuid: string,
  recoveryId: string,
): Promise<ProjectRecovery> {
  const response = await axios.post(
    `${runtimeEndpoint}/${encodeURIComponent(projectUuid)}/recoveries/${encodeURIComponent(recoveryId)}/resolve`,
    { resolution: "keep_backup" },
  );
  return response.data;
}
