import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import knex from "knex";

import {
  createProductionProviderStatusAdapter,
  normalizeJiasuTaskState,
  normalizeRemoteState,
  registerProductionGenerationStatusAdapters,
} from "../../src/tianjiang/tasks/vendor-status-adapters";
import { registeredGenerationTaskPoller } from "../../src/tianjiang/tasks/generation-task-recovery";
import {
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import { registerGenerationTaskStatusAdapter } from "../../src/tianjiang/tasks/generation-task-recovery";

test("佳速兜底恢复按已存任务类型 GET 新路径，旧官方地址切换到 ai", async () => {
  const calls: Array<{ url: string; method?: string; body?: BodyInit | null }> = [];
  const adapter = createProductionProviderStatusAdapter("tianjiang", {
    apiKey: "existing-secret", baseUrl: "https://js.jiasuapi.com/v1",
  }, (async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method, body: init?.body });
    return new Response(JSON.stringify(url.includes("/images/")
      ? { code: "success", data: { id: 123, task_id: "my-image", status: "SUCCESS", result_url: "https://m.jiasuapi.com/media/image.png" } }
      : { id: "my-video", status: "completed", result_urls: ["https://m.jiasuapi.com/media/video.mp4"] }), { status: 200 });
  }) as typeof fetch)!;
  const task = { provider: "tianjiang", remoteTaskId: "my-image", projectUuid: "11111111-1111-4111-a111-111111111111", requestDigest: "a".repeat(64) };
  const image = await adapter("my-image", { ...task, remoteStatusHint: "/v1/images/create" });
  const video = await adapter("my-video", { ...task, remoteTaskId: "my-video", remoteStatusHint: "/v1/video/generations" });
  assert.equal(image.artifact?.mediaType, "image");
  assert.equal(image.artifact?.remoteUrl, "https://m.jiasuapi.com/media/image.png");
  assert.equal(video.artifact?.mediaType, "video");
  assert.equal(video.artifact?.remoteUrl, "https://m.jiasuapi.com/media/video.mp4");
  assert.deepEqual(calls, [
    { url: "https://ai.jiasuapi.com/v1/images/tasks/my-image", method: "GET", body: undefined },
    { url: "https://ai.jiasuapi.com/v1/videos/tasks/my-video", method: "GET", body: undefined },
  ]);
});

test("佳速查询 envelope 与真实任务状态分离，未知和缺结果不会重新提交", () => {
  assert.deepEqual(normalizeJiasuTaskState({ code: "success", data: { status: "QUEUED" } }, "image"), { state: "pending" });
  assert.deepEqual(normalizeJiasuTaskState({ code: "success", data: { status: "FAILURE", fail_reason: "bad image" } }, "image"), { state: "failed", reason: "bad image" });
  assert.equal(normalizeJiasuTaskState({ status: "completed", url: "https://m.jiasuapi.com/old.mp4" }, "video").state, "temporary_error");
  assert.equal(normalizeJiasuTaskState({ code: "error" }, "image").state, "temporary_error");
  assert.equal(normalizeJiasuTaskState({ status: "unknown" }, "video").state, "pending");
  assert.equal(normalizeJiasuTaskState({ status: "completed", result_urls: ["file:///secret"] }, "video").state, "temporary_error");
});

test("动态恢复保留适配器声明的无后缀视频结果类型，仍只接受远端 URL", () => {
  const remoteUrl = "https://m.jiasuapi.com/media/opaque-result-id";
  const result = normalizeRemoteState({ state: "completed", url: remoteUrl,
    artifact: { mediaType: "video", sourceKind: "remote_url", remoteUrl } });
  assert.equal(result.artifact?.mediaType, "video");
  assert.equal(result.artifact?.remoteUrl, remoteUrl);
  assert.equal(normalizeRemoteState({ state: "completed", artifact: {
    mediaType: "video", sourceKind: "local_path", localPath: "C:/secret.mp4",
  } }).artifact, undefined);
});

test("生产状态适配器只查询原任务 ID，并按供应商响应归一化", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ data: { status: "succeeded" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const adapter = createProductionProviderStatusAdapter(
    "grsai",
    { baseUrl: "https://provider.example/api", apiKey: "secret" },
    fakeFetch as typeof fetch,
  );
  assert.ok(adapter);
  assert.deepEqual(await adapter!("remote-status-1", {
    provider: "grsai",
    remoteTaskId: "remote-status-1",
    projectUuid: "00000000-0000-4000-a000-000000000001",
    requestDigest: "a".repeat(64),
  }), { state: "completed" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://provider.example/api/v1/draw/result");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { id: "remote-status-1" });
});

test("生产状态适配器拒绝 HTTP，状态归一化覆盖失败与处理中", async () => {
  await assert.rejects(
    createProductionProviderStatusAdapter(
      "atlascloud",
      { mediaBaseUrl: "http://provider.example", apiKey: "x" },
    )!("id", {
      provider: "atlascloud",
      remoteTaskId: "id",
      projectUuid: "00000000-0000-4000-a000-000000000001",
      requestDigest: "b".repeat(64),
    }),
    /HTTPS/,
  );
  assert.deepEqual(normalizeRemoteState({ status: "processing" }), { state: "pending" });
  assert.deepEqual(normalizeRemoteState({ status: "failed", error: { message: "boom" } }), {
    state: "failed",
    reason: "boom",
  });
});

test("登录恢复会从真实未终态任务登记生产适配器并查询原 ID", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tj-vendor-registry-"));
  const database = knex({
    client: "better-sqlite3",
    connection: { filename: path.join(root, "db.sqlite") },
    useNullAsDefault: true,
  });
  try {
    await database.schema.createTable("o_tasks", (table) => {
      table.string("state");
      table.string("provider");
    });
    await database.schema.createTable("o_vendorConfig", (table) => {
      table.string("id").primary();
      table.integer("enable");
      table.text("inputValues");
    });
    await database("o_tasks").insert({ state: "进行中", provider: "atlascloud" });
    await database("o_vendorConfig").insert({
      id: "atlascloud",
      enable: 0,
      inputValues: JSON.stringify({
        mediaBaseUrl: "https://provider.example",
        apiKey: "backend-only",
      }),
    });
    const requested: string[] = [];
    await registerProductionGenerationStatusAdapters(database, {
      // 测试必须显式注入账号配置库，禁止隐式回退项目 database
      accountConfigDatabase: database,
      codeLoader: () => "",
      trustedFetch: (async (input) => {
        requested.push(String(input));
        return new Response(JSON.stringify({ status: "succeeded" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    assert.deepEqual(await registeredGenerationTaskPoller.poll({
      provider: "atlascloud",
      remoteTaskId: "remote-existing-7",
      projectUuid: "00000000-0000-4000-a000-000000000007",
      requestDigest: "c".repeat(64),
    }), { state: "completed" });
    assert.deepEqual(requested, [
      "https://provider.example/model/prediction/remote-existing-7",
    ]);
  } finally {
    await database.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("同一供应商的状态适配器按当前用户和项目隔离，不被后打开项目覆盖", async () => {
  const identity = { issuer: "https://central.example", userId: 7 };
  const firstProject = "11111111-1111-4111-a111-111111111111";
  const secondProject = "22222222-2222-4222-a222-222222222222";
  runWithUserStorage(identity, () => runWithProjectStorage(firstProject, () => {
    registerGenerationTaskStatusAdapter("synthetic", async () => ({
      state: "completed",
      reason: "first-project",
    }));
  }));
  runWithUserStorage(identity, () => runWithProjectStorage(secondProject, () => {
    registerGenerationTaskStatusAdapter("synthetic", async () => ({
      state: "failed",
      reason: "second-project",
    }));
  }));

  const first = await runWithUserStorage(identity, () => runWithProjectStorage(
    firstProject,
    () => registeredGenerationTaskPoller.poll({
      provider: "synthetic",
      remoteTaskId: "remote-first",
      projectUuid: firstProject,
      requestDigest: "a".repeat(64),
    }),
  ));
  const second = await runWithUserStorage(identity, () => runWithProjectStorage(
    secondProject,
    () => registeredGenerationTaskPoller.poll({
      provider: "synthetic",
      remoteTaskId: "remote-second",
      projectUuid: secondProject,
      requestDigest: "b".repeat(64),
    }),
  ));

  assert.equal(first.reason, "first-project");
  assert.equal(second.reason, "second-project");
});

test("重启后未打开项目必须通过生产适配器 + 项目 ALS 查询，禁止依赖裸 adapter", async () => {
  const identity = { issuer: "https://central.example", userId: 9 };
  const unopened = "33333333-3333-4333-a333-333333333333";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tj-vendor-unopened-"));
  const database = knex({
    client: "better-sqlite3",
    connection: { filename: path.join(root, "db.sqlite") },
    useNullAsDefault: true,
  });
  try {
    await database.schema.createTable("o_tasks", (table) => {
      table.string("state");
      table.string("provider");
    });
    await database.schema.createTable("o_vendorConfig", (table) => {
      table.string("id").primary();
      table.integer("enable");
      table.text("inputValues");
    });
    await database("o_vendorConfig").insert({
      id: "atlascloud",
      enable: 1,
      inputValues: JSON.stringify({
        mediaBaseUrl: "https://provider.example",
        apiKey: "backend-only",
      }),
    });
    const requested: string[] = [];
    await runWithUserStorage(identity, () =>
      registerProductionGenerationStatusAdapters(database, {
        accountConfigDatabase: database,
        codeLoader: () => "",
        trustedFetch: (async (input) => {
          requested.push(String(input));
          return new Response(JSON.stringify({
            status: "succeeded",
            url: "https://cdn.example/result.mp4",
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }) as typeof fetch,
      }));
    const result = await runWithUserStorage(identity, () => runWithProjectStorage(
      unopened,
      () => registeredGenerationTaskPoller.poll({
        provider: "atlascloud",
        remoteTaskId: "remote-unopened-1",
        projectUuid: unopened,
        requestDigest: "d".repeat(64),
      }),
    ));
    assert.equal(result.state, "completed");
    assert.equal(result.artifact?.remoteUrl, "https://cdn.example/result.mp4");
    assert.deepEqual(requested, [
      "https://provider.example/model/prediction/remote-unopened-1",
    ]);
  } finally {
    await database.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("账号库解析失败时禁止回退项目 database（失败关闭）", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tj-vendor-failclosed-"));
  const projectDb = knex({
    client: "better-sqlite3",
    connection: { filename: path.join(root, "project.sqlite") },
    useNullAsDefault: true,
  });
  try {
    await projectDb.schema.createTable("o_tasks", (table) => {
      table.string("state");
      table.string("provider");
    });
    await projectDb("o_tasks").insert({ state: "进行中", provider: "atlascloud" });
    // 不注入 accountConfigDatabase 且无用户 ALS → accountDatabase() 失败
    await assert.rejects(
      () =>
        registerProductionGenerationStatusAdapters(projectDb, {
          codeLoader: () => "",
        }),
      /账号|存储|database|context|用户/i,
    );
  } finally {
    await projectDb.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
