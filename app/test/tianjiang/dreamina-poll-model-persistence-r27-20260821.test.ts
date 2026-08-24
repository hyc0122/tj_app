/**
 * R27 RED：轮询间隔必须按当前账号持久化，且真实 CLI gen_status 必须被正确分类。
 * 测试只调用 fake CLI，不访问真实即梦或任何付费服务。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  activateUserDatabase,
  destroyAllDatabaseHandles,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { enterUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import {
  readDreaminaCliSettings,
  writeDreaminaCliSettings,
} from "../../src/tianjiang/model-providers/dreamina-cli/session-store";
import { createDreaminaCliProvider } from "../../src/tianjiang/model-providers/dreamina-cli/provider";

const FAKE_CLI = path.resolve(__dirname, "fixtures", "fake-dreamina-cli.cjs");

function fixtureRoot(): string {
  return path.resolve(process.cwd(), "..", ".tmp", "dreamina-poll-r27");
}

function readLog(logFile: string): Array<{ args: string[] }> {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[] });
}

test("轮询间隔按当前账号 SQLite 保存，默认 30 秒且仅允许 5 到 300", async () => {
  const root = fixtureRoot();
  const originalCwd = process.cwd();
  const identity = { issuer: "https://api.j11.com.cn", userId: 92701 };
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });

  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    enterUserStorage(identity);

    const initial = await readDreaminaCliSettings();
    assert.equal(initial.pollSeconds, 30);

    await (writeDreaminaCliSettings as unknown as (patch: { pollSeconds: number }) => Promise<unknown>)({ pollSeconds: 45 });
    const saved = await readDreaminaCliSettings();
    assert.equal(saved.pollSeconds, 45);

    await assert.rejects(
      () => (writeDreaminaCliSettings as unknown as (patch: { pollSeconds: number }) => Promise<unknown>)({ pollSeconds: 4 }),
      /轮询|5|300/,
    );
    await assert.rejects(
      () => (writeDreaminaCliSettings as unknown as (patch: { pollSeconds: number }) => Promise<unknown>)({ pollSeconds: 301 }),
      /轮询|5|300/,
    );
  } finally {
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows 可能短暂持有 SQLite WAL；不影响合同断言。
    }
  }
});

test("视频提交使用保存的轮询秒数，图片不带 poll；gen_status 取消失败与未知态均停止轮询", async () => {
  const root = path.join(fixtureRoot(), "provider");
  const projectRoot = path.join(root, "project");
  const stagingDirectory = path.join(root, "staging");
  const logFile = path.join(root, "cli.log");
  const originalScenario = process.env.DREAMINA_FAKE_SCENARIO;
  const originalLog = process.env.DREAMINA_FAKE_LOG;
  const originalQueryStatus = process.env.DREAMINA_FAKE_QUERY_STATUS;
  const originalQueryWithStaleFile = process.env.DREAMINA_FAKE_QUERY_WITH_STALE_FILE;
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(projectRoot, "files"), { recursive: true });
  fs.mkdirSync(stagingDirectory, { recursive: true });

  try {
    process.env.DREAMINA_FAKE_SCENARIO = "submit_id";
    process.env.DREAMINA_FAKE_LOG = logFile;
    const provider = await createDreaminaCliProvider({
      executablePath: FAKE_CLI,
      projectRoot,
      stagingDirectory,
    });

    const video = await provider.submit({
      mode: "text2video",
      prompt: "视频",
      duration: 5,
      ratio: "9:16",
      videoResolution: "720p",
      pollSeconds: 45,
    });
    const image = await provider.submit({
      mode: "text2image",
      prompt: "图片",
      ratio: "1:1",
      resolutionType: "2k",
      pollSeconds: 45,
    });
    assert.equal(video.kind, "submitted");
    assert.equal(image.kind, "submitted");

    const calls = readLog(logFile);
    const videoArgs = calls.find((call) => call.args[0] === "text2video")?.args ?? [];
    const imageArgs = calls.find((call) => call.args[0] === "text2image")?.args ?? [];
    assert.ok(videoArgs.includes("--poll=45"), "视频模式必须传入账号保存的轮询秒数");
    assert.ok(!imageArgs.some((item) => item.startsWith("--poll=")), "图片模式不得误传 --poll");

    process.env.DREAMINA_FAKE_QUERY_STATUS = "cancelled";
    process.env.DREAMINA_FAKE_QUERY_WITH_STALE_FILE = "1";
    const cancelled = await provider.query({ submitId: "sub-cancelled", stagingDirectory });
    assert.equal(cancelled.kind, "definite_failure");
    assert.equal(cancelled.retryable, false);
    assert.equal(cancelled.message, "任务已在即梦侧取消");
    delete process.env.DREAMINA_FAKE_QUERY_WITH_STALE_FILE;

    process.env.DREAMINA_FAKE_QUERY_STATUS = "failed";
    const failed = await provider.query({ submitId: "sub-failed", stagingDirectory });
    assert.equal(failed.kind, "definite_failure");
    assert.equal(failed.retryable, true);
    assert.match(failed.message, /失败/);

    process.env.DREAMINA_FAKE_QUERY_STATUS = "mystery";
    const unknown = await provider.query({ submitId: "sub-mystery", stagingDirectory });
    assert.notEqual(unknown.kind, "running", "未知非空状态必须 fail-closed，禁止无限轮询");
  } finally {
    if (originalScenario === undefined) delete process.env.DREAMINA_FAKE_SCENARIO;
    else process.env.DREAMINA_FAKE_SCENARIO = originalScenario;
    if (originalLog === undefined) delete process.env.DREAMINA_FAKE_LOG;
    else process.env.DREAMINA_FAKE_LOG = originalLog;
    if (originalQueryStatus === undefined) delete process.env.DREAMINA_FAKE_QUERY_STATUS;
    else process.env.DREAMINA_FAKE_QUERY_STATUS = originalQueryStatus;
    if (originalQueryWithStaleFile === undefined) delete process.env.DREAMINA_FAKE_QUERY_WITH_STALE_FILE;
    else process.env.DREAMINA_FAKE_QUERY_WITH_STALE_FILE = originalQueryWithStaleFile;
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows 可能短暂持有子进程文件句柄；不影响合同断言。
    }
  }
});
