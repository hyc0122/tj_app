/**
 * 项目创建：personal 无 teamUuid；team 必须选 owner/editor 团队。
 */
import { v4 as uuidv4 } from "uuid";
import axios from "@/utils/axios";
import {
  buildClientAPIPath,
  type TeamRole,
} from "@/features/tianjiang/contracts";

export type CreateScope = "personal" | "team";
export type ProjectBusinessType = "novel" | "script" | "storyboard" | "canvas";

export interface ProjectCapabilitySet {
  route: "/novel" | "/script" | "/storyboard-project" | "/infinite-canvas";
  modules: readonly ("source" | "script" | "storyboard" | "assets" | "settings" | "canvas")[];
  workspacePath?: (projectUuid: string) => string;
}

export interface CreateProjectBody {
  name: string;
  scope: CreateScope;
  teamUuid?: string;
  businessType: ProjectBusinessType;
  description: string;
  artStyle: string;
  aspectRatio: string;
  defaultLanguage: string;
  assetSourceProjectUuid?: string;
  clientCreateRequestId?: string;
}

export interface CreatableTeamOption {
  teamUuid: string;
  name: string;
  myRole: TeamRole;
}

const CAPABILITIES = {
  novel: { route: "/novel", modules: ["source", "script", "assets", "settings"] },
  script: { route: "/script", modules: ["script", "assets", "settings"] },
  storyboard: { route: "/storyboard-project", modules: ["storyboard", "assets", "settings"] },
  canvas: {
    route: "/infinite-canvas",
    modules: ["canvas"],
    workspacePath: (projectUuid: string) => `/infinite-canvas/${encodeURIComponent(projectUuid)}`,
  },
} as const satisfies Readonly<Record<ProjectBusinessType, ProjectCapabilitySet>>;

/** 路由和模块显示的唯一权威，禁止再使用“不是 script 就是 novel”。 */
export function projectCapabilities(type: string): ProjectCapabilitySet {
  const normalized = normalizeProjectBusinessType(type);
  return CAPABILITIES[normalized];
}

export function normalizeProjectBusinessType(value: unknown): ProjectBusinessType {
  if (value === "script" || value === "storyboard" || value === "novel" || value === "canvas") return value;
  if (value == null || value === "") return "novel";
  throw new Error("PROJECT_BUSINESS_TYPE_INVALID");
}

/** 仅 owner/editor 可创建团队项目 */
export function filterCreatableTeams(
  teams: Array<{ teamUuid: string; name: string; myRole: TeamRole }>,
): CreatableTeamOption[] {
  return teams
    .filter((t) => t.myRole === "owner" || t.myRole === "editor")
    .map((t) => ({ teamUuid: t.teamUuid, name: t.name, myRole: t.myRole }));
}

export function buildCreateProjectBody(input: {
  name: string;
  scope: CreateScope;
  teamUuid?: string;
  businessType?: string;
  description?: string;
  artStyle?: string;
  aspectRatio?: string;
  defaultLanguage?: string;
  assetSourceProjectUuid?: string;
  clientCreateRequestId?: string;
}): CreateProjectBody {
  const name = input.name.trim();
  if (!name) throw new Error("PROJECT_NAME_REQUIRED");
  const businessType = normalizeProjectBusinessType(input.businessType);
  const sourceUuid = String(input.assetSourceProjectUuid ?? "").trim();
  if (sourceUuid && businessType !== "storyboard") {
    throw new Error("只有分镜项目可以指定资产来源");
  }
  if (businessType === "canvas" && input.scope === "team") {
    throw new Error("CANVAS_TEAM_SCOPE_NOT_SUPPORTED");
  }
  const body: CreateProjectBody = {
    name,
    scope: businessType === "canvas" ? "personal" : input.scope === "team" ? "team" : "personal",
    businessType,
    description: String(input.description ?? "").trim(),
    artStyle: String(input.artStyle ?? "").trim(),
    aspectRatio: String(input.aspectRatio ?? "").trim(),
    defaultLanguage: String(input.defaultLanguage ?? "").trim(),
  };
  if (businessType === "canvas") {
    body.clientCreateRequestId = String(input.clientCreateRequestId ?? "").trim() || uuidv4();
  }
  if (body.scope === "personal") {
    if (sourceUuid) body.assetSourceProjectUuid = sourceUuid;
    return body;
  }
  const teamUuid = String(input.teamUuid ?? "").trim();
  if (!teamUuid) throw new Error("TEAM_UUID_REQUIRED");
  body.teamUuid = teamUuid;
  if (sourceUuid) body.assetSourceProjectUuid = sourceUuid;
  return body;
}

/** 通过中央公开契约创建，禁止回退到未登记的本地运行时写路径。 */
export async function createScopedProject(input: {
  name: string;
  scope: CreateScope;
  teamUuid?: string;
  businessType?: string;
  description?: string;
  artStyle?: string;
  aspectRatio?: string;
  defaultLanguage?: string;
  assetSourceProjectUuid?: string;
  clientCreateRequestId?: string;
}): Promise<unknown> {
  const body = buildCreateProjectBody(input);
  const response = await axios.post(buildClientAPIPath("createProject"), body);
  return response.data;
}
