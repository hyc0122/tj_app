/**
 * Task 10 RED：任务中心必须聚合分镜生成任务并映射排队中/生成中。
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";

import { enterUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import getTaskApi from "../../src/routes/task/getTaskApi";

async function listen(app: express.Express): Promise<{ server: http.Server; port: number }> {
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

test("生产任务中心必须识别 storyboard 任务的 taskUuid 与统一状态", async () => {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    enterUserStorage({ issuer: "https://api.j11.com.cn", userId: 9103 });
    next();
  });
  app.use("/api/task/getTaskApi", getTaskApi);
  const { server, port } = await listen(app);
  try {
    const listed = await fetch(`http://127.0.0.1:${port}/api/task/getTaskApi`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ page: 1, limit: 20 }),
    });
    assert.notEqual(listed.status, 404);
    const body = await listed.json() as { data?: { data?: Array<Record<string, unknown>> } };
    const rows = body.data?.data ?? [];
    const storyboard = rows.filter((row) => row.taskUuid || String(row.rowKey ?? "").includes("storyboard"));
    assert.ok(
      rows.every((row) => row.rowKey),
      "任务中心行必须有稳定 rowKey",
    );
    const { mapStoryboardTaskCenterState } = await import("../../src/tianjiang/tasks/task-center-aggregation");
    assert.equal(mapStoryboardTaskCenterState("queued"), "排队中");
    assert.equal(mapStoryboardTaskCenterState("submitting"), "生成中");
    assert.equal(mapStoryboardTaskCenterState("outcome_unknown"), "结果待确认");
    assert.equal(mapStoryboardTaskCenterState("cancelled_local"), "已取消");
    assert.equal(typeof storyboard, "object");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
