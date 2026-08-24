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
import { enterUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import { closeActivatedWorkspaceRuntime, createUniqueWorktreeRoot } from "./helpers/worktree-runtime";

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

test("自检失败不得留下正式目录，上一版本指针保持可启动", async () => {
  const root = createUniqueWorktreeRoot("dreamina-atomic-r15");
  const originalCwd = process.cwd();
  const identity = { issuer: "https://api.j11.com.cn", userId: 9815 };
  const good = peX64();
  try {
    process.chdir(root);
    process.env.NODE_ENV = "prod";
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    enterUserStorage(identity);
    const installer = await import("../../src/tianjiang/model-providers/dreamina-cli/managed-installer");
    installer.bindDreaminaApprovedManifest({
      schemaVersion: 1,
      sourceVersionUrl: "https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/dreamina_cli_beta/version.json",
      releases: [{
        version: "1.0.0",
        platform: "windows-x64",
        url: APPROVED_URL,
        size: good.length,
        sha256: crypto.createHash("sha256").update(good).digest("hex"),
        releaseId: crypto.createHash("sha256").update(good).digest("hex"),
        publishedAt: "2026-08-01T00:00:00.000Z",
      }],
    });
    installer.bindDreaminaInstallTestTransport(async () => new Response(Uint8Array.from(good), {
      status: 200,
      headers: { "content-type": "application/octet-stream", "content-length": String(good.length) },
    }));
    let checks = 0;
    installer.bindDreaminaCommandRunner(async () => {
      checks += 1;
      if (checks === 1) return { stdout: "dreamina 1.0.0", stderr: "", exitCode: 0, timedOut: false, parsed: { version: "1.0.0" } };
      return { stdout: "dreamina 1.0.0", stderr: "", exitCode: 0, timedOut: false, parsed: { version: "1.0.0" } };
    });
    const first = await installer.installApprovedDreaminaRelease({ confirm: true, platform: "windows-x64" });
    assert.equal(first.ok, true);
    const previousPath = first.executablePath!;
    assert.equal(fs.existsSync(previousPath), true);

    installer.bindDreaminaApprovedManifest({
      schemaVersion: 1,
      sourceVersionUrl: "https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/dreamina_cli_beta/version.json",
      releases: [{
        version: "2.0.0",
        platform: "windows-x64",
        url: APPROVED_URL,
        size: good.length,
        sha256: crypto.createHash("sha256").update(good).digest("hex"),
        releaseId: crypto.createHash("sha256").update(good).digest("hex"),
        publishedAt: "2026-08-02T00:00:00.000Z",
      }],
    });
    installer.bindDreaminaCommandRunner(async () => ({
      stdout: "",
      stderr: "self-check failed",
      exitCode: 1,
      timedOut: false,
      parsed: {},
    }));
    const second = await installer.installApprovedDreaminaRelease({ confirm: true, platform: "windows-x64" });
    assert.equal(second.ok, false);
    assert.equal(fs.existsSync(previousPath), true, "上一版本可执行文件必须保留");
    const pointer = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "managed-tools", "dreamina", "current.json"), "utf8"));
    assert.equal(pointer.executablePath, previousPath);
    assert.equal(fs.existsSync(path.join(process.cwd(), "data", "managed-tools", "dreamina", "2.0.0")), false);
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});
