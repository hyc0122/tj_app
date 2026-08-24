import axios from "@/utils/axios";
import {
  buildClientAPIPath,
  type TeamRole,
} from "@/features/tianjiang/contracts";

export type { TeamRole };

export interface TeamMember {
  userId: number;
  username: string;
  nickname: string;
  userName: string;
  role: TeamRole;
}

export interface Team {
  teamUuid: string;
  name: string;
  myRole: TeamRole;
  members: TeamMember[];
}

function normalizeTeam(value: Omit<Team, "members"> & {
  members: Array<Omit<TeamMember, "userName">>;
}): Team {
  return {
    ...value,
    members: value.members.map((member) => ({
      ...member,
      userName: member.nickname || member.username,
    })),
  };
}

export async function listTeams(): Promise<Team[]> {
  const response = await axios.get(buildClientAPIPath("listTeams"));
  return (response.data?.teams ?? []).map(normalizeTeam);
}

export async function createTeam(name: string): Promise<Team> {
  const response = await axios.post(buildClientAPIPath("createTeam"), { name });
  return normalizeTeam(response.data);
}

export async function acceptTeamInvitation(invitationUuid: string): Promise<void> {
  await axios.post(buildClientAPIPath("acceptTeamInvitation", {
    invitation_uuid: invitationUuid,
  }));
}

export async function removeTeamMember(teamUuid: string, userId: number): Promise<void> {
  await axios.delete(buildClientAPIPath("removeTeamMember", {
    team_uuid: teamUuid,
    user_id: userId,
  }));
}

export async function changeTeamMemberRole(
  teamUuid: string,
  userId: number,
  role: Exclude<TeamRole, "owner">,
): Promise<void> {
  await axios.put(buildClientAPIPath("changeTeamMemberRole", {
    team_uuid: teamUuid,
    user_id: userId,
  }), { role });
}

export async function transferTeamOwnership(teamUuid: string, targetUserId: number): Promise<void> {
  await axios.post(buildClientAPIPath("transferTeamOwnership", { team_uuid: teamUuid }), {
    targetUserId,
    confirm: true,
  });
}

export async function dissolveTeam(teamUuid: string): Promise<void> {
  await axios.post(buildClientAPIPath("dissolveTeam", { team_uuid: teamUuid }), { confirm: true });
}
