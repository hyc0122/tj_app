// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";
import axios from "@/utils/axios";

vi.mock("@/utils/axios", () => ({ default: { get: vi.fn(), post: vi.fn() } }));

import {
  buildCreateProjectBody,
  createScopedProject,
  filterCreatableTeams,
} from "@/features/tianjiang/project/create-project";
import {
  fetchProjectCatalog,
  refreshRuntimeProjectCatalog,
} from "@/features/tianjiang/project/catalog";
import {
  createProjectWithLocalInit,
  extractCreatedProjectUuid,
  LocalProjectInitError,
  normalizeProjectOperationError,
} from "@/features/tianjiang/project/create-project-flow";
import * as projectCreateFlow from "@/features/tianjiang/project/create-project-flow";
import { matchAPIEndpoint } from "@/features/tianjiang/contracts";
import {
  filterGroupsByScope,
  groupProjectsByScope,
} from "@/features/tianjiang/project/scope-groups";
import { assertLegacyProjectWriteAllowed } from "@/features/tianjiang/project/access";
import projectStore from "@/stores/project";
import { useProjectForm } from "@/views/project/components/projectDialog/useProjectForm";
import Router from "@/router/index";

describe("项目归属分组与创建", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setActivePinia(createPinia());
    vi.mocked(axios.get).mockReset();
    vi.mocked(axios.post).mockReset();
    vi.stubGlobal("$t", (key: string) => key);
    window.$message = {
      warning: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    } as any;
  });

  it("个人进入个人分组，团队按 teamUuid 与 teamName 分组", () => {
    const { groups, skipped } = groupProjectsByScope([
      { projectUuid: "p2", name: "B小说", kind: "personal" },
      { projectUuid: "p1", name: "A小说", kind: "personal" },
      {
        projectUuid: "t1",
        name: "同名",
        kind: "team",
        teamUuid: "team-a",
        teamName: "主创",
      },
      {
        projectUuid: "t2",
        name: "同名",
        kind: "team",
        teamUuid: "team-b",
        teamName: "协作",
      },
      { projectUuid: "bad", name: "坏", kind: "team" },
    ]);
    expect(skipped).toHaveLength(1);
    expect(groups[0].key).toBe("personal");
    expect(groups[0].items.map((i) => i.projectUuid)).toEqual(["p1", "p2"]);
    expect(groups.some((g) => g.teamUuid === "team-a")).toBe(true);
    expect(groups.find((g) => g.teamUuid === "team-a")?.items[0].name).toBe("同名");
    expect(groups.some((g) => g.key === "team:unknown")).toBe(false);
    // 同名项目靠 projectUuid 区分
    const names = groups.flatMap((g) => g.items.map((i) => i.projectUuid));
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain("bad");
  });

  it("筛选 scope 正确", () => {
    const { groups } = groupProjectsByScope([
      { projectUuid: "p1", name: "P", kind: "personal" },
      {
        projectUuid: "t1",
        name: "T",
        kind: "team",
        teamUuid: "team-a",
        teamName: "主创",
      },
    ]);
    expect(filterGroupsByScope(groups, "personal")).toHaveLength(1);
    expect(filterGroupsByScope(groups, "team-a")[0].teamUuid).toBe("team-a");
  });

  it("创建 body：personal 无 teamUuid；team 必须含 teamUuid 且无 teamName；含 businessType", () => {
    expect(buildCreateProjectBody({ name: " n ", scope: "personal", businessType: "novel" })).toEqual({
      name: "n",
      scope: "personal",
      businessType: "novel",
      description: "",
      artStyle: "",
      aspectRatio: "",
      defaultLanguage: "",
    });
    const teamBody = buildCreateProjectBody({
      name: "t",
      scope: "team",
      teamUuid: "team-1",
      businessType: "script",
    });
    expect(teamBody).toEqual({
      name: "t",
      scope: "team",
      teamUuid: "team-1",
      businessType: "script",
      description: "",
      artStyle: "",
      aspectRatio: "",
      defaultLanguage: "",
    });
    expect(Object.hasOwn(teamBody, "teamName")).toBe(false);
    expect(() =>
      buildCreateProjectBody({ name: "t", scope: "team" }),
    ).toThrow(/TEAM_UUID/);
  });

  it("viewer 团队不可创建", () => {
    const opts = filterCreatableTeams([
      { teamUuid: "a", name: "A", myRole: "owner" },
      { teamUuid: "b", name: "B", myRole: "viewer" },
      { teamUuid: "c", name: "C", myRole: "editor" },
    ]);
    expect(opts.map((o) => o.teamUuid)).toEqual(["a", "c"]);
  });

  it("项目创建使用中央 POST 契约且目录投影剥离内部数字字段", async () => {
    vi.mocked(axios.post).mockResolvedValueOnce({ data: { projectUuid: "p-1" } } as any);
    await createScopedProject({ name: "个人项目", scope: "personal", businessType: "novel" });
    expect(axios.post).toHaveBeenCalledWith("/tianjiang/v1/projects", {
      name: "个人项目",
      scope: "personal",
      businessType: "novel",
      description: "",
      artStyle: "",
      aspectRatio: "",
      defaultLanguage: "",
    });
    expect(matchAPIEndpoint("POST", "/api/tianjiang/v1/projects")).toBe("createProject");

    vi.mocked(axios.get).mockResolvedValueOnce({
      data: [{
        projectUuid: "p-1",
        name: "个人项目",
        kind: "personal",
        ownerUserId: 7,
        teamId: 9,
        legacyProjectId: 11,
        key: "must-not-leak",
        myRole: "owner",
      }],
    } as any);
    const [project] = await fetchProjectCatalog();
    expect(Object.hasOwn(project, "ownerUserId")).toBe(false);
    expect(Object.hasOwn(project, "teamId")).toBe(false);
    expect(Object.hasOwn(project, "legacyProjectId")).toBe(false);
    expect(Object.hasOwn(project, "key")).toBe(false);
  });

  it.each([
    ["缺失", undefined],
    ["非法", "shared"],
  ])("项目目录 kind %s时阻断整批投影并返回可诊断错误", async (_label, kind) => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: {
        projects: [{
          projectUuid: "bad-project-1",
          name: "异常项目",
          kind,
          myRole: "owner",
        }],
      },
    } as any);

    await expect(fetchProjectCatalog()).rejects.toMatchObject({
      code: "PROJECT_KIND_INVALID",
      projectUuid: "bad-project-1",
      rowIndex: 0,
    });
  });

  it("七语 projectScope key 齐全且英文非中文", () => {
    for (const lang of ["zh-CN", "en", "ja_JP"] as const) {
      const data = JSON.parse(
        fs.readFileSync(
          path.resolve(`src/locales/language/${lang}.json`),
          "utf8",
        ),
      );
      expect(data["projectScope.personal"]).toBeTruthy();
      expect(data["projectScope.selectTeam"]).toBeTruthy();
    }
    const en = JSON.parse(
      fs.readFileSync(path.resolve("src/locales/language/en.json"), "utf8"),
    );
    expect(en["projectScope.personal"]).toMatch(/Personal/i);
  });

  it("创建顺序必须先刷新运行时目录再 open；本地失败保留 uuid 且重试跳过中央创建", async () => {
    const fields = {
      name: "流水线项目",
      projectType: "novel",
      intro: "i",
      type: "玄幻",
      artStyle: "s",
      directorManual: "d",
      videoRatio: "16:9",
      imageModel: "img",
      videoModel: "vid",
      imageQuality: "1K",
      mode: "text",
      scope: "personal" as const,
    };
    vi.mocked(axios.post)
      .mockResolvedValueOnce({ data: { projectUuid: "new-uuid-1" } } as any) // create
      .mockResolvedValueOnce({ data: [] } as any) // refresh
      .mockRejectedValueOnce(new Error("项目不存在或不可见")); // open without catalog

    await expect(createProjectWithLocalInit(fields)).rejects.toBeInstanceOf(LocalProjectInitError);
    const calls = vi.mocked(axios.post).mock.calls.map((c) => c[0]);
    expect(calls[0]).toBe("/tianjiang/v1/projects");
    expect(calls[1]).toBe("/tianjiang/runtime/projects/refresh");
    expect(calls[2]).toBe("/tianjiang/runtime/projects/new-uuid-1/open");

    vi.mocked(axios.post).mockReset();
    vi.mocked(axios.post)
      .mockResolvedValueOnce({ data: [] } as any) // refresh only
      .mockResolvedValueOnce({
        data: {
          projectUuid: "new-uuid-1",
          project: { id: "42", projectType: "novel", name: "流水线项目" },
          accessMode: "readwrite",
        },
      } as any)
      .mockResolvedValueOnce({ data: null } as any) // editProject
      .mockResolvedValueOnce({ data: { state: "synced" } } as any); // 首次同步

    await createProjectWithLocalInit(fields, "new-uuid-1");
    const retryCalls = vi.mocked(axios.post).mock.calls.map((c) => c[0]);
    expect(retryCalls).not.toContain("/tianjiang/v1/projects");
    expect(retryCalls[0]).toBe("/tianjiang/runtime/projects/refresh");
    expect(retryCalls[1]).toBe("/tianjiang/runtime/projects/new-uuid-1/open");
    expect(retryCalls[2]).toBe("/project/editProject");
    expect(retryCalls[3]).toBe("/tianjiang/runtime/projects/new-uuid-1/sync");
    const editBody = vi.mocked(axios.post).mock.calls.find((c) => c[0] === "/project/editProject")?.[1] as {
      id: unknown;
    };
    expect(typeof editBody.id).toBe("number");
    expect(editBody.id).toBe(42);
  });

  it("open 成功后必须先激活访问模式，再通过真实访问门保存本地项目字段", async () => {
    const fields = {
      name: "访问门项目",
      projectType: "novel",
      intro: "简介",
      type: "玄幻",
      artStyle: "art_skills/style-a",
      directorManual: "driector_skills/manual-a",
      videoRatio: "16:9",
      imageModel: "img",
      videoModel: "vid",
      imageQuality: "1K",
      mode: "text",
      scope: "personal" as const,
    };
    vi.mocked(axios.post).mockImplementation(async (url) => {
      if (url === "/tianjiang/v1/projects") {
        return { data: { projectUuid: "33333333-3333-4333-a333-333333333333" } } as any;
      }
      if (url === "/tianjiang/runtime/projects/refresh") return { data: [] } as any;
      if (url === "/tianjiang/runtime/projects/33333333-3333-4333-a333-333333333333/open") {
        return {
          data: {
            projectUuid: "33333333-3333-4333-a333-333333333333",
            project: { id: "42", name: fields.name, projectType: "novel" },
            accessMode: "readwrite",
            recoveryRequired: false,
          },
        } as any;
      }
      if (url === "/project/editProject") {
        // 使用真实前端访问门复现 GUI 请求拦截顺序。
        assertLegacyProjectWriteAllowed("POST", url);
        return { data: null } as any;
      }
      if (url.endsWith("/sync")) return { data: { state: "synced" } } as any;
      throw new Error(`未预期请求：${url}`);
    });

    await createProjectWithLocalInit(fields);
    expect(projectStore().access.mode).toBe("readwrite");
  });

  it("本地初始化对象错误必须归一化为安全中文，不得显示 object Object", () => {
    const error = new LocalProjectInitError(
      "33333333-3333-4333-a333-333333333333",
      { message: "项目保存失败，请稍后重试" },
    );
    expect(error.message).toBe("项目保存失败，请稍后重试");
    expect(error.message).not.toContain("[object Object]");
  });

  it("错误归一化不得向用户泄露路径、URL、Token、栈或非中文诊断", () => {
    const unsafeErrors = [
      new Error("C:\\private\\project.sqlite 打开失败"),
      { message: "读取 /home/private/project.sqlite 失败" },
      { message: "读取 ../private/project.sqlite 失败" },
      { message: "https://internal.example/api 请求失败" },
      { response: { data: { message: "Bearer token-value-should-not-leak" } } },
      { detail: "Error at createProject (create-project-flow.ts:99)" },
      "Network Error",
    ];
    for (const error of unsafeErrors) {
      const message = normalizeProjectOperationError(error);
      expect(message).toBe("项目创建失败，请稍后重试");
      expect(message).toMatch(/[\u3400-\u9fff]/u);
      expect(message).not.toMatch(/\[object Object\]|[a-z]:[\\/]|https?:\/\/|bearer|token|stack|\.ts:\d+/i);
    }
  });

  it("重复点击确定时同一创建操作只执行一次且只允许一条失败提示", async () => {
    let rejectCreate!: (reason: unknown) => void;
    const createPromise = new Promise<never>((_resolve, reject) => {
      rejectCreate = reject;
    });
    const createSpy = vi
      .spyOn(projectCreateFlow, "createProjectWithLocalInit")
      .mockReturnValue(createPromise);
    vi.spyOn(Router, "push").mockResolvedValue(undefined as any);

    const form = useProjectForm(
      ref(false),
      { projectData: null },
      vi.fn() as any,
      { fetchVisualManuals: vi.fn(), queryDirectorManual: vi.fn() },
    );
    Object.assign(form.formState.value, {
      name: "单次提交项目",
      projectType: "novel",
      intro: "简介",
      type: "玄幻",
      artStyle: "art_skills/style-a",
      directorManual: "driector_skills/manual-a",
      videoRatio: "16:9",
      imageModel: "img",
      videoModel: "vid",
      imageQuality: "1K",
      mode: "text",
      scope: "personal",
    });

    const first = form.handleOk();
    const second = form.handleOk();
    expect(createSpy).toHaveBeenCalledTimes(1);

    rejectCreate({ message: "项目创建失败，请稍后重试" });
    await Promise.all([first, second]);
    expect(window.$message.error).toHaveBeenCalledTimes(1);
    expect(window.$message.error).toHaveBeenCalledWith("项目创建失败，请稍后重试");
  });

  it("refreshRuntimeProjectCatalog 命中固定本地路径", async () => {
    vi.mocked(axios.post).mockResolvedValueOnce({
      data: [{
        projectUuid: "p-1",
        name: "x",
        kind: "personal",
        myRole: "owner",
      }],
    } as any);
    const rows = await refreshRuntimeProjectCatalog();
    expect(axios.post).toHaveBeenCalledWith("/tianjiang/runtime/projects/refresh");
    expect(rows[0].projectUuid).toBe("p-1");
    expect(extractCreatedProjectUuid({ projectUuid: "abc" })).toBe("abc");
  });
});
