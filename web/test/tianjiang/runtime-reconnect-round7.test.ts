// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import projectStore from "@/stores/project";
import {
  isRetryableLocalRuntimeFailure,
} from "@/features/tianjiang/runtime/request-recovery";
import {
  recoverActiveProjectAfterRuntimeRestart,
} from "@/features/tianjiang/runtime/project-recovery";

const projectUuid = "88888888-8888-4888-a888-888888888888";

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("Electron 本地运行时断线恢复", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("只重试 Electron 环回本地服务的无响应网络错误", () => {
    expect(isRetryableLocalRuntimeFailure({
      message: "Network Error",
      config: { baseURL: "http://127.0.0.1:10588/api" },
    }, true)).toBe(true);
    expect(isRetryableLocalRuntimeFailure({
      code: "ECONNREFUSED",
      config: { baseURL: "http://127.0.0.1:10588/api" },
    }, true)).toBe(true);

    // 中央 API、HTTP 业务错误以及已经重试过的请求都不得套用本地端口恢复。
    expect(isRetryableLocalRuntimeFailure({
      message: "Network Error",
      config: { baseURL: "https://api.example.com/api" },
    }, true)).toBe(false);
    expect(isRetryableLocalRuntimeFailure({
      message: "Request failed",
      response: { status: 503 },
      config: { baseURL: "http://127.0.0.1:10588/api" },
    }, true)).toBe(false);
    expect(isRetryableLocalRuntimeFailure({
      message: "Network Error",
      config: {
        baseURL: "http://127.0.0.1:10588/api",
        __tianjiangRuntimeRetried: true,
      },
    }, true)).toBe(false);
  });

  it("新运行时缺少活动项目时必须重新 open 并恢复访问态", async () => {
    const store = projectStore();
    store.activateProject({
      id: "81",
      name: "断线恢复项目",
      intro: "",
      type: "",
      artStyle: null,
      videoRatio: null,
      createTime: 1,
      updatedAt: 1,
      imageModel: "",
      videoModel: "",
      projectType: "novel",
      imageQuality: "1K",
      mode: "",
      directorManual: "",
      projectUuid,
    }, {
      projectUuid,
      mode: "readonly",
      reason: "runtime_unreachable",
      lockHolder: "",
    });
    const openProject = vi.fn().mockResolvedValue({
      projectUuid,
      project: { ...store.project, id: "81", projectUuid },
      accessMode: "readwrite",
      readonlyReason: "",
      lockHolder: "",
    });

    await recoverActiveProjectAfterRuntimeRestart(projectUuid, { openProject });

    expect(openProject).toHaveBeenCalledOnce();
    expect(store.access).toMatchObject({
      projectUuid,
      mode: "readwrite",
      reason: "",
    });
  });

  it("并发访问轮询只能发起一次项目重开", async () => {
    let resolveOpen!: (value: any) => void;
    const openProject = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveOpen = resolve;
    }));

    const first = recoverActiveProjectAfterRuntimeRestart(projectUuid, { openProject });
    const second = recoverActiveProjectAfterRuntimeRestart(projectUuid, { openProject });
    expect(openProject).toHaveBeenCalledOnce();

    resolveOpen({
      projectUuid,
      project: {
        id: "82",
        name: "并发恢复项目",
        projectType: "novel",
      },
      accessMode: "readwrite",
      readonlyReason: "",
      lockHolder: "",
    });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("全局请求层只重试一次，工作台缺项目时接入自动重开", () => {
    const axiosSource = source("src/utils/axios.ts");
    const workbenchSource = source("src/pages/workbench/index.vue");

    expect(axiosSource).toContain("discoverRuntimeConnectionSingleFlight");
    expect(axiosSource).toContain("__tianjiangRuntimeRetried");
    expect(axiosSource).toContain("instance.request");
    expect(workbenchSource).toContain("recoverActiveProjectAfterRuntimeRestart");
    expect(workbenchSource).not.toContain('setAccessMode("readonly", "project_closed")');
  });
});
