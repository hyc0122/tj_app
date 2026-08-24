import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  classifyStartupError,
  publicStartupPayload,
  sanitizeDiagnosticText,
  type RuntimeStartupState,
  writeStartupFailureLog,
} from "../../scripts/runtime-startup";
import { RuntimeResourceError } from "../../scripts/runtime-resources";

test("包内 web 或 serve 校验失败必须归类为启动资源失败", () => {
  const classified = classifyStartupError(
    new RuntimeResourceError("包内 web 资源 SHA-256 摘要不匹配"),
  );
  assert.equal(classified.code, "STARTUP_RESOURCE_INVALID");
  assert.match(classified.message, /安装资源|官方安装程序/);
  assert.doesNotMatch(classified.message, /管理员|32位|64位|手工安装/);
});

test("原生模块 ABI 或 DLL 加载失败必须单独分类", () => {
  const classified = classifyStartupError(
    new Error("The specified module could not be found: better_sqlite3.node"),
  );
  assert.equal(classified.code, "NATIVE_MODULE_LOAD_FAILED");
  assert.match(classified.message, /官方安装程序/);
  assert.doesNotMatch(classified.message, /https?:|请手工|手工安装|管理员/);
});

test("SQLite 损坏不能伪装成缺少运行库", () => {
  const classified = classifyStartupError(
    new Error("SQLITE_CORRUPT: database disk image is malformed"),
  );
  assert.equal(classified.code, "SQLITE_DATABASE_INVALID");
  assert.match(classified.message, /数据库/);
});

test("对 renderer 只暴露脱敏诊断，不暴露堆栈", () => {
  const state: RuntimeStartupState = {
    ok: false,
    state: "failed",
    code: "LOCAL_SERVICE_START_FAILED",
    message: "本地服务启动失败",
    logPath: "C:\\safe\\startup.log",
    technicalMessage: "secret stack",
  };
  assert.deepEqual(publicStartupPayload(state), {
    ok: false,
    state: "failed",
    code: "LOCAL_SERVICE_START_FAILED",
    message: "本地服务启动失败",
    logPath: "C:\\safe\\startup.log",
  });
});

test("启动诊断日志必须清除密钥、令牌、授权头和 URL 凭据", () => {
  const secret = "tj-secret-sentinel-123";
  const raw = [
    `apiKey=${secret}`,
    `Authorization: Bearer ${secret}`,
    `https://user:${secret}@example.com/path?token=${secret}`,
    `{"clientSecret":"${secret}"}`,
    `OPENAI_API_KEY=${secret}`,
    `ALIYUN_ACCESS_KEY_SECRET=${secret}`,
    `AWS_SECRET_ACCESS_KEY=${secret}`,
  ].join(" ");
  const sanitized = sanitizeDiagnosticText(raw);
  assert.doesNotMatch(sanitized, new RegExp(secret));
  assert.match(sanitized, /\[REDACTED\]/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tj-startup-log-"));
  const logPath = path.join(root, "startup.log");
  const classified = classifyStartupError(new Error(raw));
  const state: RuntimeStartupState = {
    ok: false,
    state: "failed",
    ...classified,
    logPath,
  };
  try {
    writeStartupFailureLog(logPath, state, new Error(raw));
    const log = fs.readFileSync(logPath, "utf8");
    assert.doesNotMatch(log, new RegExp(secret));
    assert.match(log, /\[REDACTED\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
