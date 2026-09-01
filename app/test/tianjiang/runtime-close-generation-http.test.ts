/**
 * 外部 POST /projects/:uuid/close 必须要求有效正安全整数 runtimeGeneration。
 * 缺失或非法返回 400，绝不能回退当前代次。
 */
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import test from "node:test";

import runtimeRouter from "../../src/routes/tianjiang/runtime";
import { ProjectRuntimeActivationGate } from "../../src/tianjiang/runtime/project-runtime-activation";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";

const UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02";

async function withCloseServer(
  run: (input: { origin: string; closeCalls: unknown[][] }) => Promise<void>,
): Promise<void> {
  const closeCalls: unknown[][] = [];
  const original = syncCoordinator.closeProject.bind(syncCoordinator);
  syncCoordinator.closeProject = (async (...args: unknown[]) => {
    closeCalls.push(args);
    return { ignored: false, projectUuid: UUID, runtimeGeneration: 0 };
  }) as typeof syncCoordinator.closeProject;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { centralSession?: unknown }).centralSession = {
      serverUrl: "https://api.j11.com.cn",
      user: { id: 2 },
    };
    next();
  });
  app.use(runtimeRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run({ origin: `http://127.0.0.1:${address.port}`, closeCalls });
  } finally {
    syncCoordinator.closeProject = original;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function postClose(origin: string, body: unknown): Promise<{ status: number; payload: Record<string, unknown> }> {
  const response = await fetch(`${origin}/projects/${UUID}/close`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    payload: await response.json() as Record<string, unknown>,
  };
}

test("open 旧代次后再 open 新代次：无 token / 非法 token 的外部 close 必须 400 且不得回退当前代次", async () => {
  const gate = new ProjectRuntimeActivationGate();
  const oldGen = gate.issueOpenGeneration(UUID);
  const newGen = gate.issueOpenGeneration(UUID);
  assert.ok(newGen > oldGen);
  await withCloseServer(async ({ origin, closeCalls }) => {
    const missing = await postClose(origin, {});
    assert.equal(missing.status, 400);
    assert.equal(closeCalls.length, 0, "缺失 runtimeGeneration 不得调用 closeProject");
    assert.equal(gate.currentGeneration(UUID), newGen);

    for (const illegal of [0, -1, 1.5, "abc", null, Number.MAX_SAFE_INTEGER + 1]) {
      const result = await postClose(origin, { runtimeGeneration: illegal });
      assert.equal(result.status, 400, `非法 token ${String(illegal)} 必须 400`);
    }
    assert.equal(closeCalls.length, 0);
    assert.equal(gate.currentGeneration(UUID), newGen);

    const valid = await postClose(origin, { runtimeGeneration: newGen });
    assert.equal(valid.status, 200);
    assert.equal(closeCalls.length, 1);
    assert.equal(closeCalls[0]![2], newGen);
  });
});

test("内部 closeProjectInternal 可不携带外部 token，使用当前代次", async () => {
  assert.equal(typeof (syncCoordinator as { closeProjectInternal?: unknown }).closeProjectInternal, "function");
});
