import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import { transform } from "sucrase";

import runCode from "../../src/utils/vm";

interface VolcengineRuntime {
  vendor: {
    version: string;
    inputValues: Record<string, string>;
  };
  imageRequest: (config: Record<string, unknown>, model: Record<string, unknown>) => Promise<string>;
}

const templatePath = path.resolve(
  process.cwd(),
  "src",
  "provider-templates",
  "volcengine.ts.template",
);

function loadTemplate(baseUrl: string): VolcengineRuntime {
  const source = fs.readFileSync(templatePath, "utf8");
  const javascript = transform(source, { transforms: ["typescript"] }).code;
  const runtime = runCode(javascript, undefined, { provider: "volcengine" }) as unknown as VolcengineRuntime;
  runtime.vendor.inputValues.apiKey = "volc-test-key";
  runtime.vendor.inputValues.baseUrl = baseUrl;
  return runtime;
}

test("火山 Coding 文本地址生成图片时切换到同源 /api/v3 并保留非空诊断", async () => {
  const paths: string[] = [];
  const server = http.createServer((request, response) => {
    paths.push(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    response.statusCode = 404;
    response.setHeader("x-request-id", "volc-empty-response");
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const runtime = loadTemplate(`http://127.0.0.1:${address.port}/api/coding/v3`);
    assert.equal(runtime.vendor.version, "2.5");
    await assert.rejects(
      runtime.imageRequest({
        prompt: "生成角色立绘",
        referenceList: [],
        size: "1K",
        aspectRatio: "1:1",
      }, {
        name: "Seedream-5.0",
        modelName: "doubao-seedream-5-0-260128",
        type: "image",
        mode: ["text"],
      }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /图片生成请求失败：HTTP 404/);
        assert.match(message, /请求ID volc-empty-response/);
        assert.match(message, /火山引擎未返回错误详情/);
        assert.doesNotMatch(message, /volc-test-key/);
        return true;
      },
    );
    assert.deepEqual(paths, ["/api/v3/images/generations"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
