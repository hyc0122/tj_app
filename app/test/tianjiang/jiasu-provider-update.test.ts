import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import { transform } from "sucrase";

import runCode from "../../src/utils/vm";
import {
  checkRemoteVendorUpdate,
  downloadRemoteVendorUpdate,
} from "../../src/utils/vendor";
import { prepareVendorSourceUpdate } from "../../src/utils/vendor-source-update";

interface UpdateRuntime {
  vendor: { id: string; version: string; inputValues: Record<string, string> };
  checkForUpdates: () => Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }>;
  updateVendor: () => Promise<string>;
}

const templatePath = path.join(
  process.cwd(),
  "src",
  "provider-templates",
  "tianjiang.ts.template",
);

function loadRuntime(updateBaseUrl: string): UpdateRuntime {
  const source = fs.readFileSync(templatePath, "utf8");
  const javascript = transform(source, { transforms: ["typescript"] }).code;
  const runtime = runCode(javascript, undefined, { provider: "tianjiang" }) as unknown as UpdateRuntime;
  runtime.vendor.inputValues.updateBaseUrl = updateBaseUrl;
  return runtime;
}

async function createUpdateServer(options: { corruptHash?: boolean; version?: string } = {}) {
  const version = options.version ?? "4.5";
  const source = `
exports.vendor = {
  id: "tianjiang",
  version: "${version}",
  name: "佳速 API",
  author: "JiasuAPI",
  inputs: [],
  inputValues: {},
  models: [],
};
exports.textRequest = async () => ({});
exports.imageRequest = async () => "";
exports.videoRequest = async () => "";
`;
  const sha256 = crypto.createHash("sha256").update(source, "utf8").digest("hex");
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname.endsWith("/latest")) {
      response.setHeader("content-type", "application/json");
      return response.end(JSON.stringify({
        code: 0,
        data: {
          schemaVersion: 1,
          providerId: "tianjiang",
          version,
          sourcePath: `provider-configs/tianjiang/releases/${version}/tianjiang.ts`,
          size: Buffer.byteLength(source),
          sha256: options.corruptHash ? "0".repeat(64) : sha256,
          notice: "佳速配置已更新",
        },
        msg: "success",
      }));
    }
    if (pathname.endsWith(`/releases/${version}/source`)) {
      response.setHeader("content-type", "text/plain; charset=utf-8");
      return response.end(source);
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/tianjiang/v1/public/provider-sources/tianjiang`,
    source,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("佳速模板版本升级为 4.4，并从后台公开入口显式检查更新", async () => {
  const fixture = await createUpdateServer();
  try {
    const runtime = loadRuntime(fixture.baseUrl);
    assert.equal(runtime.vendor.version, "4.4");
    assert.deepEqual(await runtime.checkForUpdates(), {
      hasUpdate: true,
      latestVersion: "4.5",
      notice: "佳速配置已更新",
    });
    assert.equal(await runtime.updateVendor(), fixture.source);
  } finally {
    await fixture.close();
  }
});

test("下载源码的大小或 SHA-256 不匹配时拒绝更新", async () => {
  const fixture = await createUpdateServer({ corruptHash: true });
  try {
    const runtime = loadRuntime(fixture.baseUrl);
    await assert.rejects(runtime.updateVendor(), /SHA-256/);
  } finally {
    await fixture.close();
  }
});

test("远端版本不高于本地时明确返回无更新", async () => {
  const fixture = await createUpdateServer({ version: "4.4" });
  try {
    const runtime = loadRuntime(fixture.baseUrl);
    assert.deepEqual(await runtime.checkForUpdates(), {
      hasUpdate: false,
      latestVersion: "4.4",
      notice: "佳速配置已更新",
    });
  } finally {
    await fixture.close();
  }
});

test("本地后端代理检查与下载，且不会把私有输入写入返回源码", async () => {
  const fixture = await createUpdateServer();
  const source = fs.readFileSync(templatePath, "utf8");
  try {
    assert.deepEqual(await checkRemoteVendorUpdate("tianjiang", {
      source,
      privateInputs: { updateBaseUrl: fixture.baseUrl },
    }), {
      hasUpdate: true,
      latestVersion: "4.5",
      notice: "佳速配置已更新",
    });
    assert.equal(await downloadRemoteVendorUpdate("tianjiang", {
      source,
      privateInputs: { updateBaseUrl: fixture.baseUrl },
    }), fixture.source);
  } finally {
    await fixture.close();
  }
});

test("准备安装源码时保持现有 API Key，并拒绝供应商身份替换", () => {
  const prepared = prepareVendorSourceUpdate(
    "tianjiang",
    fs.readFileSync(templatePath, "utf8"),
    { apiKey: "user-secret-key", baseUrl: "https://custom.example/v1" },
  );
  assert.equal(prepared.inputValues.apiKey, "user-secret-key");
  assert.equal(prepared.inputValues.baseUrl, "https://custom.example/v1");
  assert.doesNotMatch(prepared.source, /user-secret-key/);
  assert.throws(
    () => prepareVendorSourceUpdate(
      "other-vendor",
      fs.readFileSync(templatePath, "utf8"),
      { apiKey: "user-secret-key" },
    ),
    /供应商身份/,
  );
});

test("客户端注册独立检查与安装路由，禁止页面直接下载源码", () => {
  const checkRoute = fs.readFileSync(
    path.join(process.cwd(), "src/routes/setting/vendorConfig/checkVendorUpdate.ts"),
    "utf8",
  );
  const installRoute = fs.readFileSync(
    path.join(process.cwd(), "src/routes/setting/vendorConfig/installVendorUpdate.ts"),
    "utf8",
  );
  assert.match(checkRoute, /checkRemoteVendorUpdate/);
  assert.match(installRoute, /downloadRemoteVendorUpdate/);
  assert.match(installRoute, /applyVendorSourceUpdate/);
  assert.doesNotMatch(checkRoute + installRoute, /apiKey\s*:/);
});
