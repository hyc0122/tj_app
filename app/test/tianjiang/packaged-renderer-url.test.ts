import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  assertLoopbackApiUrl,
  buildPackagedRendererURL,
} from "../../scripts/packaged-renderer-url";

const appRoot = path.resolve(__dirname, "../..");
const mainSource = fs.readFileSync(
  path.join(appRoot, "scripts", "main.ts"),
  "utf8",
);

test("打包生产入口使用同源 loadURL，且不再对 webEntry 调用 loadFile", () => {
  assert.match(mainSource, /buildPackagedRendererURL/);
  assert.match(mainSource, /loadURL\(/);
  // 生产就绪路径不得再 loadFile 安装包 webEntry（file:// 会导致 Cookie 跨来源失效）。
  assert.doesNotMatch(
    mainSource,
    /packagedRuntimeResources\.webEntry[\s\S]{0,80}loadFile|loadFile\(\s*packagedRuntimeResources\.webEntry/,
  );
  assert.match(mainSource, /TJ_IMMUTABLE_WEB_ROOT/);
  assert.match(mainSource, /packagedRuntimeResources\.webRoot/);
});

test("渲染 URL 只能是 127.0.0.1 有效端口，拒绝 localhost/全网卡/外部地址/路径注入", () => {
  assert.equal(
    buildPackagedRendererURL({ state: "ready", port: 18181, url: "http://127.0.0.1:18181/api" }),
    "http://127.0.0.1:18181/",
  );

  assert.throws(
    () => buildPackagedRendererURL({ state: "starting", port: 18181 }),
    /尚未就绪/,
  );
  assert.throws(
    () => buildPackagedRendererURL({ state: "ready", port: 0 }),
    /端口无效/,
  );
  assert.throws(
    () => buildPackagedRendererURL({ state: "ready", port: 70_000 }),
    /端口无效/,
  );
  assert.throws(
    () => buildPackagedRendererURL({
      state: "ready",
      port: 18181,
      url: "http://localhost:18181/api",
    }),
    /127\.0\.0\.1/,
  );
  assert.throws(
    () => buildPackagedRendererURL({
      state: "ready",
      port: 18181,
      url: "http://0.0.0.0:18181/api",
    }),
    /127\.0\.0\.1/,
  );
  assert.throws(
    () => buildPackagedRendererURL({
      state: "ready",
      port: 18181,
      url: "http://203.0.113.9:18181/api",
    }),
    /127\.0\.0\.1/,
  );
  assert.throws(
    () => buildPackagedRendererURL({
      state: "ready",
      port: 18181,
      url: "http://127.0.0.1:18181/api/../evil",
    }),
    /路径|无效/,
  );
  assert.throws(
    () => assertLoopbackApiUrl("http://127.0.0.1:18181/api?token=secret", 18181),
    /凭据|查询|片段/,
  );
});
