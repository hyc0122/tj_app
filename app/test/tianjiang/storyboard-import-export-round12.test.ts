/**
 * Task 7 RED：导入导出必须打到生产 HTTP 合同，不能静态导入尚未创建的解析模块。
 */
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import test from "node:test";

const PROJECT = "11111111-1111-4111-a111-111111111111";

async function createProductionApp(): Promise<express.Express> {
  const app = express();
  app.use(express.json({ limit: "4mb" }));
  app.use((req, _res, next) => {
    (req as { centralSession?: unknown }).centralSession = {
      serverUrl: "https://api.j11.com.cn",
      user: { id: 7, username: "alice" },
    };
    next();
  });
  const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
  app.use("/api/tianjiang/runtime", runtimeRouter);
  try {
    const extra = await import("../../src/routes/tianjiang/storyboard-http");
    app.use("/api/tianjiang/storyboard", extra.default);
  } catch {
    // GREEN 之前生产入口尚未挂载导入导出路由，测试应得到真实 404。
  }
  return app;
}

async function listen(app: express.Express): Promise<{ server: http.Server; port: number }> {
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

function txtFixture(): string {
  return `\uFEFF小节：1｜估时15秒\n英雄走进雨巷。\n小节: 2 | 估时 8 秒\n镜头切到屋顶。\n视频段：3\n空行应被忽略。\n`;
}

test("生产入口必须提供 preview/commit/export，TXT 预览保留时长且不写库", async () => {
  const app = await createProductionApp();
  const { server, port } = await listen(app);
  const base = `http://127.0.0.1:${port}/api/tianjiang/storyboard/${PROJECT}`;
  try {
    const preview = await fetch(`${base}/import/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        format: "txt",
        fileName: "shots.txt",
        contentBase64: Buffer.from(txtFixture(), "utf8").toString("base64"),
      }),
    });
    assert.notEqual(preview.status, 404, "preview 路由必须存在");
    assert.equal(preview.status, 200);
    const body = await preview.json() as {
      data?: { rows?: Array<{ durationMs?: number | null; sourceText?: string }>; digest?: string };
    };
    assert.ok(Array.isArray(body.data?.rows));
    assert.equal(body.data!.rows![0]!.durationMs, 15_000);
    assert.equal(body.data!.rows![1]!.durationMs, 8_000);
    assert.match(String(body.data!.rows![0]!.sourceText), /雨巷/);
    assert.ok(body.data!.digest);

    const commit = await fetch(`${base}/import/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        format: "txt",
        fileName: "shots.txt",
        contentBase64: Buffer.from(txtFixture(), "utf8").toString("base64"),
        previewDigest: body.data!.digest,
        mode: "append",
        afterShotUuid: null,
      }),
    });
    assert.notEqual(commit.status, 404, "commit 路由必须存在");

    const exported = await fetch(`${base}/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ format: "csv" }),
    });
    assert.notEqual(exported.status, 404, "export 路由必须存在");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("超大文件和非法时长必须定位失败，摘要变化不得提交", async () => {
  const app = await createProductionApp();
  const { server, port } = await listen(app);
  const base = `http://127.0.0.1:${port}/api/tianjiang/storyboard/${PROJECT}`;
  try {
    const huge = await fetch(`${base}/import/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        format: "csv",
        fileName: "big.csv",
        contentBase64: Buffer.alloc(2 * 1024 * 1024 + 32, 65).toString("base64"),
      }),
    });
    assert.notEqual(huge.status, 404);
    assert.ok(huge.status >= 400);

    const bad = await fetch(`${base}/import/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        format: "csv",
        fileName: "bad.csv",
        contentBase64: Buffer.from("脚本,时长毫秒\n一场戏,abc\n", "utf8").toString("base64"),
      }),
    });
    assert.equal(bad.status, 200);
    const preview = await bad.json() as { data?: { errors?: Array<{ sourceRow?: number }> } };
    assert.ok((preview.data?.errors?.length ?? 0) > 0);
    assert.equal(preview.data!.errors![0]!.sourceRow, 2);

    const changed = await fetch(`${base}/import/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        format: "txt",
        fileName: "shots.txt",
        contentBase64: Buffer.from("小节：1｜估时1秒\nA\n", "utf8").toString("base64"),
        previewDigest: "stale-digest",
        mode: "append",
      }),
    });
    assert.notEqual(changed.status, 404);
    const payload = await changed.json() as { code?: string; message?: string };
    assert.match(String(payload.code ?? payload.message ?? ""), /STORYBOARD_IMPORT_CONTENT_CHANGED|内容已变化/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
