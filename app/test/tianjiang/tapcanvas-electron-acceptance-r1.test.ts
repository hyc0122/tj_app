/**
 * 真实 Electron BrowserWindow 验收：静态导演台模型、公开项目空态、Codex 离线合同。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import { runWithTemporaryAccount } from "./helpers/worktree-runtime";

const ROOT = path.resolve(__dirname, "../..", "..");
const GLB = path.resolve(ROOT, "web/tapcanvas/public/director/xbot.glb");
const MAIN = path.resolve(__dirname, "helpers/tapcanvas-electron-acceptance-main.cjs");
const OUT_DIR = path.resolve(ROOT, ".local/tapcanvas-acceptance");

test("Electron 必须用 BrowserWindow 加载 /tapcanvas/director/xbot.glb 且公开项目/Codex 不报未接入", async () => {
  await runWithTemporaryAccount("tc-electron-accept", async () => {
  assert.equal(fs.existsSync(GLB), true, "缺少导演台 xbot.glb");
  const { default: tapcanvasCompatRouter } = await import("../../src/routes/tianjiang/tapcanvas-compat");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { centralSession?: unknown }).centralSession = {
      id: "sess",
      serverUrl: "https://api.j11.com.cn",
      user: { id: 1, username: "owner", nickname: "owner" },
    };
    next();
  });
  app.use("/tapcanvas/director", express.static(path.dirname(GLB)));
  app.use("/api/tianjiang/tapcanvas", tapcanvasCompatRouter);
  app.get("/accept", (_req, res) => {
    res.type("html").send(`<!doctype html><meta charset="utf-8"><title>TapCanvas accept</title>
<style>body{margin:0;background:#09070f;color:#f4f0ff;font:16px system-ui;padding:40px}main{max-width:760px;border:1px solid #6133a5;border-radius:18px;padding:28px;background:#151020}pre{white-space:pre-wrap;color:#8ef0cb}</style>
<main><h1>TapCanvas 正式接口验收</h1><p>导演台资源、公开项目与 Codex 离线状态均由真实兼容路由返回。</p><pre id="result">正在检查…</pre></main>
<script>
window.__tcAccept = async () => {
  const glb = await fetch("/tapcanvas/director/xbot.glb");
  const pub = await fetch("/api/tianjiang/tapcanvas/projects/public");
  const bridges = await fetch("/api/tianjiang/tapcanvas/codex/bridges");
  const report = {
    glbStatus: glb.status,
    publicStatus: pub.status,
    publicBody: await pub.json(),
    bridgesStatus: bridges.status,
    bridgesBody: await bridges.json(),
  };
  document.getElementById("result").textContent = JSON.stringify(report, null, 2);
  return report;
};
</script>`);
  });
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const electronPath = fs.realpathSync.native(path.join(ROOT, "app", "node_modules", "electron", "dist", "electron.exe"));
  assert.equal(fs.existsSync(electronPath), true, `缺少 Electron: ${electronPath}`);
  assert.ok(fs.statSync(electronPath).size > 10_000_000, "Electron 二进制不完整");
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    env.TAPCANVAS_ACCEPT_ORIGIN = origin;
    env.TAPCANVAS_ACCEPT_OUT = OUT_DIR;
    const child = spawn(electronPath, [MAIN], {
      cwd: path.dirname(MAIN),
      env,
      stdio: "ignore",
      windowsHide: false,
    });
    const stdout = "";
    let stderr = "";
    const status = await new Promise<number>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        stderr = "timeout";
        resolve(1);
      }, 45_000);
      child.on("error", (error) => {
        clearTimeout(timer);
        stderr = String(error);
        resolve(1);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code ?? 1);
      });
    });
    if (status !== 0) {
      fs.writeFileSync(path.join(OUT_DIR, "electron-debug.txt"), JSON.stringify({
        status,
        electronPath,
        MAIN,
        origin,
        stdout,
        stderr,
      }, null, 2));
      console.error(stdout);
      console.error(stderr);
    }
    assert.equal(status, 0, `Electron 验收失败 status=${status} stderr=${stderr}`);
    const report = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "report.json"), "utf8")) as {
      glbStatus: number;
      publicStatus: number;
      publicBody: unknown;
      bridgesStatus: number;
      bridgesBody: { status?: string; pairingRequired?: boolean };
    };
    assert.equal(report.glbStatus, 200);
    assert.equal(report.publicStatus, 200);
    assert.deepEqual(report.publicBody, []);
    assert.equal(report.bridgesStatus, 200);
    assert.notEqual(report.bridgesBody.status, "online");
    const screenshotPath = path.join(OUT_DIR, "window.png");
    assert.equal(fs.existsSync(screenshotPath), true);
    assert.ok(fs.statSync(screenshotPath).size > 8_000, "Electron 截图为空或尚未完成绘制");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  });
});
