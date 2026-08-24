/**
 * Round 27 RED：测试上下文漏绑 WSL fake executor 时必须在 spawn 前熔断。
 * child_process 边界使用本地事件型 sentinel，不启动任何真实 wsl.exe。
 */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

const TEST_ROOT = path.resolve(process.cwd(), "..", ".local", "t", `dreamina-wsl-guard-${process.pid}`);

test("NODE_TEST_CONTEXT 未绑定 WSL fake executor 时禁止 spawn，显式绑定后仍可探测", async () => {
  const originalTestContext = process.env.NODE_TEST_CONTEXT;
  const originalPath = process.env.PATH;
  const originalSpawn = childProcess.spawn;
  const marker = path.join(TEST_ROOT, "wsl-spawned.log");
  fs.mkdirSync(TEST_ROOT, { recursive: true });

  const sentinelSpawn = ((_file: string, _args: readonly string[]) => {
    fs.appendFileSync(marker, "spawned\n");
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
    }) as unknown as ReturnType<typeof childProcess.spawn>;
    queueMicrotask(() => {
      stdout.end();
      stderr.end();
      child.emit("close", 0);
    });
    return child;
  }) as typeof childProcess.spawn;

  try {
    // 中文注释：先替换进程边界再加载模块，确保本测试绝不进入 Windows 可执行搜索。
    childProcess.spawn = sentinelSpawn;
    assert.equal(childProcess.spawn, sentinelSpawn, "测试 sentinel 必须先接管 spawn 边界");
    process.env.NODE_TEST_CONTEXT = "dreamina-test-wsl-guard-round27";
    process.env.PATH = path.join(TEST_ROOT, "malicious-path");

    const manager = await import("../../src/tianjiang/model-providers/dreamina-cli/wsl-manager");
    manager.bindWslExecutor(undefined);
    const blocked = await manager.probeWslEnvironment();
    assert.equal(fs.existsSync(marker), false, "漏绑 fake executor 时必须在 spawn 前熔断");
    assert.equal(blocked.installed, false);

    const calls: string[][] = [];
    manager.bindWslExecutor(async (_file, args) => {
      calls.push([...args]);
      return {
        stdout: args[0] === "--status" ? "Default Version: 2" : "Ubuntu Running 2",
        stderr: "",
        exitCode: 0,
      };
    });
    const allowed = await manager.probeWslEnvironment();
    assert.equal(allowed.installed, true);
    assert.deepEqual(calls, [["--status"], ["-l", "-v"]]);
    assert.equal(fs.existsSync(marker), false, "显式 fake executor 也不得回退到 child_process.spawn");
  } finally {
    try {
      const manager = await import("../../src/tianjiang/model-providers/dreamina-cli/wsl-manager");
      manager.bindWslExecutor(undefined);
    } finally {
      childProcess.spawn = originalSpawn;
      if (originalTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
      else process.env.NODE_TEST_CONTEXT = originalTestContext;
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    }
  }
});
