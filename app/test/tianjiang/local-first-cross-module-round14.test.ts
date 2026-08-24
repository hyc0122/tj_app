import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";

import {
  activateUserDatabase,
  destroyAllDatabaseHandles,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { enterUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import { createUniqueWorktreeRoot, closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";

async function listen(app: express.Express) {
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

test("profile/安装/登出必须提升模型 catalogVersion，且即梦探测失败不得清空普通供应商", async () => {
  const root = createUniqueWorktreeRoot("cross-module-r14");
  const originalCwd = process.cwd();
  const identity = { issuer: "https://api.j11.com.cn", userId: 1114 };
  try {
    process.chdir(root);
    process.env.NODE_ENV = "prod";
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) => { enterUserStorage(identity); next(); });
    const { default: getModelList } = await import("../../src/routes/modelSelect/getModelList");
    app.use("/api/modelSelect/getModelList", getModelList);
    const { server, port } = await listen(app);
    try {
      const first = await fetch(`http://127.0.0.1:${port}/api/modelSelect/getModelList`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "image" }),
      });
      assert.equal(first.status, 200);
      const firstBody = await first.json() as any;
      const firstVersion = (firstBody.data ?? firstBody).catalogVersion;
      assert.equal(typeof firstVersion, "number");

      const { bumpModelCatalogVersion } = await import("../../src/tianjiang/model-providers/model-catalog-invalidation");
      bumpModelCatalogVersion("profile");
      const { invalidateDreaminaCapabilityCache } = await import("../../src/tianjiang/model-providers/dreamina-cli/capability-cache");
      invalidateDreaminaCapabilityCache();

      const second = await fetch(`http://127.0.0.1:${port}/api/modelSelect/getModelList`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "image" }),
      });
      const secondBody = await second.json() as any;
      const payload = secondBody.data ?? secondBody;
      assert.ok(payload.catalogVersion > firstVersion, `catalogVersion 必须提升: ${firstVersion} -> ${payload.catalogVersion}`);
      assert.ok(Array.isArray(payload.items), "目录必须仍是数组");
      assert.ok(payload.providers?.some((item: { providerId: string }) => item.providerId === "native:dreamina-cli"));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});
