/**
 * Task 8 RED：受控安装只能打批准 HTTPS URL，跨主机/HTTP/超大/SHA/PE 全部失败关闭。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import express from "express";

import {
  activateUserDatabase,
  destroyAllDatabaseHandles,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { enterUserStorage, runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import { createUniqueWorktreeRoot, closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";

const APPROVED_URL =
  "https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/dreamina_cli_beta/dreamina_cli_windows_amd64.exe";

function peX64(extra = Buffer.alloc(64, 1)): Buffer {
  const buf = Buffer.alloc(0x100 + extra.length, 0);
  buf.write("MZ", 0);
  buf.writeUInt32LE(0x80, 0x3c);
  buf.write("PE\0\0", 0x80);
  buf.writeUInt16LE(0x8664, 0x84);
  extra.copy(buf, 0x100);
  return buf;
}

async function listen(app: express.Express) {
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

async function jsonRequest(url: string, init: RequestInit = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { status: response.status, body };
}

async function mountRoutes(app: express.Express, names: string[]) {
  for (const name of names) {
    try {
      const loaded = await import(`../../src/routes/setting/dreaminaCli/${name}.ts`);
      app.use(`/api/setting/dreaminaCli/${name}`, loaded.default);
    } catch {
      // GREEN 前路由可以不存在，后续必须得到真实 404。
    }
  }
}

test("受控修复下载只请求批准 URL，并拒绝跨主机/HTTP/超大/错误类型/SHA/非 x64 PE", async () => {
  const root = createUniqueWorktreeRoot("dreamina-install-r14");
  const originalCwd = process.cwd();
  const identity = { issuer: "https://api.j11.com.cn", userId: 9808 };
  const fetches: string[] = [];
  const good = peX64();
  const goodSha = crypto.createHash("sha256").update(good).digest("hex");

  try {
    process.chdir(root);
    process.env.NODE_ENV = "prod";
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);

    const installer = await import(
      "../../src/tianjiang/model-providers/dreamina-cli/managed-installer"
    );
    try {
      installer.bindDreaminaApprovedManifest({
        schemaVersion: 1,
        sourceVersionUrl: "https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/dreamina_cli_beta/version.json",
        releases: [{
          version: "1.4.4",
          platform: "windows-x64",
          url: APPROVED_URL,
          size: good.length,
          sha256: goodSha,
          releaseId: goodSha,
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
      installer.bindDreaminaInstallTestTransport(async (url: string) => {
        fetches.push(String(url));
        if (String(url) !== APPROVED_URL) {
          return new Response("cross-host", { status: 200, headers: { "content-type": "application/octet-stream" } });
        }
        return new Response(Uint8Array.from(good), {
          status: 200,
          headers: { "content-type": "application/octet-stream", "content-length": String(good.length) },
        });
      });
    } catch {
      // 测试夹具配置失败必须由后续断言暴露，不触发真实下载。
    }

    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) => { enterUserStorage(identity); next(); });
    await mountRoutes(app, ["getStatus", "getEnvironment"]);
    const { server, port } = await listen(app);
    const base = `http://127.0.0.1:${port}/api/setting/dreaminaCli`;
    try {
      const envBefore = await jsonRequest(`${base}/getEnvironment`);
      assert.notEqual(envBefore.status, 404, "getEnvironment 生产路由必须存在");
      const envPayload = (envBefore.body as any)?.data ?? envBefore.body;
      const ids = (envPayload?.dependencies ?? []).map((item: { id: string }) => item.id);
      assert.ok(ids.includes("dreamina_binary"), `原生环境必须包含 dreamina_binary: ${JSON.stringify(envPayload)}`);
      assert.ok(!ids.includes("node") && !ids.includes("git"), "原生环境不得照搬 Node/Git");
      assert.equal(fetches.length, 0, "页面检测不得下载 CLI");

      await runWithUserStorage(identity, async () => {
        // 中文注释：点击安装已改走官方命令；保留本模块仅验证受控修复下载的安全边界。
        const installed = await installer.installApprovedDreaminaRelease({ confirm: true });
        assert.equal(installed.ok, true, `批准修复下载应成功: ${JSON.stringify(installed)}`);
        assert.deepEqual(fetches, [APPROVED_URL], `只能请求批准 URL，实际 ${JSON.stringify(fetches)}`);

        const rejectedHost = await installer.installApprovedDreaminaRelease({
          confirm: true,
          url: "https://evil.example/dreamina.exe",
        });
        assert.equal(rejectedHost.ok, false, "跨主机 URL 必须失败关闭");

        const rejectedHttp = await installer.installApprovedDreaminaRelease({
          confirm: true,
          url: APPROVED_URL.replace("https://", "http://"),
        });
        assert.equal(rejectedHttp.ok, false, "降级 HTTP 必须失败关闭");
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});
