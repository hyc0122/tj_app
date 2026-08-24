/**
 * Round17 RED：批准版本不得为 unknown；自检版本必须匹配；同版本不同 SHA 不得静默成功。
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
import { parseApprovedReleaseManifest } from "../../src/tianjiang/model-providers/dreamina-cli/approved-release-manifest";

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

test("批准清单 version=unknown 必须失败", () => {
  assert.throws(() => parseApprovedReleaseManifest({
    schemaVersion: 1,
    sourceVersionUrl: "https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/dreamina_cli_beta/version.json",
    releases: [{
      version: "unknown",
      platform: "windows-x64",
      url: APPROVED_URL,
      size: 100,
      sha256: "ab".repeat(32),
      releaseId: "ab".repeat(32),
      publishedAt: "2026-08-01T00:00:00.000Z",
    }],
  }), /unknown|版本/);
});

test("自检版本不匹配、同版本不同 SHA、unknown 自检均不得破坏旧版本", async () => {
  const root = createUniqueWorktreeRoot("r17-dreamina-sha");
  const originalCwd = process.cwd();
  const identity = { issuer: "https://api.j11.com.cn", userId: 1710 };
  const good = peX64();
  const other = Buffer.from(good);
  other[0x100] = 0x41;
  try {
    process.chdir(root);
    process.env.NODE_ENV = "prod";
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    enterUserStorage(identity);
    const installer = await import("../../src/tianjiang/model-providers/dreamina-cli/managed-installer");
    const shaGood = crypto.createHash("sha256").update(good).digest("hex");
    installer.bindDreaminaApprovedManifest({
      schemaVersion: 1,
      sourceVersionUrl: "https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/dreamina_cli_beta/version.json",
      releases: [{
        version: "1.2.3",
        platform: "windows-x64",
        url: APPROVED_URL,
        size: good.length,
        sha256: shaGood,
        releaseId: shaGood,
        publishedAt: "2026-08-01T00:00:00.000Z",
      }],
    });
    installer.bindDreaminaInstallTestTransport(async () => new Response(Uint8Array.from(good), {
      status: 200,
      headers: { "content-type": "application/octet-stream", "content-length": String(good.length) },
    }));
    installer.bindDreaminaCommandRunner(async () => ({
      stdout: "dreamina 1.2.3",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      parsed: { version: "1.2.3" },
    }));
    const first = await installer.installApprovedDreaminaRelease({ confirm: true, platform: "windows-x64" });
    assert.equal(first.ok, true, `首次安装必须成功，实际=${JSON.stringify(first)}`);
    const previousPath = first.executablePath!;
    assert.equal(fs.existsSync(previousPath), true);

    installer.bindDreaminaCommandRunner(async () => ({
      stdout: "dreamina unknown-build",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      parsed: {},
    }));
    const unknown = await installer.installApprovedDreaminaRelease({ confirm: true, platform: "windows-x64" });
    assert.equal(unknown.ok, false, `自检无法得到版本必须拒绝，实际=${JSON.stringify(unknown)}`);
    assert.equal(fs.existsSync(previousPath), true);

    installer.bindDreaminaCommandRunner(async () => ({
      stdout: "dreamina 9.9.9",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      parsed: { version: "9.9.9" },
    }));
    const mismatch = await installer.installApprovedDreaminaRelease({ confirm: true, platform: "windows-x64" });
    assert.equal(mismatch.ok, false, `自检版本与批准版本不一致必须拒绝，实际=${JSON.stringify(mismatch)}`);
    assert.equal(fs.existsSync(previousPath), true);

    const shaOther = crypto.createHash("sha256").update(other).digest("hex");
    installer.bindDreaminaApprovedManifest({
      schemaVersion: 1,
      sourceVersionUrl: "https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/dreamina_cli_beta/version.json",
      releases: [{
        version: "1.2.3",
        platform: "windows-x64",
        url: APPROVED_URL,
        size: other.length,
        sha256: shaOther,
        releaseId: shaOther,
        publishedAt: "2026-08-02T00:00:00.000Z",
      }],
    });
    installer.bindDreaminaInstallTestTransport(async () => new Response(Uint8Array.from(other), {
      status: 200,
      headers: { "content-type": "application/octet-stream", "content-length": String(other.length) },
    }));
    installer.bindDreaminaCommandRunner(async () => ({
      stdout: "dreamina 1.2.3",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      parsed: { version: "1.2.3" },
    }));
    const replaced = await installer.installApprovedDreaminaRelease({ confirm: true, platform: "windows-x64" });
    assert.equal(replaced.ok, true, `同版本不同 SHA 必须明确替换或拒绝，禁止静默成功指旧文件。实际=${JSON.stringify(replaced)}`);
    assert.ok(replaced.executablePath);
    const newBytes = fs.readFileSync(replaced.executablePath!);
    const newSha = crypto.createHash("sha256").update(newBytes).digest("hex");
    assert.equal(newSha, shaOther, `指针必须指向新 SHA，实际=${newSha} 旧=${shaGood}`);
    assert.equal(fs.existsSync(previousPath), true, "旧内容目录必须仍可启动");
    const managed = path.join(process.cwd(), "data", "managed-tools", "dreamina");
    const dirs = fs.readdirSync(managed).filter((name) => fs.statSync(path.join(managed, name)).isDirectory());
    assert.ok(dirs.some((name) => name.includes(shaGood.slice(0, 8)) || name.includes("1.2.3")), `正式目录必须按版本/内容隔离，实际=${dirs.join(",")}`);
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});
