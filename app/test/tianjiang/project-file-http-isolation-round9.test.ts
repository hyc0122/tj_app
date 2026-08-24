import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import { writeProjectFileAtomic } from "../../src/tianjiang/media/project-file-store";
import { userStorageSegment } from "../../src/tianjiang/runtime/user-storage-context";

const workspaceTempRoot = path.resolve(__dirname, "../../../.tmp");
fs.mkdirSync(workspaceTempRoot, { recursive: true });

test("项目文件 HTTP 路由对跨账号/跨项目/越界统一返回不存在", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-file-http-"));
  const projectUuid = "018f3d6e-2d9e-7b6c-8a9b-000000000094";
  const otherUuid = "018f3d6e-2d9e-7b6c-8a9b-000000000095";
  const sessionA = {
    serverUrl: "https://api.example.invalid",
    user: { id: 7, username: "alice" },
  };
  const sessionB = {
    serverUrl: "https://api.example.invalid",
    user: { id: 8, username: "bob" },
  };
  const segmentA = userStorageSegment({ issuer: sessionA.serverUrl, userId: sessionA.user.id });
  const segmentB = userStorageSegment({ issuer: sessionB.serverUrl, userId: sessionB.user.id });

  const worktreeRoot = path.resolve(__dirname, "../../..");
  const previousDataRoot = process.env.TIANJIANG_TEST_DATA_ROOT;
  const previousWorktree = process.env.TIANJIANG_TEST_WORKTREE_ROOT;
  process.env.TIANJIANG_TEST_DATA_ROOT = dataRoot;
  process.env.TIANJIANG_TEST_WORKTREE_ROOT = worktreeRoot;

  writeProjectFileAtomic(
    dataRoot,
    projectUuid,
    segmentA,
    "files/images/secret.png",
    Buffer.from("owner-only"),
  );

  // 生产 Express router：真实 HTTP 请求
  const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
  const { syncCoordinator } = await import("../../src/tianjiang/runtime/runtime");
  const listSpy = (syncCoordinator as { listProjects: (s: unknown) => Array<{ projectUuid: string }> })
    .listProjects;
  (syncCoordinator as { listProjects: (s: unknown) => Array<{ projectUuid: string }> }).listProjects = (
    session: unknown,
  ) => {
    const s = session as { user?: { id?: number } };
    if (s?.user?.id === 7) return [{ projectUuid }];
    return [];
  };

  const app = express();
  app.use((req, _res, next) => {
    (req as { centralSession?: unknown }).centralSession = (req.headers["x-test-session"] === "b")
      ? sessionB
      : sessionA;
    next();
  });
  app.use("/api/tianjiang/runtime", runtimeRouter);

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  try {
    const ownerOk = await fetch(
      `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${projectUuid}/files/images/secret.png`,
      { headers: { "x-test-session": "a" } },
    );
    assert.equal(ownerOk.status, 200);
    assert.deepEqual(Buffer.from(await ownerOk.arrayBuffer()), Buffer.from("owner-only"));

    const crossUser = await fetch(
      `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${projectUuid}/files/images/secret.png`,
      { headers: { "x-test-session": "b" } },
    );
    assert.equal(crossUser.status, 404);

    const crossProject = await fetch(
      `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${otherUuid}/files/images/secret.png`,
      { headers: { "x-test-session": "a" } },
    );
    assert.equal(crossProject.status, 404);

    const escape = await fetch(
      `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${projectUuid}/files/../project.sqlite`,
      { headers: { "x-test-session": "a" } },
    );
    assert.ok(escape.status === 404 || escape.status === 400);
    void segmentB;
  } finally {
    (syncCoordinator as { listProjects: typeof listSpy }).listProjects = listSpy;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousDataRoot === undefined) delete process.env.TIANJIANG_TEST_DATA_ROOT;
    else process.env.TIANJIANG_TEST_DATA_ROOT = previousDataRoot;
    if (previousWorktree === undefined) delete process.env.TIANJIANG_TEST_WORKTREE_ROOT;
    else process.env.TIANJIANG_TEST_WORKTREE_ROOT = previousWorktree;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
