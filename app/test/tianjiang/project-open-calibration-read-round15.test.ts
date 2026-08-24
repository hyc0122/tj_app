/**
 * Round15 RED：依赖设置的首次读取必须等待同一轮 project_open 校准。
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";

import { enterUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import {
  activateUserDatabase,
  accountDatabase,
  destroyAllDatabaseHandles,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { closeActivatedWorkspaceRuntime, createUniqueWorktreeRoot } from "./helpers/worktree-runtime";

const identity = { issuer: "https://api.j11.com.cn", userId: 1510 };

async function listen(app: express.Express) {
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

test("并发打开后立即 getModelList 必须先返回本地缓存，不得阻塞校准", async () => {
  const root = createUniqueWorktreeRoot("open-calibrate-read");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    enterUserStorage(identity);

    let resolveCalibration: (() => void) | undefined;
    const calibration = new Promise<void>((resolve) => {
      resolveCalibration = resolve;
    });
    const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
    adapter.bindSettingsDependentRead?.(calibration);

    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) => {
      enterUserStorage(identity);
      next();
    });
    const { default: getModelList } = await import("../../src/routes/modelSelect/getModelList");
    app.use("/api/modelSelect/getModelList", getModelList);
    const { server, port } = await listen(app);
    try {
      const started = Date.now();
      const pending = fetch(`http://127.0.0.1:${port}/api/modelSelect/getModelList`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "image" }),
      });
      const response = await pending;
      const elapsed = Date.now() - started;
      assert.equal(response.status, 200);
      const body = await response.json() as { data?: { calibrationState?: string; items?: unknown[] } };
      assert.ok(elapsed < 200, `缓存 getModelList 不得阻塞在校准上，实际=${elapsed}ms`);
      assert.ok((body.data?.items?.length ?? 0) > 0, "校准中本地模型必须可见");
      assert.ok(resolveCalibration, "校准句柄必须存在");
      resolveCalibration();
    } finally {
      adapter.bindSettingsDependentRead(null);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});
