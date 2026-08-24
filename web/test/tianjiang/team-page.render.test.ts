// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessagePlugin } from "tdesign-vue-next";
import zhCN from "@/locales/language/zh-CN.json";

const mocks = vi.hoisted(() => ({
  listTeams: vi.fn(),
  listMyPendingInvitations: vi.fn(),
  invite: vi.fn(),
  createTeam: vi.fn(),
}));

vi.mock("@/features/tianjiang/auth/client", async () => {
  const { shallowRef } = await import("vue");
  return { centralUser: shallowRef({ id: 7, username: "owner", nickname: "负责人" }) };
});

vi.mock("@/features/tianjiang/team/client", () => ({
  listTeams: mocks.listTeams,
  createTeam: mocks.createTeam,
  inviteTeamMember: mocks.invite,
  acceptTeamInvitation: vi.fn(),
  changeTeamMemberRole: vi.fn(),
  removeTeamMember: vi.fn(),
  transferTeamOwnership: vi.fn(),
  dissolveTeam: vi.fn(),
}));

vi.mock("@/features/tianjiang/team/invitations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/tianjiang/team/invitations")>();
  return {
    ...actual,
    listMyPendingInvitations: mocks.listMyPendingInvitations,
    inviteTeamMemberByUsername: mocks.invite,
    acceptInvitation: vi.fn(),
    rejectInvitation: vi.fn(),
  };
});

vi.mock("@/features/tianjiang/profile/client", () => {
  throw new Error("团队页不得访问个人配置 API");
});

import TeamPage from "@/views/team/index.vue";

const stubs = {
  TButton: {
    props: ["loading", "disabled"],
    template: "<button type=\"button\" :disabled=\"loading || disabled\"><slot /></button>",
  },
  TInput: {
    props: ["modelValue"],
    emits: ["update:modelValue"],
    template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  TInputNumber: { template: "<input type=\"number\" />" },
  TSelect: { props: ["options"], template: "<select />" },
  TTag: { template: "<span><slot /></span>" },
  TAlert: { template: "<div><slot /></div>" },
  TLoading: { template: "<div><slot /></div>" },
  TEmpty: { props: ["description"], template: "<div>{{ description }}</div>" },
};

describe("团队管理页", () => {
  beforeEach(() => {
    mocks.listMyPendingInvitations.mockReset().mockResolvedValue([]);
    mocks.createTeam.mockReset().mockResolvedValue({});
    mocks.invite.mockReset().mockResolvedValue({
      invitationUuid: "inv-1",
      status: "pending",
      inviteeUsername: "alice_01",
      teamUuid: "team-owner",
      teamName: "主创团队",
      role: "viewer",
      createdAt: "2026-08-01T00:00:00Z",
    });
    mocks.listTeams.mockReset().mockResolvedValue([
      {
        teamUuid: "team-owner",
        name: "主创团队",
        ownerUserId: 7,
        myRole: "owner",
        status: "active",
        members: [
          { userId: 7, userName: "负责人", role: "owner" },
          { userId: 8, userName: "林编辑", role: "editor" },
          { userId: 9, userName: "周查看", role: "viewer" },
        ],
      },
      {
        teamUuid: "team-editor",
        name: "协作团队",
        ownerUserId: 99,
        myRole: "editor",
        status: "active",
        members: [
          { userId: 99, userName: "其他负责人", role: "owner" },
          { userId: 7, userName: "负责人", role: "editor" },
        ],
      },
      {
        teamUuid: "team-viewer",
        name: "审阅团队",
        ownerUserId: 100,
        myRole: "viewer",
        status: "active",
        members: [
          { userId: 100, userName: "审阅负责人", role: "owner" },
          { userId: 7, userName: "负责人", role: "viewer" },
        ],
      },
    ]);
  });

  it("列出成员姓名、编号和三类角色，只有 owner 团队显示管理动作", async () => {
    const wrapper = mount(TeamPage, {
      global: {
        plugins: [
          createI18n({
            legacy: false,
            locale: "zh-CN",
            messages: { "zh-CN": zhCN },
          }),
        ],
        stubs,
      },
    });
    await flushPromises();

    expect(wrapper.text()).toContain("林编辑");
    expect(wrapper.text()).toContain("用户 8");
    expect(wrapper.text()).toContain("所有者");
    expect(wrapper.text()).toContain("编辑者");
    expect(wrapper.text()).toContain("查看者");

    const cards = wrapper.findAll("article");
    expect(cards[0].text()).toContain("发送邀请");
    expect(cards[0].text()).toContain("转移所有权");
    expect(cards[1].text()).not.toContain("发送邀请");
    expect(cards[1].text()).not.toContain("转移所有权");
    expect(cards[2].text()).not.toContain("发送邀请");
    expect(cards[2].text()).not.toContain("转移所有权");
  });

  it("创建团队失败时使用通用错误，不把 422 误报成受邀用户未注册", async () => {
    const errorSpy = vi.spyOn(MessagePlugin, "error").mockImplementation(() => 0 as any);
    mocks.createTeam.mockRejectedValueOnce({ response: { status: 422 } });
    const wrapper = mount(TeamPage, {
      global: {
        plugins: [
          createI18n({
            legacy: false,
            locale: "zh-CN",
            messages: { "zh-CN": zhCN },
          }),
        ],
        stubs,
      },
    });
    await flushPromises();

    await wrapper.findAll("input")[0].setValue("新团队");
    const create = wrapper.findAll("button").find((button) => button.text() === "创建团队");
    await create!.trigger("click");
    await flushPromises();

    expect(errorSpy).toHaveBeenCalledWith("团队操作失败");
    expect(errorSpy).not.toHaveBeenCalledWith("该用户尚未注册，请核实用户名后再邀请。");
    errorSpy.mockRestore();
  });

  it("邀请成功后在对应团队显示安全状态摘要", async () => {
    const wrapper = mount(TeamPage, {
      global: {
        plugins: [
          createI18n({
            legacy: false,
            locale: "zh-CN",
            messages: { "zh-CN": zhCN },
          }),
        ],
        stubs,
      },
    });
    await flushPromises();

    const inputs = wrapper.findAll("input");
    await inputs[1].setValue("alice_01");
    const invite = wrapper.findAll("button").find((button) => button.text() === "发送邀请");
    await invite!.trigger("click");
    await flushPromises();

    expect(mocks.invite).toHaveBeenCalledWith("team-owner", "alice_01", "viewer");
    expect(wrapper.text()).toContain("alice_01");
    expect(wrapper.text()).toContain("待处理");
  });
});
