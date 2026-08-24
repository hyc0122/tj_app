// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import axios from "@/utils/axios";
import {
  API_CONTRACT,
  buildClientAPIPath,
  matchAPIEndpoint,
} from "@/features/tianjiang/contracts";

vi.mock("@/utils/axios", () => ({ default: { get: vi.fn(), post: vi.fn() } }));

import {
  buildInviteBody,
  inviteTeamMemberByUsername,
  listMyPendingInvitations,
  mapInvitationErrorKey,
  projectPendingInvitation,
  rejectInvitation,
} from "@/features/tianjiang/team/invitations";

describe("团队邀请契约", () => {
  beforeEach(() => {
    vi.mocked(axios.get).mockReset();
    vi.mocked(axios.post).mockReset();
  });

  it("invite body 为 username+role 且不含 userId", () => {
    const body = buildInviteBody(" Alice_01 ", "editor");
    expect(body).toEqual({ username: "alice_01", role: "editor" });
    expect(Object.hasOwn(body, "userId")).toBe(false);
  });

  it("pending 投影含 invitationUuid/用户名/团队名/角色/时间并剥离敏感字段", () => {
    const row = projectPendingInvitation({
      invitationUuid: "inv-1",
      teamUuid: "team-1",
      teamName: "主创",
      role: "editor",
      inviterUsername: "owner1",
      inviteeUsername: "alice",
      createdAt: "2026-08-01T00:00:00Z",
      password: "x",
      token: "t",
      secret: "s",
    });
    expect(row.invitationUuid).toBe("inv-1");
    expect(row.teamName).toBe("主创");
    expect(row.inviteeUsername).toBe("alice");
    expect(row.role).toBe("editor");
    expect(row.createdAt).toBeTruthy();
    expect(Object.hasOwn(row as object, "password")).toBe(false);
    expect(Object.hasOwn(row as object, "token")).toBe(false);
  });

  it("错误码映射到固定 i18n key", () => {
    expect(mapInvitationErrorKey({ code: "INVITEE_NOT_REGISTERED" })).toBe(
      "teamPage.error.inviteeNotRegistered",
    );
    expect(mapInvitationErrorKey({ response: { status: 409 } })).toBe(
      "teamPage.error.memberExists",
    );
  });

  it("运行时契约登记 username、pending 列表和 reject 路径", () => {
    expect(API_CONTRACT.endpoints.inviteTeamMember.requestFields).toEqual([
      "username",
      "role",
    ]);
    expect(buildClientAPIPath("listTeamInvitations")).toBe(
      "/tianjiang/v1/team-invitations",
    );
    expect(buildClientAPIPath("rejectTeamInvitation", {
      invitation_uuid: "inv-1",
    })).toBe("/tianjiang/v1/team-invitations/inv-1/reject");
    expect(matchAPIEndpoint("GET", "/api/tianjiang/v1/team-invitations")).toBe(
      "listTeamInvitations",
    );
    expect(
      matchAPIEndpoint("POST", "/api/tianjiang/v1/team-invitations/inv-1/reject"),
    ).toBe("rejectTeamInvitation");
  });

  it("pending 和 reject 使用契约路径，邀请成功只返回安全公开字段", async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({ data: { invitations: [] } } as any);
    await listMyPendingInvitations();
    expect(axios.get).toHaveBeenCalledWith("/tianjiang/v1/team-invitations", {
      params: { status: "pending" },
    });

    vi.mocked(axios.post).mockResolvedValueOnce({ data: {} } as any);
    await rejectInvitation("inv/1");
    expect(axios.post).toHaveBeenCalledWith(
      "/tianjiang/v1/team-invitations/inv%2F1/reject",
    );

    vi.mocked(axios.post).mockResolvedValueOnce({
      data: {
        invitationUuid: "inv-1",
        status: "pending",
        inviteeUsername: "alice_01",
        teamUuid: "team-1",
        teamName: "主创",
        role: "editor",
        createdAt: "2026-08-01T00:00:00Z",
        key: "must-not-leak",
        token: "must-not-leak",
      },
    } as any);
    const result = await inviteTeamMemberByUsername("team-1", " Alice_01 ", "editor");
    expect(result).toEqual({
      invitationUuid: "inv-1",
      status: "pending",
      inviteeUsername: "alice_01",
      teamUuid: "team-1",
      teamName: "主创",
      role: "editor",
      createdAt: "2026-08-01T00:00:00Z",
    });
  });

  it("团队页不再要求输入团队编号加入", () => {
    const src = fs.readFileSync(
      path.resolve("src/views/team/index.vue"),
      "utf8",
    );
    expect(src).not.toMatch(/invitationPlaceholder/);
    expect(src).not.toMatch(/输入邀请编号|团队编号加入/);
    expect(src).toMatch(/PendingInvitations/);
    expect(src).toMatch(/TeamMemberInviteForm/);
    expect(src).toMatch(/listMyPendingInvitations|loadPending/);
  });

  it("七语文案包含邀请待办 key", () => {
    const langs = [
      "zh-CN",
      "zh-TW",
      "en",
      "ja_JP",
      "ru_RU",
      "th_TH",
      "vi-VN",
    ];
    for (const lang of langs) {
      const data = JSON.parse(
        fs.readFileSync(
          path.resolve(`src/locales/language/${lang}.json`),
          "utf8",
        ),
      );
      expect(data["teamPage.pending.title"]).toBeTruthy();
      expect(data["teamPage.inviteeUsernamePlaceholder"]).toBeTruthy();
      expect(data["teamPage.invitationResult"]).toBeTruthy();
      expect(data["teamPage.invitationStatus.pending"]).toBeTruthy();
      // 非中文不得用中文值冒充完成
      if (lang === "en") {
        expect(data["teamPage.pending.title"]).toMatch(/Pending|invitation/i);
      }
    }
  });
});
