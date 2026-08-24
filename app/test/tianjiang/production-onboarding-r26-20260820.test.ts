import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import express from "express";

import {
  parseClientGuideId,
  parsePutGuideStateBody,
} from "../../src/tianjiang/client-state/contracts";
import { OnboardingStore } from "../../src/tianjiang/client-state/onboarding-store";
import {
  createProductionGuideRouter,
} from "../../src/routes/tianjiang/client-state/productionGuide";

const tempRoot = path.resolve(
  process.env.TIANJIANG_TEST_WORKTREE_ROOT ?? path.join(process.cwd(), ".."),
  ".tmp",
  "production-onboarding-r26",
);

function makeTempDir(name: string): string {
  fs.mkdirSync(tempRoot, { recursive: true });
  return fs.mkdtempSync(path.join(tempRoot, `${name}-`));
}

async function startGuideServer(options: {
  dataRoot: string;
  userId?: number;
  deviceUuid: string;
}): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (options.userId != null) {
      (req as express.Request & { user?: { id: number } }).user = {
        id: options.userId,
      };
    }
    next();
  });
  app.use(
    "/api/tianjiang/client-state/productionGuide",
    createProductionGuideRouter({
      dataRoot: options.dataRoot,
      deviceUuid: () => options.deviceUuid,
    }),
  );

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/tianjiang/client-state/productionGuide`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

test("R26 production guide 与 hello 分离，并按账号/设备隔离且 revision 不倒退", () => {
  const root = makeTempDir("store");
  try {
    const store = new OnboardingStore(root);
    store.put(11, "device-aaaaaaaa", 7);
    store.putGuide("production", 11, "device-aaaaaaaa", 2);
    store.putGuide("production", 11, "device-aaaaaaaa", 1);

    assert.equal(store.get(11, "device-aaaaaaaa")?.completedRevision, 7);
    assert.equal(
      store.getGuide("production", 11, "device-aaaaaaaa")?.completedRevision,
      2,
    );
    assert.equal(store.getGuide("production", 12, "device-aaaaaaaa"), null);
    assert.equal(store.getGuide("production", 11, "device-bbbbbbbb"), null);
    assert.throws(
      () => parseClientGuideId("../production"),
      /Invalid|guide|production|hello/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("R26 production guide renderer 只提交 revision，跨 renderer 端口仍读取稳定完成态", async () => {
  const root = makeTempDir("route");
  const deviceUuid = "device-r26-stable";
  let first: Awaited<ReturnType<typeof startGuideServer>> | null = null;
  let second: Awaited<ReturnType<typeof startGuideServer>> | null = null;
  let otherAccount: Awaited<ReturnType<typeof startGuideServer>> | null = null;
  try {
    assert.deepEqual(parsePutGuideStateBody({ completedRevision: 3 }), {
      completedRevision: 3,
    });
    assert.throws(() => parsePutGuideStateBody({
      completedRevision: 3,
      businessUserId: 999,
      deviceUuid: "renderer-controlled",
    }));

    first = await startGuideServer({ dataRoot: root, userId: 21, deviceUuid });
    const initial = await fetch(first.baseUrl).then((response) => response.json());
    assert.equal(initial.data.guideId, "production");
    assert.equal(initial.data.completedRevision, 0);

    const rejectedIdentity = await fetch(first.baseUrl, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        completedRevision: 1,
        businessUserId: 999,
        deviceUuid: "renderer-controlled",
      }),
    });
    assert.equal(rejectedIdentity.status, 400);

    const saved = await fetch(first.baseUrl, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ completedRevision: 1 }),
    }).then((response) => response.json());
    assert.equal(saved.data.businessUserId, 21);
    assert.equal(saved.data.deviceUuid, deviceUuid);
    assert.equal(saved.data.completedRevision, 1);
    await first.close();
    first = null;

    // 中文注释：换一个监听端口模拟 Electron renderer origin 变化，状态必须仍来自 App 稳定目录。
    second = await startGuideServer({ dataRoot: root, userId: 21, deviceUuid });
    const restored = await fetch(second.baseUrl).then((response) => response.json());
    assert.equal(restored.data.completedRevision, 1);

    otherAccount = await startGuideServer({ dataRoot: root, userId: 22, deviceUuid });
    const isolated = await fetch(otherAccount.baseUrl).then((response) => response.json());
    assert.equal(isolated.data.completedRevision, 0);
  } finally {
    await first?.close();
    await second?.close();
    await otherAccount?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("R26 production guide 未登录拒绝，存储异常只返回脱敏中文错误", async () => {
  const root = makeTempDir("safe-error");
  const poison = path.join(root, "not-a-directory");
  fs.writeFileSync(poison, "secret-path-marker", "utf8");
  let unauthorized: Awaited<ReturnType<typeof startGuideServer>> | null = null;
  let broken: Awaited<ReturnType<typeof startGuideServer>> | null = null;
  let corrupted: Awaited<ReturnType<typeof startGuideServer>> | null = null;
  try {
    unauthorized = await startGuideServer({
      dataRoot: root,
      deviceUuid: "device-unauthorized",
    });
    const unauthorizedResponse = await fetch(unauthorized.baseUrl);
    assert.equal(unauthorizedResponse.status, 401);

    broken = await startGuideServer({
      dataRoot: poison,
      userId: 31,
      deviceUuid: "device-broken-store",
    });
    const response = await fetch(broken.baseUrl, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ completedRevision: 1 }),
    });
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.equal(body.code, "PRODUCTION_GUIDE_STATE_SAVE_FAILED");
    assert.equal(body.message, "新手引导状态保存失败，请稍后重试");
    assert.doesNotMatch(JSON.stringify(body), /not-a-directory|secret-path-marker|ENOENT|ENOTDIR/i);

    const corruptedDevice = "device-corrupted-state";
    const corruptedFile = path.join(
      root,
      "client-state",
      "guides",
      "production",
      "user-32",
      `${corruptedDevice}.json`,
    );
    fs.mkdirSync(path.dirname(corruptedFile), { recursive: true });
    fs.writeFileSync(corruptedFile, "{private-path-marker", "utf8");
    corrupted = await startGuideServer({
      dataRoot: root,
      userId: 32,
      deviceUuid: corruptedDevice,
    });
    const corruptedResponse = await fetch(corrupted.baseUrl);
    const corruptedBody = await corruptedResponse.json();
    assert.equal(corruptedResponse.status, 500);
    assert.equal(corruptedBody.code, "PRODUCTION_GUIDE_STATE_READ_FAILED");
    assert.equal(corruptedBody.message, "新手引导状态读取失败，请稍后重试");
    assert.doesNotMatch(JSON.stringify(corruptedBody), /private-path-marker|SyntaxError|guides/i);
  } finally {
    await unauthorized?.close();
    await broken?.close();
    await corrupted?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
