/**
 * Task 8 RED：安装失败必须保留上一可用版本，外部用户路径只检测不覆盖。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  activateUserDatabase,
  destroyAllDatabaseHandles,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { enterUserStorage, runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import { createUniqueWorktreeRoot, closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";
import { readDreaminaRuntimeState } from "../../src/tianjiang/model-providers/dreamina-cli/runtime-state-store";
import { writeDreaminaCliSettings } from "../../src/tianjiang/model-providers/dreamina-cli/session-store";

const FAKE_CLI = path.resolve(__dirname, "fixtures", "fake-dreamina-cli.cjs");
const APPROVED_URL =
  "https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/dreamina_cli_beta/dreamina_cli_windows_amd64.exe";

function peX64(): Buffer {
  const buf = Buffer.alloc(0x180, 0);
  buf.write("MZ", 0);
  buf.writeUInt32LE(0x80, 0x3c);
  buf.write("PE\0\0", 0x80);
  buf.writeUInt16LE(0x8664, 0x84);
  return buf;
}

function peX86(): Buffer {
  const buf = peX64();
  buf.writeUInt16LE(0x14c, 0x84);
  return buf;
}

test("checksum 或 PE 失败必须保留上一版本，且不删除外部用户路径", async () => {
  const root = createUniqueWorktreeRoot("dreamina-rollback-r14");
  const originalCwd = process.cwd();
  const identity = { issuer: "https://api.j11.com.cn", userId: 9809 };
  const previous = peX64();
  const bad = peX86();

  try {
    process.chdir(root);
    process.env.NODE_ENV = "prod";
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);

    let installer: typeof import("../../src/tianjiang/model-providers/dreamina-cli/managed-installer.ts");
    try {
      installer = await import("../../src/tianjiang/model-providers/dreamina-cli/managed-installer");
    } catch (error) {
      assert.equal(
        false,
        true,
        `受管安装尚未作为生产入口提供，失败值=${error instanceof Error ? error.message : error}`,
      );
      return;
    }
    installer.bindDreaminaApprovedManifest({
      schemaVersion: 1,
      sourceVersionUrl: "https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/dreamina_cli_beta/version.json",
      releases: [{
        version: "1.4.4",
        platform: "windows-x64",
        url: APPROVED_URL,
        size: previous.length,
        sha256: crypto.createHash("sha256").update(previous).digest("hex"),
        releaseId: crypto.createHash("sha256").update(previous).digest("hex"),
        publishedAt: "2026-08-01T00:00:00.000Z",
      }],
    });
    installer.bindDreaminaCommandRunner(async () => ({
      stdout: "dreamina 1.4.4",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      parsed: { version: "1.4.4" },
    }));
    installer.bindDreaminaInstallTestTransport(async () => new Response(Uint8Array.from(previous), {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    }));

    await runWithUserStorage(identity, async () => {
      await writeDreaminaCliSettings({ executablePath: FAKE_CLI });
      const first = await installer.installApprovedDreaminaRelease({ confirm: true });
      assert.equal(first.ok, true, `首次安装必须成功: ${JSON.stringify(first)}`);
      const afterFirst = await readDreaminaRuntimeState();
      const keptPath = afterFirst.executablePath;
      assert.ok(keptPath && fs.existsSync(keptPath), "首次安装后必须有可执行文件");
      assert.notEqual(keptPath, FAKE_CLI, "受管安装不得覆盖外部用户路径");
      assert.equal(fs.existsSync(FAKE_CLI), true, "外部用户 CLI 不得被删除");

      installer.bindDreaminaInstallTestTransport(async () => new Response(Uint8Array.from(bad), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }));
      const failed = await installer.installApprovedDreaminaRelease({ confirm: true });
      assert.equal(failed.ok, false, "错误架构必须失败关闭");
      const afterFail = await readDreaminaRuntimeState();
      assert.equal(afterFail.executablePath, keptPath, "失败必须保留上一可用版本");
      assert.equal(fs.existsSync(keptPath!), true);
    });
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});
