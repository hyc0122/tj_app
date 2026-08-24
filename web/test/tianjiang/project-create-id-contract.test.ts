// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import axios from "@/utils/axios";

vi.mock("@/utils/axios", () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

import {
  completeLocalProjectInit,
  createProjectWithLocalInit,
  LocalProjectInitError,
  toPositiveSafeIntegerId,
} from "@/features/tianjiang/project/create-project-flow";

const fullFields = {
  name: "契约项目",
  projectType: "novel" as const,
  intro: "简介",
  type: "玄幻",
  artStyle: "art_style_a",
  directorManual: "director_a",
  videoRatio: "16:9",
  imageModel: "img-model",
  videoModel: "vid-model",
  imageQuality: "1K",
  mode: "text",
  scope: "personal" as const,
};

describe("项目创建 id 契约与完整初始化", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(axios.post).mockReset();
  });

  it("精确复现：字符串 localId 不是正安全整数 JSON number", () => {
    expect(() => toPositiveSafeIntegerId("42")).not.toThrow();
    // 发送体必须是 number 类型
    const id = toPositiveSafeIntegerId("42");
    expect(typeof id).toBe("number");
    expect(Number.isSafeInteger(id)).toBe(true);
    expect(id).toBe(42);
    expect(() => toPositiveSafeIntegerId("")).toThrow(/LOCAL_PROJECT_ID/);
    expect(() => toPositiveSafeIntegerId("x")).toThrow(/LOCAL_PROJECT_ID/);
    expect(() => toPositiveSafeIntegerId(0)).toThrow(/LOCAL_PROJECT_ID/);
    expect(() => toPositiveSafeIntegerId(-3)).toThrow(/LOCAL_PROJECT_ID/);
  });

  it("个人项目完整创建：editProject body.id 为 JSON number 且含全字段", async () => {
    const projectUuid = "11111111-1111-4111-a111-111111111111";
    vi.mocked(axios.post).mockImplementation(async (url: string) => {
      if (url === "/tianjiang/v1/projects") {
        return { data: { projectUuid } } as any;
      }
      if (url === "/tianjiang/runtime/projects/refresh") return { data: [] } as any;
      if (url === `/tianjiang/runtime/projects/${projectUuid}/open`) {
        return {
          data: {
            projectUuid,
            project: {
              id: 9001,
              name: "临时名",
              projectType: "novel",
              intro: "",
              type: "",
              artStyle: "",
              directorManual: "",
              videoRatio: "",
              imageModel: "",
              videoModel: "",
              imageQuality: "",
              mode: "",
            },
            accessMode: "readwrite",
          },
        } as any;
      }
      if (url === "/project/editProject") return { data: null } as any;
      if (url === `/tianjiang/runtime/projects/${projectUuid}/sync`) {
        return { data: { state: "synced" } } as any;
      }
      throw new Error(`未预期：${url}`);
    });

    const result = await createProjectWithLocalInit(fullFields);
    expect(result.projectUuid).toBe(projectUuid);
    const editCall = vi.mocked(axios.post).mock.calls.find((c) => c[0] === "/project/editProject");
    expect(editCall).toBeTruthy();
    const body = editCall![1] as Record<string, unknown>;
    expect(typeof body.id).toBe("number");
    expect(body.id).toBe(9001);
    expect(JSON.stringify(body)).toMatch(/"id":9001/);
    expect(JSON.stringify(body)).not.toMatch(/"id":"9001"/);
    for (const key of [
      "name",
      "intro",
      "type",
      "artStyle",
      "directorManual",
      "videoRatio",
      "imageModel",
      "videoModel",
      "imageQuality",
      "mode",
      "projectType",
    ]) {
      expect(body).toHaveProperty(key);
    }
    expect(body.name).toBe(fullFields.name);
    expect(body.artStyle).toBe(fullFields.artStyle);
    expect(body.directorManual).toBe(fullFields.directorManual);
  });

  it("团队 editor 完整创建：scope=team 且含 teamUuid", async () => {
    const projectUuid = "22222222-2222-4222-a222-222222222222";
    const posts: Array<{ url: string; body: any }> = [];
    vi.mocked(axios.post).mockImplementation(async (url: string, body?: any) => {
      posts.push({ url, body });
      if (url === "/tianjiang/v1/projects") return { data: { projectUuid } } as any;
      if (url === "/tianjiang/runtime/projects/refresh") return { data: [] } as any;
      if (url.includes("/open")) {
        return {
          data: {
            projectUuid,
            project: { id: 8002, name: "团队项目", projectType: "script" },
            accessMode: "readwrite",
          },
        } as any;
      }
      if (url === "/project/editProject") return { data: null } as any;
      if (url.endsWith("/sync")) return { data: { state: "published" } } as any;
      throw new Error(url);
    });

    await createProjectWithLocalInit({
      ...fullFields,
      projectType: "script",
      scope: "team",
      teamUuid: "team-editor-1",
    });
    const central = posts.find((p) => p.url === "/tianjiang/v1/projects");
    expect(central?.body).toMatchObject({
      name: fullFields.name,
      scope: "team",
      teamUuid: "team-editor-1",
      businessType: "script",
    });
    const edit = posts.find((p) => p.url === "/project/editProject");
    expect(typeof edit?.body.id).toBe("number");
    expect(edit?.body.projectType).toBe("script");
  });

  it("中央成功、本地失败后重试不得再次中央 POST", async () => {
    const projectUuid = "33333333-3333-4333-a333-333333333333";
    let openFails = true;
    vi.mocked(axios.post).mockImplementation(async (url: string) => {
      if (url === "/tianjiang/v1/projects") return { data: { projectUuid } } as any;
      if (url === "/tianjiang/runtime/projects/refresh") return { data: [] } as any;
      if (url.includes("/open")) {
        if (openFails) throw new Error("项目不存在或不可见");
        return {
          data: {
            projectUuid,
            project: { id: 7003, name: "恢复项目", projectType: "novel" },
            accessMode: "readwrite",
          },
        } as any;
      }
      if (url === "/project/editProject") return { data: null } as any;
      if (url.endsWith("/sync")) return { data: { state: "synced" } } as any;
      throw new Error(url);
    });

    await expect(createProjectWithLocalInit(fullFields)).rejects.toBeInstanceOf(LocalProjectInitError);
    const centralCount1 = vi.mocked(axios.post).mock.calls.filter((c) => c[0] === "/tianjiang/v1/projects").length;
    expect(centralCount1).toBe(1);

    openFails = false;
    vi.mocked(axios.post).mockClear();
    await createProjectWithLocalInit(fullFields, projectUuid);
    const centralCount2 = vi.mocked(axios.post).mock.calls.filter((c) => c[0] === "/tianjiang/v1/projects").length;
    expect(centralCount2).toBe(0);
    expect(vi.mocked(axios.post).mock.calls.map((c) => c[0])).toEqual([
      "/tianjiang/runtime/projects/refresh",
      `/tianjiang/runtime/projects/${projectUuid}/open`,
      "/project/editProject",
      `/tianjiang/runtime/projects/${projectUuid}/sync`,
    ]);
  });

  it("completeLocalProjectInit 顺序：refresh → open → edit，id 为 number", async () => {
    const projectUuid = "44444444-4444-4444-a444-444444444444";
    const order: string[] = [];
    vi.mocked(axios.post).mockImplementation(async (url: string, body?: any) => {
      order.push(url);
      if (url.endsWith("/refresh")) return { data: [] } as any;
      if (url.includes("/open")) {
        return {
          data: {
            projectUuid,
            project: { id: "55005", name: "n", projectType: "novel" },
            accessMode: "readwrite",
          },
        } as any;
      }
      if (url === "/project/editProject") {
        expect(typeof body.id).toBe("number");
        expect(body.id).toBe(55005);
        return { data: null } as any;
      }
      if (url.endsWith("/sync")) return { data: { state: "synced" } } as any;
      throw new Error(url);
    });
    await completeLocalProjectInit(projectUuid, fullFields);
    expect(order[0]).toContain("/refresh");
    expect(order[1]).toContain("/open");
    expect(order[2]).toBe("/project/editProject");
    expect(order[3]).toContain("/sync");
  });
});
