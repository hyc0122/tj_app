import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import express from "express";

import { ServeReadinessGate } from "../../src/tianjiang/runtime/serve-readiness";

test("关闭门立即拒绝新 HTTP，并等待已经进入的请求结束", async () => {
  const gate = new ServeReadinessGate();
  gate.startAccepting();
  const app = express();
  app.use(gate.middleware());

  let releaseRequest!: () => void;
  const requestReleased = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  let requestEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    requestEntered = resolve;
  });
  app.get("/hold", async (_request, response) => {
    requestEntered();
    await requestReleased;
    response.status(200).send("done");
  });
  app.get("/new", (_request, response) => response.status(200).send("unexpected"));

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseURL = `http://127.0.0.1:${address.port}`;

  try {
    const activeRequest = fetch(`${baseURL}/hold`);
    await entered;
    gate.beginClosing();

    const rejected = await fetch(`${baseURL}/new`);
    assert.equal(rejected.status, 503);
    assert.deepEqual(await rejected.json(), {
      code: 503,
      message: "本地服务正在安全关闭",
    });

    let drained = false;
    const waiting = gate.waitForDrain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    assert.equal(drained, false, "活动请求未结束时不得进入数据库关闭阶段");

    releaseRequest();
    assert.equal((await activeRequest).status, 200);
    await waiting;
    assert.equal(gate.snapshot().activeRequestCount, 0);
  } finally {
    releaseRequest();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("安装请求可从活动集合摘除，避免等待自身响应造成退出死锁", async () => {
  const gate = new ServeReadinessGate();
  gate.startAccepting();
  const token = gate.beginTrackedRequestForTest();

  assert.equal(gate.snapshot().activeRequestCount, 1);
  gate.runWithRequest(token, () => gate.detachCurrentRequest());
  gate.beginClosing();
  await gate.waitForDrain();

  assert.equal(gate.snapshot().activeRequestCount, 0);
  token.finish();
});
