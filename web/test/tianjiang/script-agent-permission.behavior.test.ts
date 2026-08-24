/**
 * 剧本 Agent 写权限：必须用 projectStore.canWrite / access.mode。
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import projectStore, { type Project } from "@/stores/project";
import { requestClearScriptAgentMemoryIfAllowed } from "@/features/tianjiang/script-agent/write-access";
import { toLocalProjectId } from "@/features/tianjiang/project/local-project-id";
import { isLegacyProjectMutation } from "@/features/tianjiang/project/access";

const baseProject = (): Project => ({
  id: "101",
  name: "权限测试项目",
  intro: "",
  type: "",
  artStyle: null,
  videoRatio: null,
  createTime: 0,
  updatedAt: 0,
  imageModel: "",
  videoModel: "",
  projectType: "script",
  imageQuality: "",
  mode: "",
  directorManual: "",
  projectUuid: "11111111-1111-4111-a111-111111111111",
});

describe("projectStore.canWrite 为规范权限源", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("activateProject mode=readonly → canWrite=false", () => {
    const store = projectStore();
    store.activateProject(baseProject(), {
      mode: "readonly",
      reason: "viewer_role",
      lockHolder: "",
    });
    expect(store.access.mode).toBe("readonly");
    expect(store.canWrite).toBe(false);
  });

  it("activateProject mode=recovery → canWrite=false", () => {
    const store = projectStore();
    store.activateProject(baseProject(), {
      mode: "recovery",
      reason: "lock_lost",
      lockHolder: "other",
    });
    expect(store.canWrite).toBe(false);
  });

  it("activateProject mode=readwrite → canWrite=true", () => {
    const store = projectStore();
    store.activateProject(baseProject(), {
      mode: "readwrite",
      reason: "owner_lock",
      lockHolder: "",
    });
    expect(store.canWrite).toBe(true);
  });
});

describe("clearMemory HTTP 门禁：只读不得请求", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("readonly：requestClear 不得调用 post", async () => {
    const store = projectStore();
    store.activateProject(baseProject(), {
      mode: "readonly",
      reason: "viewer_role",
      lockHolder: "",
    });
    const post = vi.fn(async () => ({ ok: true }));
    const result = await requestClearScriptAgentMemoryIfAllowed(store.canWrite, post);
    expect(result).toBe("blocked");
    expect(post).not.toHaveBeenCalled();
  });

  it("recovery：requestClear 不得调用 post", async () => {
    const store = projectStore();
    store.activateProject(baseProject(), {
      mode: "recovery",
      reason: "pending_recovery",
      lockHolder: "",
    });
    const post = vi.fn(async () => ({ ok: true }));
    const result = await requestClearScriptAgentMemoryIfAllowed(store.canWrite, post);
    expect(result).toBe("blocked");
    expect(post).not.toHaveBeenCalled();
  });

  it("readwrite：允许调用 post 一次", async () => {
    const store = projectStore();
    store.activateProject(baseProject(), {
      mode: "readwrite",
      reason: "editor_lock",
      lockHolder: "",
    });
    const post = vi.fn(async () => ({ ok: true }));
    const result = await requestClearScriptAgentMemoryIfAllowed(store.canWrite, post);
    expect(result).toBe("ok");
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe("只读路由分类与 ID 边界", () => {
  it("getPlanData/getMemory 为读取；setPlanData/clearMemory 为写", () => {
    expect(isLegacyProjectMutation("POST", "/scriptAgent/getPlanData")).toBe(false);
    expect(isLegacyProjectMutation("POST", "/agents/getMemory")).toBe(false);
    expect(isLegacyProjectMutation("POST", "/project/getModelDetails")).toBe(false);
    expect(isLegacyProjectMutation("POST", "/scriptAgent/setPlanData")).toBe(true);
    expect(isLegacyProjectMutation("POST", "/agents/clearMemory")).toBe(true);
  });

  it("Project.id 字符串经 toLocalProjectId 变为 number", () => {
    expect(toLocalProjectId("101")).toBe(101);
    expect(toLocalProjectId(baseProject().id)).toBe(101);
  });
});
