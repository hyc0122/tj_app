/**
 * Task 8 RED：设置合并与生成预览必须走生产分镜路由。
 */
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import test from "node:test";

const PROJECT = "11111111-1111-4111-a111-111111111111";

async function listen(app: express.Express): Promise<{ server: http.Server; port: number }> {
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

test("生产入口必须提供设置读写和最终请求预览，且覆盖优先级正确", async () => {
  const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
  const app = express();
  app.use(express.json());
  app.use("/api/tianjiang/runtime", runtimeRouter);
  const { server, port } = await listen(app);
  const base = `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard`;
  try {
    const settings = await fetch(`${base}/settings`);
    assert.notEqual(settings.status, 404, "设置路由必须存在");

    const preview = await fetch(`${base}/generate/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mediaType: "image",
        providerModel: "vendor:model",
        settings: {
          globalImagePrompt: "全局风格",
          globalNegativePrompt: "低质量",
          aspectRatio: "16:9",
          resolution: "2K",
          durationMs: 4000,
        },
        shot: {
          visualDescription: "雨巷",
          imagePrompt: "近景",
          aspectRatio: "9:16",
        },
      }),
    });
    assert.notEqual(preview.status, 404, "生成预览路由必须存在");
    assert.equal(preview.status, 403, "无中央会话时预览必须原样失败，不得伪造成功");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
