/**
 * 团队邀请：按用户名邀请、本人 pending、接受/拒绝。
 * 路径对齐冻结契约 /api/tianjiang/v1/team-invitations*。
 */
import axios from "@/utils/axios";
import {
  buildClientAPIPath,
  type TeamRole,
} from "@/features/tianjiang/contracts";

export type InviteRole = Exclude<TeamRole, "owner">;

export interface PendingInvitation {
  invitationUuid: string;
  teamUuid: string;
  teamName: string;
  role: InviteRole;
  inviterUsername: string;
  inviteeUsername: string;
  createdAt: string;
  status: "pending";
}

export interface InvitationResult {
  invitationUuid: string;
  status: string;
  inviteeUsername: string;
  teamUuid: string;
  teamName: string;
  role: InviteRole;
  createdAt: string;
}

const SENSITIVE_RE = /(^key$|password|token|secret|credential|private[_-]?key|access[_-]?key)/i;

/** 递归剥离意外敏感字段，避免嵌套错误载荷进入界面状态。 */
function stripSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSensitive);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_RE.test(key)) continue;
    out[key] = stripSensitive(child);
  }
  return out;
}

export function projectPendingInvitation(raw: Record<string, unknown>): PendingInvitation {
  const clean = stripSensitive(raw) as Record<string, unknown>;
  return {
    invitationUuid: String(clean.invitationUuid ?? ""),
    teamUuid: String(clean.teamUuid ?? ""),
    teamName: String(clean.teamName ?? ""),
    role: (clean.role === "editor" ? "editor" : "viewer") as InviteRole,
    inviterUsername: String(clean.inviterUsername ?? clean.inviterName ?? ""),
    inviteeUsername: String(clean.inviteeUsername ?? ""),
    createdAt: String(clean.createdAt ?? ""),
    status: "pending",
  };
}

/** 邀请创建结果只保留服务端公开 DTO 字段。 */
export function projectInvitationResult(raw: Record<string, unknown>): InvitationResult {
  const clean = stripSensitive(raw) as Record<string, unknown>;
  return {
    invitationUuid: String(clean.invitationUuid ?? ""),
    status: String(clean.status ?? "pending"),
    inviteeUsername: String(clean.inviteeUsername ?? ""),
    teamUuid: String(clean.teamUuid ?? ""),
    teamName: String(clean.teamName ?? ""),
    role: clean.role === "editor" ? "editor" : "viewer",
    createdAt: String(clean.createdAt ?? ""),
  };
}

/** 邀请 body 仅 username + role，禁止 userId */
export function buildInviteBody(username: string, role: InviteRole): { username: string; role: InviteRole } {
  return { username: username.trim().toLowerCase(), role };
}

export async function inviteTeamMemberByUsername(
  teamUuid: string,
  username: string,
  role: InviteRole,
): Promise<InvitationResult> {
  const body = buildInviteBody(username, role);
  if (!body.username) throw new Error("INVITEE_USERNAME_REQUIRED");
  const response = await axios.post(
    buildClientAPIPath("inviteTeamMember", { team_uuid: teamUuid }),
    body,
  );
  return projectInvitationResult(response.data ?? {});
}

/** 列出当前登录用户的 pending 邀请 */
export async function listMyPendingInvitations(): Promise<PendingInvitation[]> {
  const response = await axios.get(buildClientAPIPath("listTeamInvitations"), {
    params: { status: "pending" },
  });
  const rows = response.data?.invitations ?? response.data ?? [];
  if (!Array.isArray(rows)) return [];
  return rows.map((row: Record<string, unknown>) => projectPendingInvitation(row));
}

export async function acceptInvitation(invitationUuid: string): Promise<void> {
  await axios.post(
    buildClientAPIPath("acceptTeamInvitation", {
      invitation_uuid: invitationUuid,
    }),
  );
}

export async function rejectInvitation(invitationUuid: string): Promise<void> {
  await axios.post(
    buildClientAPIPath("rejectTeamInvitation", {
      invitation_uuid: invitationUuid,
    }),
  );
}

/** 将后端错误码映射为 i18n key（组件不拼接 SQL/任意 msg） */
export function mapInvitationErrorKey(error: any): string {
  const code = error?.code ?? error?.response?.data?.code ?? error?.message;
  const map: Record<string, string> = {
    INVITEE_NOT_REGISTERED: "teamPage.error.inviteeNotRegistered",
    INVITEE_UNAVAILABLE: "teamPage.error.inviteeUnavailable",
    TEAM_MEMBER_EXISTS: "teamPage.error.memberExists",
    INVALID_REQUEST: "teamPage.error.invalidRequest",
    INVITEE_USERNAME_REQUIRED: "teamPage.error.usernameRequired",
  };
  if (typeof code === "string" && map[code]) return map[code];
  const http = error?.response?.status;
  if (http === 409) return "teamPage.error.memberExists";
  if (http === 422) return "teamPage.error.inviteeNotRegistered";
  return "teamPage.error.operation";
}
