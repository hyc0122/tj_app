import { BUSINESS_USERNAME_PATTERN } from "./contracts";

export const CLIENT_CONTROL_PLANE_ENDPOINTS = Object.freeze({
  inviteTeamMember: {
    method: "POST",
    path: "/teams/:team_uuid/invitations",
  },
  listTeamInvitations: {
    method: "GET",
    path: "/team-invitations",
  },
  rejectTeamInvitation: {
    method: "POST",
    path: "/team-invitations/:invitation_uuid/reject",
  },
  createProject: {
    method: "POST",
    path: "/projects",
  },
  /** 大文件分片：与中央 multipart prepare 对齐（业务鉴权 v1）。 */
  prepareMultipart: {
    method: "POST",
    path: "/upload-sessions/:session_uuid/multipart/prepare",
  },
  completeMultipart: {
    method: "POST",
    path: "/upload-sessions/:session_uuid/multipart/complete",
  },
} as const);

export type ClientControlPlaneEndpointName = keyof typeof CLIENT_CONTROL_PLANE_ENDPOINTS;
export type ClientControlPlanePathParameters = Readonly<Record<string, string | number>>;

export type ClientControlPlaneRequest = Readonly<Record<string, unknown>> | undefined;

const VERSIONED_BASE_PATH = "/api/tianjiang/v1";
const CLIENT_BASE_PATH = "/api";

/**
 * 服务端新契约合并到公共生成物前，客户端在这里冻结最小补充白名单。
 * 该白名单只增加已由中央服务端落地的接口，不能变成任意路径代理。
 */
export function buildClientControlPlanePath(
  name: ClientControlPlaneEndpointName,
  parameters: ClientControlPlanePathParameters = {},
): string {
  const endpoint = CLIENT_CONTROL_PLANE_ENDPOINTS[name];
  const relativePath = endpoint.path.replace(/:([a-z_]+)/g, (_token, parameter: string) => {
    const value = parameters[parameter];
    if (value === undefined || value === null || String(value).length === 0) {
      throw new Error(`缺少客户端控制面路径参数：${parameter}`);
    }
    return encodeURIComponent(String(value));
  });
  if (relativePath.includes(":")) throw new Error(`客户端控制面路径参数未完全替换：${relativePath}`);
  return `${VERSIONED_BASE_PATH}${relativePath}`.slice(CLIENT_BASE_PATH.length);
}

export function matchClientControlPlaneEndpoint(
  method: string,
  pathname: string,
): ClientControlPlaneEndpointName | null {
  if (!pathname.startsWith(`${VERSIONED_BASE_PATH}/`) || pathname.includes("?") || pathname.includes("#")) {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\\") || decoded.split("/").some((part) => part === "." || part === "..")) {
    return null;
  }
  const actualParts = decoded.slice(VERSIONED_BASE_PATH.length).split("/");
  for (const name of Object.keys(CLIENT_CONTROL_PLANE_ENDPOINTS) as ClientControlPlaneEndpointName[]) {
    const endpoint = CLIENT_CONTROL_PLANE_ENDPOINTS[name];
    if (endpoint.method !== method.toUpperCase()) continue;
    const expectedParts = endpoint.path.split("/");
    if (
      expectedParts.length === actualParts.length
      && expectedParts.every((part, index) => part.startsWith(":") || part === actualParts[index])
      && actualParts.every((part) => part.length > 0 || part === actualParts[0])
    ) return name;
  }
  return null;
}

function asRequestObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("客户端控制面请求体必须是对象");
  }
  return body as Record<string, unknown>;
}

/**
 * 在 JWT 注入前收敛开发者2已冻结的新增请求，避免旧 userId 邀请或伪造团队名继续向中央透传。
 */
export function validateClientControlPlaneRequest(
  endpoint: ClientControlPlaneEndpointName,
  body: unknown,
): ClientControlPlaneRequest {
  if (endpoint === "listTeamInvitations" || endpoint === "rejectTeamInvitation") {
    return undefined;
  }
  if (endpoint === "prepareMultipart" || endpoint === "completeMultipart") {
    // multipart 请求体由中央服务端 binding 校验；控制面仅放行路径与对象体。
    return body && typeof body === "object" && !Array.isArray(body)
      ? body as ClientControlPlaneRequest
      : undefined;
  }
  const request = asRequestObject(body);
  if (endpoint === "inviteTeamMember") {
    const username = typeof request.username === "string" ? request.username.trim().toLowerCase() : "";
    const role = request.role;
    if (!new RegExp(BUSINESS_USERNAME_PATTERN).test(username)) {
      throw new Error("username 必须是已注册业务用户名");
    }
    if (role !== "editor" && role !== "viewer") {
      throw new Error("邀请 role 只能是 editor 或 viewer");
    }
    return { username, role };
  }

  const name = typeof request.name === "string" ? request.name.trim() : "";
  // kind 是已废弃旧字段，即使同时提供 scope 也必须拒绝，避免客户端悄悄兼容漂移契约。
  if ("kind" in request) throw new Error("项目请求禁止使用旧 kind 字段，请改用 scope");
  const scope = request.scope;
  const businessType = request.businessType;
  const teamUuid = typeof request.teamUuid === "string" ? request.teamUuid.trim() : "";
  const description = typeof request.description === "string" ? request.description.trim() : "";
  const artStyle = typeof request.artStyle === "string" ? request.artStyle.trim() : "";
  const aspectRatio = typeof request.aspectRatio === "string" ? request.aspectRatio.trim() : "";
  const defaultLanguage = typeof request.defaultLanguage === "string" ? request.defaultLanguage.trim() : "";
  const sourceUuid = typeof request.assetSourceProjectUuid === "string"
    ? request.assetSourceProjectUuid.trim()
    : "";
  if (!name || name.length > 160) throw new Error("项目 name 不能为空且不得超过 160 字符");
  if (scope !== "personal" && scope !== "team") throw new Error("项目 scope 必须是 personal 或 team");
  if (scope === "personal" && teamUuid) throw new Error("personal 项目禁止携带 teamUuid");
  if (scope === "team" && !teamUuid) throw new Error("team 项目必须携带 teamUuid");
  if (
    businessType !== undefined
    && businessType !== "novel"
    && businessType !== "script"
    && businessType !== "storyboard"
  ) {
    throw new Error("businessType 只能是 novel、script 或 storyboard");
  }
  if (sourceUuid && businessType !== "storyboard") {
    throw new Error("只有分镜项目可以指定资产来源");
  }
  return {
    name,
    scope,
    ...(teamUuid ? { teamUuid } : {}),
    ...(businessType ? { businessType } : {}),
    ...(description ? { description } : {}),
    ...(artStyle ? { artStyle } : {}),
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(defaultLanguage ? { defaultLanguage } : {}),
    ...(sourceUuid ? { assetSourceProjectUuid: sourceUuid } : {}),
  };
}
