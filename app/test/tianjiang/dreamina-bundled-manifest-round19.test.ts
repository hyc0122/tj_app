/**
 * Round19 RED：仓库正式内置批准清单必须可被生产解析并走正式安装入口。
 * 禁止 bindDreaminaApprovedManifest；网络/进程可用 fake，输入必须是仓库真实清单。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
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
import {
  defaultApprovedManifestPath,
  readApprovedReleaseManifest,
} from "../../src/tianjiang/model-providers/dreamina-cli/approved-release-manifest";

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

function bundledManifestPath(): string {
  return defaultApprovedManifestPath();
}

test("正式内置 approved-releases.json 必须能被生产 parser 读取", () => {
  const file = bundledManifestPath();
  assert.equal(fs.existsSync(file), true, `缺少正式清单：${file}`);
  const raw = fs.readFileSync(file, "utf8");
  const parsed = JSON.parse(raw) as { releases?: Array<{ version?: string; sha256?: string; size?: number }> };
  const first = parsed.releases?.[0];
  // 动态读仓库真实值，禁止用测试常量假装清单可用。
  const manifest = readApprovedReleaseManifest();
  const windows = manifest.releases.find((item) => item.platform === "windows-x64");
  assert.ok(windows, "正式清单必须包含 windows-x64");
  assert.notEqual(windows.version, "unknown", `正式清单 version 不得为 unknown，实际=${windows.version}`);
  assert.match(windows.sha256, /^[0-9a-f]{64}$/);
  assert.ok(windows.size > 0, `正式清单 size 必须大于 0，实际=${windows.size}`);
  assert.equal(first?.version, windows.version);
});

test("正式安装入口未注入测试清单时必须能用仓库内置清单完成安装", async () => {
  const root = createUniqueWorktreeRoot("r19-bundled-install");
  const originalCwd = process.cwd();
  const identity = { issuer: "https://api.j11.com.cn", userId: 1911 };
  try {
    process.chdir(root);
    process.env.NODE_ENV = "prod";
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    enterUserStorage(identity);
    const installer = await import("../../src/tianjiang/model-providers/dreamina-cli/managed-installer");
    installer.bindDreaminaApprovedManifest(undefined);
    const bundled = readApprovedReleaseManifest();
    const release = bundled.releases.find((item) => item.platform === "windows-x64");
    assert.ok(release, "正式清单必须有 windows-x64");
    // 中文注释：常规专项不得读取被忽略的 31MB 官方 exe；真实字节校验走独立 Artifact Gate。
    let requestedUrl = "";
    installer.bindDreaminaInstallTestTransport(async (url) => {
      requestedUrl = url;
      return new Response(new Uint8Array([0x4d, 0x5a]), {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": "2",
        },
      });
    });
    const result = await installer.installApprovedDreaminaRelease({ confirm: true, platform: "windows-x64" });
    assert.equal(requestedUrl, release.url, `安装必须请求正式清单 URL，实际=${requestedUrl}`);
    assert.equal(result.ok, false, `无官方 Artifact 时不得假装安装成功，实际=${JSON.stringify(result)}`);
  } finally {
    const installer = await import("../../src/tianjiang/model-providers/dreamina-cli/managed-installer");
    installer.bindDreaminaApprovedManifest(undefined);
    installer.bindDreaminaInstallTestTransport(undefined);
    installer.bindDreaminaCommandRunner(undefined);
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});

test("刷新脚本拿不到可靠版本时必须非零退出且正式清单逐字节不变", () => {
  const manifestPath = bundledManifestPath();
  const before = fs.readFileSync(manifestPath);
  const beforeHash = crypto.createHash("sha256").update(before).digest("hex");
  const helper = path.resolve(__dirname, "helpers/stub-dreamina-refresh-fetch.mjs");
  const script = path.resolve(__dirname, "../../scripts/refresh-dreamina-approved-release.mjs");
  const ran = spawnSync(process.execPath, ["--import", helper, script], {
    cwd: path.resolve(__dirname, "../.."),
    encoding: "utf8",
    env: { ...process.env },
  });
  const after = fs.readFileSync(manifestPath);
  const afterHash = crypto.createHash("sha256").update(after).digest("hex");
  try {
    assert.notEqual(ran.status, 0, `拿不到可靠版本必须非零退出，实际 exit=${ran.status} stdout=${ran.stdout} stderr=${ran.stderr}`);
    assert.equal(afterHash, beforeHash, "失败刷新不得改写正式清单");
    assert.equal(after.includes('"unknown"'), before.includes('"unknown"') && after.equals(before), "失败刷新不得写入 unknown");
    assert.ok(after.equals(before), "失败刷新后清单必须逐字节不变");
  } finally {
    if (!after.equals(before)) fs.writeFileSync(manifestPath, before);
  }
});

test("内置清单安装失败不得破坏上一可用版本", async () => {
  const root = createUniqueWorktreeRoot("r19-bundled-keep-old");
  const originalCwd = process.cwd();
  const identity = { issuer: "https://api.j11.com.cn", userId: 1912 };
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
    assert.equal(first.ok, true, `上一版本必须先装上，实际=${JSON.stringify(first)}`);
    const previousPath = first.executablePath!;
    assert.equal(fs.existsSync(previousPath), true);

    installer.bindDreaminaApprovedManifest(undefined);
    installer.bindDreaminaCommandRunner(async () => ({
      stdout: "",
      stderr: "fail",
      exitCode: 1,
      timedOut: false,
      parsed: {},
    }));
    const second = await installer.installApprovedDreaminaRelease({ confirm: true, platform: "windows-x64" });
    assert.equal(second.ok, false, `内置清单若不可用或自检失败必须拒绝，实际=${JSON.stringify(second)}`);
    assert.equal(fs.existsSync(previousPath), true, "失败更新不得删除上一可用版本");
    const pointer = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "managed-tools", "dreamina", "current.json"), "utf8"));
    assert.equal(pointer.executablePath, previousPath);
  } finally {
    const installer = await import("../../src/tianjiang/model-providers/dreamina-cli/managed-installer");
    installer.bindDreaminaApprovedManifest(undefined);
    installer.bindDreaminaInstallTestTransport(undefined);
    installer.bindDreaminaCommandRunner(undefined);
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});
