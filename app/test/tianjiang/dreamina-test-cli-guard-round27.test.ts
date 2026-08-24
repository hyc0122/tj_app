/**
 * Round 27 RED：测试上下文只能执行仓库内固定 Dreamina fixture。
 * 所有“外部可执行”均为本地无害 sentinel，绝不调用真实 CLI、账号或收费接口。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  DreaminaProcessError,
  findDreaminaInSafePath,
  runDreaminaCommand,
} from "../../src/tianjiang/model-providers/dreamina-cli/process-runner";
import { DREAMINA_ERROR } from "../../src/tianjiang/model-providers/dreamina-cli/contracts";

const FIXTURE_CLI = path.resolve(__dirname, "fixtures", "fake-dreamina-cli.cjs");
const TEST_ROOT = path.resolve(process.cwd(), "..", ".local", "t", `dreamina-cli-guard-${process.pid}`);

interface SavedEnvironment {
  NODE_TEST_CONTEXT?: string;
  DREAMINA_TEST_EXECUTABLE?: string;
  DREAMINA_FAKE_SCENARIO?: string;
  DREAMINA_SENTINEL_LOG?: string;
  NODE_OPTIONS?: string;
  PATH?: string;
}

function saveEnvironment(): SavedEnvironment {
  return {
    NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT,
    DREAMINA_TEST_EXECUTABLE: process.env.DREAMINA_TEST_EXECUTABLE,
    DREAMINA_FAKE_SCENARIO: process.env.DREAMINA_FAKE_SCENARIO,
    DREAMINA_SENTINEL_LOG: process.env.DREAMINA_SENTINEL_LOG,
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    PATH: process.env.PATH,
  };
}

function restoreEnvironment(saved: SavedEnvironment): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function writeHarmlessSentinel(filePath: string): void {
  fs.writeFileSync(filePath, [
    'const fs = require("node:fs");',
    'fs.appendFileSync(process.env.DREAMINA_SENTINEL_LOG, "spawned\\n");',
    'process.stdout.write(JSON.stringify({ version: "0.0.0-sentinel" }));',
  ].join("\n"), "utf8");
}

async function captureTestGuardRejection(executablePath: string): Promise<unknown> {
  try {
    await runDreaminaCommand({
      executablePath,
      args: ["version"],
      timeoutKind: "probe",
    });
    return undefined;
  } catch (error) {
    return error;
  }
}

function assertPathRejected(error: unknown): void {
  assert.ok(error instanceof DreaminaProcessError, "测试硬哨兵必须抛出 DreaminaProcessError");
  assert.equal(error.code, DREAMINA_ERROR.pathRejected);
}

test("NODE_TEST_CONTEXT 拒绝固定 fixture 之外的绝对可执行路径，且不启动 sentinel", async () => {
  const saved = saveEnvironment();
  const sentinel = path.join(TEST_ROOT, "external-sentinel.cjs");
  const marker = path.join(TEST_ROOT, "external-spawned.log");
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  writeHarmlessSentinel(sentinel);

  try {
    process.env.NODE_TEST_CONTEXT = "dreamina-test-cli-guard-round27";
    process.env.DREAMINA_SENTINEL_LOG = marker;
    const error = await captureTestGuardRejection(path.resolve(sentinel));
    assert.equal(fs.existsSync(marker), false, "测试硬哨兵必须在 spawn 前拒绝外部绝对路径");
    assertPathRejected(error);
  } finally {
    restoreEnvironment(saved);
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  }
});

test("NODE_TEST_CONTEXT 拒绝恶意 PATH 回退解析出的 dreamina.exe，且不启动 sentinel", async () => {
  const saved = saveEnvironment();
  const pathRoot = path.join(TEST_ROOT, "malicious-path");
  const executable = path.join(pathRoot, "dreamina.exe");
  const preload = path.join(pathRoot, "sentinel-preload.cjs");
  const marker = path.join(TEST_ROOT, "path-spawned.log");
  fs.mkdirSync(pathRoot, { recursive: true });
  // 中文注释：复制当前 Node 仅作为无害本地 EXE；preload 若被触发会留下越界证据。
  fs.copyFileSync(process.execPath, executable);
  fs.writeFileSync(
    preload,
    'require("node:fs").appendFileSync(process.env.DREAMINA_SENTINEL_LOG, "spawned\\n");',
    "utf8",
  );

  try {
    process.env.NODE_TEST_CONTEXT = "dreamina-test-cli-guard-round27";
    delete process.env.DREAMINA_TEST_EXECUTABLE;
    process.env.PATH = pathRoot;
    process.env.NODE_OPTIONS = `--require=${preload}`;
    process.env.DREAMINA_SENTINEL_LOG = marker;

    const fromPath = findDreaminaInSafePath();
    assert.equal(path.resolve(String(fromPath)), path.resolve(executable), "必须真实覆盖 PATH 回退入口");
    const error = await captureTestGuardRejection(String(fromPath));
    assert.equal(fs.existsSync(marker), false, "测试硬哨兵必须在 spawn 前拒绝 PATH 外部程序");
    assertPathRejected(error);
  } finally {
    restoreEnvironment(saved);
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  }
});

test("NODE_TEST_CONTEXT 允许仓库内固定绝对 fixture", async () => {
  const saved = saveEnvironment();
  try {
    process.env.NODE_TEST_CONTEXT = "dreamina-test-cli-guard-round27";
    process.env.DREAMINA_TEST_EXECUTABLE = FIXTURE_CLI;
    process.env.DREAMINA_FAKE_SCENARIO = "default";
    const result = await runDreaminaCommand({
      executablePath: path.resolve(FIXTURE_CLI),
      args: ["version"],
      timeoutKind: "probe",
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.parsed?.version, "1.4.4");
  } finally {
    restoreEnvironment(saved);
  }
});

test("NODE_TEST_CONTEXT 执行固定 fixture 时必须移除 NODE_OPTIONS 外部预加载", async () => {
  const saved = saveEnvironment();
  const preload = path.join(TEST_ROOT, "fixture-preload-sentinel.cjs");
  const marker = path.join(TEST_ROOT, "fixture-preload-spawned.log");
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  fs.writeFileSync(
    preload,
    'require("node:fs").appendFileSync(process.env.DREAMINA_SENTINEL_LOG, "spawned\\n");',
    "utf8",
  );

  try {
    process.env.NODE_TEST_CONTEXT = "dreamina-test-cli-guard-round27";
    process.env.DREAMINA_TEST_EXECUTABLE = FIXTURE_CLI;
    process.env.DREAMINA_FAKE_SCENARIO = "default";
    process.env.NODE_OPTIONS = `--require=${preload}`;
    process.env.DREAMINA_SENTINEL_LOG = marker;
    const result = await runDreaminaCommand({
      executablePath: FIXTURE_CLI,
      args: ["version"],
      timeoutKind: "probe",
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.parsed?.version, "1.4.4");
    assert.equal(fs.existsSync(marker), false, "固定 fixture 不得继承可执行外部代码的 NODE_OPTIONS");
  } finally {
    restoreEnvironment(saved);
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  }
});

test("Windows 测试上下文必须移除大小写变体 node_options 外部预加载", async () => {
  const originalEntries = Object.entries(process.env)
    .filter(([key]) => key.toLowerCase() === "node_options");
  const saved = saveEnvironment();
  const preload = path.join(TEST_ROOT, "lowercase-node-options-sentinel.cjs");
  const marker = path.join(TEST_ROOT, "lowercase-node-options-spawned.log");
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  fs.writeFileSync(
    preload,
    'require("node:fs").appendFileSync(process.env.DREAMINA_SENTINEL_LOG, "spawned\\n");',
    "utf8",
  );

  try {
    for (const key of Object.keys(process.env)) {
      if (key.toLowerCase() === "node_options") delete process.env[key];
    }
    process.env.NODE_TEST_CONTEXT = "dreamina-test-cli-guard-round27";
    process.env.DREAMINA_TEST_EXECUTABLE = FIXTURE_CLI;
    process.env.DREAMINA_FAKE_SCENARIO = "default";
    process.env.node_options = `--require=${preload}`;
    process.env.DREAMINA_SENTINEL_LOG = marker;
    const result = await runDreaminaCommand({
      executablePath: FIXTURE_CLI,
      args: ["version"],
      timeoutKind: "probe",
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.parsed?.version, "1.4.4");
    assert.equal(fs.existsSync(marker), false, "大小写变体 node_options 不得进入固定 fixture 子进程");
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key.toLowerCase() === "node_options") delete process.env[key];
    }
    for (const [key, value] of originalEntries) process.env[key] = value;
    restoreEnvironment(saved);
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  }
});

test("非测试生产路径仍允许既有本地普通可执行文件", async () => {
  const saved = saveEnvironment();
  const sentinel = path.join(TEST_ROOT, "production-sentinel.cjs");
  const marker = path.join(TEST_ROOT, "production-spawned.log");
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  writeHarmlessSentinel(sentinel);

  try {
    delete process.env.NODE_TEST_CONTEXT;
    process.env.DREAMINA_SENTINEL_LOG = marker;
    const result = await runDreaminaCommand({
      executablePath: sentinel,
      args: ["version"],
      timeoutKind: "probe",
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.parsed?.version, "0.0.0-sentinel");
    assert.equal(fs.readFileSync(marker, "utf8"), "spawned\n");
  } finally {
    restoreEnvironment(saved);
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  }
});
