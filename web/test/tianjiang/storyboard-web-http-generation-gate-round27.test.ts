// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createPinia, setActivePinia } from "pinia";
import type { AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig } from "axios";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import zhCN from "@/locales/language/zh-CN.json";
import StoryboardSettings from "@/views/storyboardProject/components/StoryboardSettings.vue";

type CapturedHttpCall = {
  method: "GET" | "POST" | "DELETE";
  url: string;
  body?: unknown;
  status: number;
  response: unknown;
  dropped: boolean;
  preserveResponse: boolean;
};

const adapterState = {
  origin: "",
  dropNextGenerateResponse: false,
  calls: [] as CapturedHttpCall[],
};

import axios from "@/utils/axios";
import projectStore from "@/stores/project";
import {
  buildGenerationPreviewBody,
  requestStoryboardGenerationPreview,
  resolvedStoryboardGenerationMode,
  type StoryboardGenerationPreviewInput,
} from "@/views/storyboardProject/storyboard-generation-preview";
import { normalizeStoryboardGenerationResponse } from "@/views/storyboardProject/storyboard-generation-response";
import { useStoryboardWorkspace } from "@/views/storyboardProject/useStoryboardWorkspace";

const originalAxiosAdapter = axios.defaults.adapter;

type FixtureReady = {
  ready: true;
  origin: string;
  projectUuid: string;
  firstShotUuid: string;
  secondShotUuid: string;
  vendorModel: string;
};

type FixtureState = {
  taskCount: number;
  operationCount: number;
  candidateCount: number;
  dispatchCount: number;
  cliInvocationCount: number;
  externalNetworkCallCount: number;
  tasks: Array<{ taskUuid: string; clientOperationId: string | null; status: string }>;
  operations: Array<{ clientOperationId: string; state: string; itemCount: number }>;
  dispatches: Array<{ taskUuid: string; clientOperationId: string | null; queueState: string }>;
  candidates: Array<{ candidateUuid: string; shotUuid: string; mediaType: string }>;
};

const firstOperationId = "91919191-9191-4191-a191-919191919191";
const secondOperationId = "92929292-9292-4292-a292-929292929292";
const batchOperationId = "93939393-9393-4393-a393-939393939393";
const recoveryOperationId = "94949494-9494-4494-a494-949494949494";
const comparisonOperationId = "95959595-9595-4595-a595-959595959595";
const vendorSingleOperationId = "96969696-9696-4696-a696-969696969696";
const vendorBatchOperationId = "97979797-9797-4797-a797-979797979797";
const invalidVendorModelOperationId = "98989898-9898-4898-a898-989898989898";

let fixtureProcess: ChildProcessWithoutNullStreams | undefined;
let fixtureRoot = "";
let fixture: FixtureReady;

function waitForFixture(child: ChildProcessWithoutNullStreams): Promise<FixtureReady> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(`App 联合夹具启动超时: ${stderr || stdout}`)), 30_000);
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim().startsWith("{\"ready\"")) continue;
        try {
          const ready = JSON.parse(line) as FixtureReady;
          if (ready.ready) {
            clearTimeout(timeout);
            resolve(ready);
          }
        } catch {
          // 中文注释：生产日志可能与就绪行相邻，只接受完整 JSON 就绪帧。
        }
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`App 联合夹具提前退出 code=${code}: ${stderr || stdout}`));
    });
  });
}

function envelopeData(payload: unknown): any {
  return payload && typeof payload === "object" && "data" in payload
    ? (payload as { data: unknown }).data
    : payload;
}

async function waitUntil(label: string, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(label);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await flushPromises();
  }
}

function generateCalls(operationId: string): CapturedHttpCall[] {
  return adapterState.calls.filter((call) => {
    if (call.method !== "POST" || !call.url.endsWith("/storyboard/generate")) return false;
    const body = call.body as { clientOperationId?: unknown } | undefined;
    return body?.clientOperationId === operationId;
  });
}

function strict200Tasks(
  call: CapturedHttpCall,
  operationId: string,
): Array<Record<string, unknown>> {
  const payload = envelopeData(call.response);
  expect(Array.isArray(payload)).toBe(true);
  const tasks = payload as Array<Record<string, unknown>>;
  expect(tasks.length).toBeGreaterThan(0);
  expect(tasks.every((row) => row.clientOperationId === operationId)).toBe(true);
  return tasks;
}

function parseAdapterBody(data: unknown): unknown {
  if (typeof data !== "string") return data;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

function installRealAxiosCaptureAdapter(): void {
  // 中文注释：只替换网络适配器，保留 @/utils/axios 的真实请求/响应拦截器；
  // 因此未声明 preserveResponse 的成功请求会像生产一样只拿到 response.data。
  axios.defaults.adapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    const method = String(config.method ?? "get").toUpperCase() as CapturedHttpCall["method"];
    const url = String(config.url ?? "");
    const body = parseAdapterBody(config.data);
    const response = await fetch(`${adapterState.origin}/api${url}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(config.data === undefined ? {} : {
        body: typeof config.data === "string" ? config.data : JSON.stringify(config.data),
      }),
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    const dropped = method === "POST"
      && url.endsWith("/storyboard/generate")
      && adapterState.dropNextGenerateResponse;
    const preserveResponse = (config as AxiosRequestConfig & { preserveResponse?: boolean })
      .preserveResponse === true;
    adapterState.calls.push({
      method,
      url,
      body,
      status: response.status,
      response: payload,
      dropped,
      preserveResponse,
    });
    const axiosResponse: AxiosResponse = {
      data: payload,
      status: response.status,
      statusText: response.statusText,
      headers: {},
      config,
      request: undefined,
    };
    if (dropped) {
      adapterState.dropNextGenerateResponse = false;
      throw Object.assign(new Error("模拟生成响应在客户端收到前丢失"), {
        code: "ERR_NETWORK",
        config,
      });
    }
    if (!response.ok) {
      throw Object.assign(new Error(`HTTP ${response.status}`), {
        config,
        response: axiosResponse,
        status: response.status,
      });
    }
    return axiosResponse;
  };
}

async function fixtureState(): Promise<FixtureState> {
  const response = await fetch(`${fixture.origin}/__test/state`);
  const payload = await response.json() as { data: FixtureState };
  expect(response.status).toBe(200);
  return payload.data;
}

function previewInput(
  shotUuid: string,
  providerModel = "dreamina-cli:seedance2.0fast",
  durationMs = 9_000,
): StoryboardGenerationPreviewInput {
  return {
    shotUuid,
    mediaType: "video",
    providerModel,
    mode: "text2video",
    durationMs,
    aspectRatio: "9:16",
    shot: {
      sourceText: "浏览器生产请求",
      videoPrompt: "不得由测试复制生成协议",
    },
  };
}

function vendorPreviewInput(shotUuid: string): StoryboardGenerationPreviewInput {
  return {
    shotUuid,
    mediaType: "image",
    providerModel: fixture.vendorModel,
    mode: "text2image",
    aspectRatio: "16:9",
    shot: {
      sourceText: "本地普通供应商响应形状门禁",
      imagePrompt: "只生成内置 1px 图片，不允许外调",
      aspectRatio: "16:9",
    },
  };
}

async function rawPreview(input: StoryboardGenerationPreviewInput): Promise<{
  body: Record<string, unknown>;
  status: number;
  data: Record<string, unknown>;
}> {
  // 中文注释：body 必须来自 Web 生产序列化器，不允许测试手写一份相似 JSON。
  const body = buildGenerationPreviewBody(input);
  const response = await axios.post(
    `/tianjiang/runtime/projects/${fixture.projectUuid}/storyboard/generate/preview`,
    body,
  );
  const call = adapterState.calls.at(-1);
  if (!call || !call.url.endsWith("/storyboard/generate/preview")) {
    throw new Error("未捕获到真实 preview HTTP 调用");
  }
  return {
    // 中文注释：返回适配器实际收到的请求体，避免用本地变量自证序列化正确。
    body: call.body as Record<string, unknown>,
    status: call.status,
    data: envelopeData(response) as Record<string, unknown>,
  };
}

async function previewConfirmation(input: StoryboardGenerationPreviewInput) {
  // 中文注释：正式 body 的确认材料必须先通过 Web 生产 preview normalizer，摘要缺失时立即失败关闭。
  const preview = await requestStoryboardGenerationPreview(fixture.projectUuid, input);
  const mode = resolvedStoryboardGenerationMode(preview, input.mediaType);
  return {
    preview,
    formal: {
      providerModel: input.providerModel,
      routeKind: preview.routeKind,
      mode,
      durationMs: Number(preview.options.durationMs),
      aspectRatio: String(preview.options.aspectRatio),
      resolution: String(preview.options.resolution),
      expectedPreviewDigest: preview.previewDigest,
    },
  };
}

function downstreamDigestForLegacyRedOnly(preview: Record<string, unknown>): string {
  const digest = preview.previewDigest;
  if (typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest)) return digest;
  // 中文注释：只用于让旧后端继续暴露“响应形状”第二层 RED；严格 preview 用例仍会失败，
  // 最终 GREEN 必须走服务端真实摘要，本占位值绝不能作为 Web 确认材料。
  return "0".repeat(64);
}

async function postRawGeneration(body: Record<string, unknown>): Promise<{
  status: number;
  data: unknown;
}> {
  const response = await fetch(
    `${fixture.origin}/api/tianjiang/runtime/projects/${fixture.projectUuid}/storyboard/generate`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const payload = await response.json();
  return { status: response.status, data: envelopeData(payload) };
}

function createWorkspace() {
  setActivePinia(createPinia());
  const store = projectStore();
  store.project = {
    projectUuid: fixture.projectUuid,
    name: "Round27 Web HTTP 联合门禁",
    projectType: "storyboard",
    myRole: "owner",
    openMode: "readwrite",
  } as never;
  store.access = {
    projectUuid: fixture.projectUuid,
    mode: "readwrite",
    reason: "joint_contract_test",
    lockHolder: "",
  } as never;
  return useStoryboardWorkspace();
}

beforeAll(async () => {
  const webRoot = path.resolve(__dirname, "../..");
  const repoRoot = path.resolve(webRoot, "..");
  const temporaryRoot = path.resolve(repoRoot, ".tmp");
  fs.mkdirSync(temporaryRoot, { recursive: true });
  fixtureRoot = fs.mkdtempSync(path.join(temporaryRoot, "web-http-generation-gate-"));
  const tsxCli = path.resolve(repoRoot, "app", "node_modules", "tsx", "dist", "cli.mjs");
  const fixtureFile = path.resolve(
    repoRoot,
    "app",
    "test",
    "tianjiang",
    "fixtures",
    "storyboard-web-http-gate-server.ts",
  );
  const appTsconfig = path.resolve(repoRoot, "app", "tsconfig.json");
  // 中文注释：夹具 cwd 必须留在 E 盘隔离数据目录，同时显式指定 App tsconfig 解析 @/ 别名。
  fixtureProcess = spawn(process.execPath, [tsxCli, "--tsconfig", appTsconfig, fixtureFile], {
    cwd: path.resolve(repoRoot, "app"),
    env: {
      ...process.env,
      TEMP: fixtureRoot,
      TMP: fixtureRoot,
      STORYBOARD_GATE_DATA_ROOT: fixtureRoot,
      TIANJIANG_TEST_DATA_ROOT: path.join(fixtureRoot, "data"),
      TIANJIANG_TEST_WORKTREE_ROOT: repoRoot,
      NODE_ENV: "prod",
      NODE_TEST_CONTEXT: "storyboard-web-http-generation-gate-round27",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  fixture = await waitForFixture(fixtureProcess);
  adapterState.origin = fixture.origin;
  setActivePinia(createPinia());
  installRealAxiosCaptureAdapter();
}, 40_000);

afterAll(async () => {
  axios.defaults.adapter = originalAxiosAdapter;
  const child = fixtureProcess;
  if (child) {
    child.stdin.end();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        // 中文注释：发出终止信号后仍等待 exit，避免 Windows SQLite 句柄尚未释放就删目录。
        const hardStop = setTimeout(() => resolve(), 5_000);
        child.once("exit", () => {
          clearTimeout(hardStop);
          resolve();
        });
      }, 10_000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
  if (fixtureRoot) {
    try {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    } catch {
      // Windows 原生句柄延迟释放时保留在本 worktree 的 .tmp，禁止跨目录清理。
    }
  }
}, 20_000);

describe.sequential("Web 序列化/归一化 → App 真实 HTTP 生成联合门禁", () => {
  it("生产 Web preview body 必须得到 App 严格白名单与 64 位摘要", async () => {
    const input = previewInput(fixture.firstShotUuid);
    const raw = await rawPreview(input);
    expect(raw.body).toEqual(buildGenerationPreviewBody(input));
    expect(raw.status).toBe(200);
    expect(Object.keys(raw.data).sort()).toEqual([
      "options",
      "previewDigest",
      "prompt",
      "providerModel",
      "referenceSummary",
      "routeKind",
    ]);
    expect(raw.data.previewDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(raw.data.providerModel).toBe(input.providerModel);
    expect(raw.data.routeKind).toBe("dreamina-cli");
    expect(Object.keys(raw.data.options as Record<string, unknown>).sort()).toEqual([
      "aspectRatio",
      "durationMs",
      "mode",
      "resolution",
    ]);
    expect(raw.data.options).toMatchObject({
      aspectRatio: "9:16",
      durationMs: 9_000,
      mode: "text2video",
    });

    // 中文注释：再走生产 preview normalizer，证明 HTTP 白名单可被真实 Web 调用链接受。
    const normalized = await requestStoryboardGenerationPreview(fixture.projectUuid, input);
    expect(resolvedStoryboardGenerationMode(normalized, "video")).toBe("text2video");
  });

  it("模拟 200 响应丢失后同 ID 重放必须返回原任务且零重复 dispatch/零 CLI", async () => {
    const workspace = createWorkspace();
    const { formal } = await previewConfirmation(previewInput(fixture.firstShotUuid));
    const before = await fixtureState();
    adapterState.dropNextGenerateResponse = true;
    const lost = await workspace.generateShot(
      fixture.firstShotUuid,
      "video",
      formal,
      firstOperationId,
    );
    expect(lost).toBe(false);
    const retry = await workspace.generateShot(
      fixture.firstShotUuid,
      "video",
      formal,
      firstOperationId,
    );
    const calls = generateCalls(firstOperationId);
    const after = await fixtureState();
    expect(calls).toHaveLength(2);
    expect(calls[0].status).toBe(200);
    expect(calls[0].dropped).toBe(true);
    expect(calls[1].status).toBe(200);
    const expectedBody = {
      clientOperationId: firstOperationId,
      shotUuid: fixture.firstShotUuid,
      mediaType: "video",
      providerModel: formal.providerModel,
      routeKind: formal.routeKind,
      mode: formal.mode,
      durationMs: formal.durationMs,
      aspectRatio: formal.aspectRatio,
      resolution: formal.resolution,
      expectedPreviewDigest: formal.expectedPreviewDigest,
      paidBatchConfirmed: false,
    };
    expect(calls[0].body).toEqual(expectedBody);
    expect(calls[1].body).toEqual(expectedBody);
    expect(calls.every((call) => call.preserveResponse)).toBe(true);
    const firstTasks = strict200Tasks(calls[0], firstOperationId);
    const retryTasks = strict200Tasks(calls[1], firstOperationId);
    expect(firstTasks.map((row) => row.taskUuid)).toEqual(
      retryTasks.map((row) => row.taskUuid),
    );
    expect(after.taskCount - before.taskCount).toBe(1);
    expect(after.operationCount - before.operationCount).toBe(1);
    expect(after.dispatchCount - before.dispatchCount).toBe(1);
    expect(after.operations.filter((row) => row.clientOperationId === firstOperationId)).toHaveLength(1);
    expect(after.tasks.filter((row) => row.clientOperationId === firstOperationId)).toHaveLength(1);
    expect(after.dispatches.filter((row) => row.clientOperationId === firstOperationId)).toHaveLength(1);
    expect(after.cliInvocationCount).toBe(0);
    expect(retry).toBe(true);

    const real200 = envelopeData(calls[1].response);
    expect(normalizeStoryboardGenerationResponse(real200, firstOperationId, 200)).toMatchObject({
      recovered: false,
    });
    expect(() => normalizeStoryboardGenerationResponse(real200, firstOperationId, 202)).toThrow();
  });

  it("新 ID 同参数必须新建；同 ID 改内容必须 409 且不增加任务", async () => {
    const workspace = createWorkspace();
    const original = await previewConfirmation(previewInput(fixture.firstShotUuid));
    const beforeNew = await fixtureState();
    const firstAccepted = await workspace.generateShot(
      fixture.firstShotUuid,
      "video",
      original.formal,
      comparisonOperationId,
    );
    const secondAccepted = await workspace.generateShot(
      fixture.firstShotUuid,
      "video",
      original.formal,
      secondOperationId,
    );
    const afterNew = await fixtureState();
    const comparisonCall = generateCalls(comparisonOperationId).at(-1)!;
    const secondCall = generateCalls(secondOperationId).at(-1)!;
    const firstIds = strict200Tasks(comparisonCall, comparisonOperationId).map((row) => row.taskUuid);
    const secondIds = strict200Tasks(secondCall, secondOperationId).map((row) => row.taskUuid);
    expect(firstAccepted).toBe(true);
    expect(secondAccepted).toBe(true);
    expect(comparisonCall.preserveResponse).toBe(true);
    expect(secondCall.preserveResponse).toBe(true);
    expect(secondCall.status).toBe(200);
    expect(secondIds).not.toEqual(firstIds);
    expect(afterNew.taskCount - beforeNew.taskCount).toBe(2);
    expect(afterNew.operationCount - beforeNew.operationCount).toBe(2);
    expect(afterNew.dispatchCount - beforeNew.dispatchCount).toBe(2);
    expect(afterNew.operations.filter((row) => (
      row.clientOperationId === comparisonOperationId || row.clientOperationId === secondOperationId
    ))).toHaveLength(2);
    expect(afterNew.tasks.filter((row) => (
      row.clientOperationId === comparisonOperationId || row.clientOperationId === secondOperationId
    ))).toHaveLength(2);
    expect(afterNew.dispatches.filter((row) => (
      row.clientOperationId === comparisonOperationId || row.clientOperationId === secondOperationId
    ))).toHaveLength(2);

    const changed = await previewConfirmation(previewInput(fixture.firstShotUuid, undefined, 10_000));
    const beforeConflict = await fixtureState();
    const conflictAccepted = await workspace.generateShot(
      fixture.firstShotUuid,
      "video",
      changed.formal,
      secondOperationId,
    );
    const conflict = generateCalls(secondOperationId).at(-1)!;
    const afterConflict = await fixtureState();
    expect(conflictAccepted).toBe(false);
    expect(conflict.status).toBe(409);
    expect(afterConflict.taskCount).toBe(beforeConflict.taskCount);
    expect(afterConflict.operationCount).toBe(beforeConflict.operationCount);
    expect(afterConflict.dispatchCount).toBe(beforeConflict.dispatchCount);
    expect(afterConflict.cliInvocationCount).toBe(0);
  });

  it("真实批量 Web body 保持顺序；同 ID 交换 items 必须 409", async () => {
    const workspace = createWorkspace();
    const first = await previewConfirmation(previewInput(
      fixture.firstShotUuid,
      "dreamina-cli:seedance2.0fast",
    ));
    const second = await previewConfirmation(previewInput(
      fixture.secondShotUuid,
      "dreamina-cli:seedance2.0mini",
    ));
    const items = [
      { shotUuid: fixture.firstShotUuid, mediaType: "video" as const, ...first.formal },
      { shotUuid: fixture.secondShotUuid, mediaType: "video" as const, ...second.formal },
    ];
    const before = await fixtureState();
    const acceptedResult = await workspace.generateBatch(items, true, batchOperationId);
    const accepted = generateCalls(batchOperationId).at(-1)!;
    const afterAccepted = await fixtureState();
    expect(acceptedResult).toBe(true);
    expect(accepted.status).toBe(200);
    expect(accepted.preserveResponse).toBe(true);
    expect(accepted.body).toEqual({
      clientOperationId: batchOperationId,
      items,
      paidBatchConfirmed: true,
    });
    expect(strict200Tasks(accepted, batchOperationId)).toHaveLength(2);
    expect(afterAccepted.taskCount - before.taskCount).toBe(2);
    expect(afterAccepted.operationCount - before.operationCount).toBe(1);
    expect(afterAccepted.dispatchCount - before.dispatchCount).toBe(2);
    expect(afterAccepted.operations.filter((row) => row.clientOperationId === batchOperationId)).toHaveLength(1);
    expect(afterAccepted.tasks.filter((row) => row.clientOperationId === batchOperationId)).toHaveLength(2);
    expect(afterAccepted.dispatches.filter((row) => row.clientOperationId === batchOperationId)).toHaveLength(2);

    const conflictResult = await workspace.generateBatch([...items].reverse(), true, batchOperationId);
    const conflict = generateCalls(batchOperationId).at(-1)!;
    const afterConflict = await fixtureState();
    expect(conflictResult).toBe(false);
    expect(conflict.status).toBe(409);
    expect(afterConflict.taskCount).toBe(afterAccepted.taskCount);
    expect(afterConflict.operationCount).toBe(afterAccepted.operationCount);
    expect(afterConflict.dispatchCount).toBe(afterAccepted.dispatchCount);
    expect(afterConflict.cliInvocationCount).toBe(0);
  });

  it("普通 vendor 单项 202 必须为同 operation ID 的非空耐久任务且零外调", async () => {
    const input = vendorPreviewInput(fixture.firstShotUuid);
    const preview = await rawPreview(input);
    const before = await fixtureState();
    const body = {
      clientOperationId: vendorSingleOperationId,
      shotUuid: fixture.firstShotUuid,
      mediaType: "image",
      providerModel: input.providerModel,
      mode: String(preview.data.options?.mode ?? input.mode),
      aspectRatio: "16:9",
      expectedPreviewDigest: downstreamDigestForLegacyRedOnly(preview.data),
      paidBatchConfirmed: false,
    };
    const response = await postRawGeneration(body);
    const after = await fixtureState();
    expect(response.status, JSON.stringify(response.data)).toBe(202);
    const tasks = (response.data as { tasks: Array<Record<string, unknown>> }).tasks;
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.every((row) => row.clientOperationId === vendorSingleOperationId)).toBe(true);
    expect(normalizeStoryboardGenerationResponse(
      response.data,
      vendorSingleOperationId,
      202,
    )).toMatchObject({ recovered: true });
    // 中文注释：普通 vendor 现使用项目库耐久幂等协议，单项必须精确新增一条任务与一条操作。
    const newTasks = after.tasks.filter(
      (row) => !before.tasks.some((previous) => previous.taskUuid === row.taskUuid),
    );
    const newOperations = after.operations.filter(
      (row) => !before.operations.some(
        (previous) => previous.clientOperationId === row.clientOperationId,
      ),
    );
    expect(after.taskCount - before.taskCount).toBe(1);
    expect(newTasks).toHaveLength(1);
    expect(newTasks.every((row) => row.clientOperationId === vendorSingleOperationId)).toBe(true);
    expect(after.operationCount - before.operationCount).toBe(1);
    expect(newOperations).toEqual([
      expect.objectContaining({ clientOperationId: vendorSingleOperationId, itemCount: 1 }),
    ]);
    expect(after.dispatchCount).toBe(before.dispatchCount);
    expect(after.externalNetworkCallCount).toBe(before.externalNetworkCallCount);
    expect(after.cliInvocationCount).toBe(0);
  });

  it("普通 vendor 批量 202 必须为同 operation ID 的非空耐久任务且零外调", async () => {
    const inputs = [
      vendorPreviewInput(fixture.firstShotUuid),
      vendorPreviewInput(fixture.secondShotUuid),
    ];
    const previews = await Promise.all(inputs.map((input) => rawPreview(input)));
    const items = inputs.map((input, index) => ({
      shotUuid: input.shotUuid,
      mediaType: "image" as const,
      providerModel: input.providerModel,
      mode: String(previews[index].data.options?.mode ?? input.mode),
      aspectRatio: "16:9",
      expectedPreviewDigest: downstreamDigestForLegacyRedOnly(previews[index].data),
    }));
    const before = await fixtureState();
    const response = await postRawGeneration({
      clientOperationId: vendorBatchOperationId,
      items,
      paidBatchConfirmed: true,
    });
    const after = await fixtureState();
    expect(response.status, JSON.stringify(response.data)).toBe(202);
    const tasks = (response.data as { tasks: Array<Record<string, unknown>> }).tasks;
    expect(tasks).toHaveLength(2);
    expect(tasks.every((row) => row.clientOperationId === vendorBatchOperationId)).toBe(true);
    expect(normalizeStoryboardGenerationResponse(
      response.data,
      vendorBatchOperationId,
      202,
    )).toMatchObject({ recovered: true });
    // 中文注释：批量幂等操作只新增一条 operation，并按原顺序耐久两条同 ID 任务。
    const newTasks = after.tasks.filter(
      (row) => !before.tasks.some((previous) => previous.taskUuid === row.taskUuid),
    );
    const newOperations = after.operations.filter(
      (row) => !before.operations.some(
        (previous) => previous.clientOperationId === row.clientOperationId,
      ),
    );
    expect(after.taskCount - before.taskCount).toBe(2);
    expect(newTasks).toHaveLength(2);
    expect(newTasks.every((row) => row.clientOperationId === vendorBatchOperationId)).toBe(true);
    expect(after.operationCount - before.operationCount).toBe(1);
    expect(newOperations).toEqual([
      expect.objectContaining({ clientOperationId: vendorBatchOperationId, itemCount: 2 }),
    ]);
    expect(after.dispatchCount).toBe(before.dispatchCount);
    expect(after.externalNetworkCallCount).toBe(before.externalNetworkCallCount);
    expect(after.cliInvocationCount).toBe(0);
  });

  it("账号目录不存在的普通供应商模型必须零入队且不得显示受理完成", async () => {
    const input = {
      ...vendorPreviewInput(fixture.firstShotUuid),
      providerModel: `${fixture.vendorModel.split(":", 1)[0]}:removed-image`,
    };
    const preview = await rawPreview(input);
    const before = await fixtureState();
    const response = await postRawGeneration({
      clientOperationId: invalidVendorModelOperationId,
      shotUuid: fixture.firstShotUuid,
      mediaType: "image",
      providerModel: input.providerModel,
      mode: String(preview.data.options?.mode ?? input.mode),
      aspectRatio: "16:9",
      expectedPreviewDigest: downstreamDigestForLegacyRedOnly(preview.data),
      paidBatchConfirmed: false,
    });
    const after = await fixtureState();
    expect(response.status).toBe(400);
    expect(response.data).toMatchObject({ code: "STORYBOARD_VENDOR_MODEL_UNAVAILABLE" });
    expect(after.operationCount).toBe(before.operationCount);
    expect(after.taskCount).toBe(before.taskCount);
    expect(after.externalNetworkCallCount).toBe(before.externalNetworkCallCount);
    expect(after.cliInvocationCount).toBe(0);
  });

  it("真实 202 恢复对象必须被 Web 接受，200/202 交叉 shape 与混合 ID 必须拒绝", async () => {
    const installed = await fetch(`${fixture.origin}/__test/recovery-window`, { method: "POST" });
    expect(installed.status).toBe(200);
    const workspace = createWorkspace();
    const { formal } = await previewConfirmation(previewInput(fixture.firstShotUuid));
    const before = await fixtureState();
    const accepted = await workspace.generateShot(
      fixture.firstShotUuid,
      "video",
      formal,
      recoveryOperationId,
    );
    const recovery = generateCalls(recoveryOperationId).at(-1)!;
    const after = await fixtureState();
    expect(recovery.status).toBe(202);
    expect(recovery.preserveResponse).toBe(true);
    expect(accepted).toBe(true);
    const real202 = envelopeData(recovery.response);
    expect(Object.keys(real202 as Record<string, unknown>).sort()).toEqual([
      "clientOperationId",
      "tasks",
    ]);
    expect(real202).toMatchObject({
      clientOperationId: recoveryOperationId,
      tasks: expect.any(Array),
    });
    expect(normalizeStoryboardGenerationResponse(real202, recoveryOperationId, 202)).toMatchObject({
      recovered: true,
    });
    expect(() => normalizeStoryboardGenerationResponse(real202, recoveryOperationId, 200)).toThrow();
    expect(() => normalizeStoryboardGenerationResponse([], recoveryOperationId, 200)).toThrow();
    expect(() => normalizeStoryboardGenerationResponse([
      { taskUuid: "one", clientOperationId: recoveryOperationId },
      { taskUuid: "two", clientOperationId: secondOperationId },
    ], recoveryOperationId, 200)).toThrow();
    expect(after.taskCount - before.taskCount).toBe(1);
    expect(after.operationCount - before.operationCount).toBe(1);
    expect(after.dispatchCount).toBe(before.dispatchCount);
    expect(after.operations.filter((row) => row.clientOperationId === recoveryOperationId)).toHaveLength(1);
    expect(after.tasks.filter((row) => row.clientOperationId === recoveryOperationId)).toHaveLength(1);
    expect(after.dispatches.filter((row) => row.clientOperationId === recoveryOperationId)).toHaveLength(0);
    expect(after.cliInvocationCount).toBe(0);
  });

  it("设置页点击预览必须走当前分镜真实 HTTP，无镜头时零请求", async () => {
    const i18n = createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } });
    const stubs = {
      TButton: {
        inheritAttrs: true,
        props: ["loading", "disabled"],
        template: '<button v-bind="$attrs" :disabled="disabled || loading"><slot name="icon"/><slot/></button>',
      },
      TIcon: { template: "<i />" },
      TDialog: { template: "<div><slot /><slot name=\"footer\" /></div>" },
    };
    await axios.put(`/tianjiang/runtime/projects/${fixture.projectUuid}/storyboard/settings`, {
      globalVideoPrompt: "统一夜戏光影，禁止现代招牌。",
      aspectRatio: "9:16",
      durationMs: 5000,
      resolution: "720p",
    });
    const beforePreview = adapterState.calls.filter((call) => call.url.includes("/generate/preview")).length;
    const empty = mount(StoryboardSettings, {
      props: {
        projectUuid: fixture.projectUuid,
        selectedShotUuid: "",
        providerModel: "dreamina-cli:seedance2.0fast",
      },
      global: { plugins: [createPinia(), i18n], stubs },
    });
    await flushPromises();
    await empty.get('[data-action="preview-storyboard-settings"]').trigger("click");
    await flushPromises();
    expect(adapterState.calls.filter((call) => call.url.includes("/generate/preview")).length).toBe(beforePreview);
    empty.unmount();

    const wrapper = mount(StoryboardSettings, {
      props: {
        projectUuid: fixture.projectUuid,
        selectedShotUuid: fixture.firstShotUuid,
        providerModel: "dreamina-cli:seedance2.0fast",
      },
      global: { plugins: [createPinia(), i18n], stubs },
    });
    await waitUntil("设置页未加载到已保存全局视频提示词", () => {
      const field = wrapper.find('[name="globalVideoPrompt"]').element as HTMLTextAreaElement | undefined;
      return Boolean(field?.value.includes("统一夜戏光影，禁止现代招牌。"));
    });
    const beforeClick = adapterState.calls.filter((call) => call.url.includes("/generate/preview")).length;
    await wrapper.get('[data-action="preview-storyboard-settings"]').trigger("click");
    await waitUntil("设置页预览未发出真实 HTTP", () => (
      adapterState.calls.filter((call) => call.url.includes("/generate/preview")).length > beforeClick
    ));
    const previewCalls = adapterState.calls.filter((call) => call.url.includes("/generate/preview"));
    const last = previewCalls.at(-1);
    expect(last?.status).toBe(200);
    expect((last?.body as { shotUuid?: string })?.shotUuid).toBe(fixture.firstShotUuid);
    const payload = envelopeData(last?.response) as { prompt?: string };
    const prompt = String(payload?.prompt ?? "");
    expect(prompt.indexOf("统一夜戏光影，禁止现代招牌。")).toBe(0);
    expect(prompt).toContain("镜头缓慢推进，人物抬头");
    expect(prompt).toContain("风格：");
    wrapper.unmount();
  });
});
