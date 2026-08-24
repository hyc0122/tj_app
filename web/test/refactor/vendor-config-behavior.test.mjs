import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let viteServer;
let logic;

before(async () => {
  viteServer = await createServer({
    root: process.cwd(),
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
  });
  logic = await viteServer.ssrLoadModule(
    "/src/components/setting/components/vendorConfig/vendorConfigLogic.ts",
  );
});

after(async () => {
  await viteServer?.close();
});

test("供应商版本与输入快照保持旧页面判断规则", () => {
  assert.equal(logic.needsVendorUpdate({ version: undefined }), true);
  assert.equal(logic.needsVendorUpdate({ version: "1.9" }), true);
  assert.equal(logic.needsVendorUpdate({ version: "2.0" }), false);
  assert.deepEqual(
    logic.buildVendorUpdatePayload({
      id: "vendor-a",
      inputValues: { apiKey: "local-only", baseUrl: "https://api.example.test" },
    }),
    {
      id: "vendor-a",
      inputValues: { apiKey: "local-only", baseUrl: "https://api.example.test" },
    },
  );
});

test("视频模型多参考模式编码和回显保持数量", () => {
  const encoded = logic.buildVideoModes(
    ["singleImage", "multiReference"],
    ["videoReference", "audioReference"],
    { videoReference: 2, audioReference: 1 },
  );
  assert.deepEqual(encoded, [
    "singleImage",
    ["videoReference:2", "audioReference:1"],
  ]);

  assert.deepEqual(logic.parseVideoModes(encoded), {
    mode: ["singleImage", "multiReference"],
    mixedMode: ["videoReference", "audioReference"],
    mixedModeCount: { videoReference: 2, audioReference: 1 },
  });
});

test("时长分辨率只保留正数时长和非空分辨率", () => {
  assert.deepEqual(
    logic.normalizeDurationResolutionRows([
      { duration: ["5", "0", "bad"], resolution: ["720p", ""] },
      { duration: ["10"], resolution: ["1080p"] },
    ]),
    {
      ok: true,
      rows: [
        { duration: [5], resolution: ["720p"] },
        { duration: [10], resolution: ["1080p"] },
      ],
    },
  );
  assert.deepEqual(
    logic.normalizeDurationResolutionRows([
      { duration: [], resolution: ["720p"] },
    ]),
    { ok: false, rowIndex: 0, field: "duration" },
  );
});
