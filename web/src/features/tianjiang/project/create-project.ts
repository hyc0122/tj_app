/**
 * 项目创建：personal 无 teamUuid；team 必须选 owner/editor 团队。
 */
import axios from "@/utils/axios";
import {
  buildClientAPIPath,
  type TeamRole,
} from "@/features/tianjiang/contracts";

export type CreateScope = "personal" | "team";
export type ProjectBusinessType = "novel" | "script" | "storyboard";

export interface ProjectCapabilitySet {
  route: "/novel" | "/script" | "/storyboard-project";
  modules: readonly ("source" | "script" | "storyboard" | "assets" | "settings")[];
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
}

export interface CreatableTeamOption {
  teamUuid: string;
  name: string;
  myRole: TeamRole;
}

const CAPABILITIES: Record<ProjectBusinessType, ProjectCapabilitySet> = {
  novel: { route: "/novel", modules: ["source", "script", "assets", "settings"] },
  script: { route: "/script", modules: ["script", "assets", "settings"] },
  storyboard: { route: "/storyboard-project", modules: ["storyboard", "assets", "settings"] },
};

/** 路由和模块显示的唯一权威，禁止再使用“不是 script 就是 novel”。 */
export function projectCapabilities(type: string): ProjectCapabilitySet {
  const normalized = normalizeProjectBusinessType(type);
  return CAPABILITIES[normalized];
}

export function normalizeProjectBusinessType(value: unknown): ProjectBusinessType {
  if (value === "script" || value === "storyboard" || value === "novel") return value;
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
}): CreateProjectBody {
  const name = input.name.trim();
  if (!name) throw new Error("PROJECT_NAME_REQUIRED");
  const businessType = normalizeProjectBusinessType(input.businessType);
  const sourceUuid = String(input.assetSourceProjectUuid ?? "").trim();
  if (sourceUuid && businessType !== "storyboard") {
    throw new Error("只有分镜项目可以指定资产来源");
  }
  const body: CreateProjectBody = {
    name,
    scope: input.scope === "team" ? "team" : "personal",
    businessType,
    description: String(input.description ?? "").trim(),
    artStyle: String(input.artStyle ?? "").trim(),
    aspectRatio: String(input.aspectRatio ?? "").trim(),
    defaultLanguage: String(input.defaultLanguage ?? "").trim(),
  };
  if (input.scope === "personal") {
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
}): Promise<unknown> {
  const body = buildCreateProjectBody(input);
  const response = await axios.post(buildClientAPIPath("createProject"), body);
  return response.data;
}
