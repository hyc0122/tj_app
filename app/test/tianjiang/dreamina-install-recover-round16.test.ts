/**
 * Round16 RED：崩溃残留的任意 PID pointer 临时文件必须可恢复；截断 current.json 不得假装已安装。
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

test("checksum/PE 失败必须清理 staging，且其他 PID 的 pointer tmp 必须能恢复", async () => {
  const root = createUniqueWorktreeRoot("dreamina-recover-r16");
  const originalCwd = process.cwd();
  const identity = { issuer: "https://api.j11.com.cn", userId: 9816 };
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
    installer.bindDreaminaCommandRunner(async () => ({
      stdout: "dreamina 1.0.0",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      parsed: { version: "1.0.0" },
    }));
    const first = await installer.installApprovedDreaminaRelease({ confirm: true, platform: "windows-x64" });
    assert.equal(first.ok, true, `首次安装失败：${first.reason ?? "unknown"}`);
    const previousPath = first.executablePath!;

    installer.bindDreaminaApprovedManifest({
      schemaVersion: 1,
      sourceVersionUrl: "https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/dreamina_cli_beta/version.json",
      releases: [{
        version: "2.0.0",
        platform: "windows-x64",
        url: APPROVED_URL,
        size: good.length,
        sha256: "00".repeat(32),
        releaseId: "00".repeat(32),
        publishedAt: "2026-08-02T00:00:00.000Z",
      }],
    });
    const checksum = await installer.installApprovedDreaminaRelease({ confirm: true, platform: "windows-x64" });
    assert.equal(checksum.ok, false);
    const managed = path.join(process.cwd(), "data", "managed-tools", "dreamina");
    assert.equal(fs.existsSync(path.join(managed, "staging")) && fs.readdirSync(path.join(managed, "staging")).length > 0, false);
    assert.equal(fs.existsSync(previousPath), true);

    const pointer = path.join(managed, "current.json");
    const payload = fs.readFileSync(pointer, "utf8");
    fs.writeFileSync(pointer, "{truncated", "utf8");
    const foreignTmp = path.join(managed, "current.json.99999.tmp");
    fs.writeFileSync(foreignTmp, payload, "utf8");
    const recovered = installer.recoverManagedDreaminaInstall();
    assert.equal(recovered.ok, true, `其他 PID 的 pointer tmp 必须恢复，实际=${JSON.stringify(recovered)}`);
    const restored = JSON.parse(fs.readFileSync(pointer, "utf8")) as { executablePath?: string };
    assert.equal(restored.executablePath, previousPath);

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
    const again = await installer.installApprovedDreaminaRelease({ confirm: true, platform: "windows-x64" });
    assert.equal(again.ok, true, "同版本重试必须幂等成功");
    assert.equal(fs.existsSync(previousPath), true);
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});
