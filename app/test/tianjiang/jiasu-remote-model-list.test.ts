import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import * as vendorUtils from "../../src/utils/vendor";

const appRoot = path.resolve(process.cwd());
const templatePath = path.join(appRoot, "src", "provider-templates", "tianjiang.ts.template");

test("本地后端注入已保存密钥并只返回去重后的远端模型元数据", async () => {
  const listRemoteModels = (vendorUtils as typeof vendorUtils & {
    listRemoteModels?: (
      id: string,
      options: { source: string; privateInputs: Record<string, string> },
    ) => Promise<Array<Record<string, unknown>>>;
  }).listRemoteModels;
  assert.equal(typeof listRemoteModels, "function", "应提供受控的远端模型列表执行入口");

  const requests: Array<{ authorization?: string }> = [];
  const server = http.createServer((request, response) => {
    requests.push({ authorization: request.headers.authorization });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      data: [
        { id: "model-b", object: "model", created: 2, owned_by: "jiasu" },
        { id: "model-a", object: "model", created: 1, owned_by: "jiasu" },
        { id: "model-b", object: "model", created: 2, owned_by: "jiasu" },
        { id: "" },
      ],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const models = await listRemoteModels!("tianjiang", {
      source: fs.readFileSync(templatePath, "utf8"),
      privateInputs: {
        apiKey: "saved-private-key",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      },
    });
    assert.deepEqual(models, [
      { id: "model-b", object: "model", created: 2, owned_by: "jiasu" },
      { id: "model-a", object: "model", created: 1, owned_by: "jiasu" },
    ]);
    assert.deepEqual(requests, [{ authorization: "Bearer saved-private-key" }]);
    assert.doesNotMatch(JSON.stringify(models), /saved-private-key/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
