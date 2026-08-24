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

test("受保护项目视频路由为 AVI/WebM/MOV/MKV 返回正确 MIME 且保留 Range/HEAD", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-video-mime-"));
  const projectUuid = "018f3d6e-2d9e-7b6c-8a9b-0000000000f3";
  const session = {
    serverUrl: "https://api.example.invalid",
    user: { id: 26, username: "video-mime" },
  };
  const segment = userStorageSegment({ issuer: session.serverUrl, userId: session.user.id });
  const worktreeRoot = path.resolve(__dirname, "../../..");
  const previousDataRoot = process.env.TIANJIANG_TEST_DATA_ROOT;
  const previousWorktree = process.env.TIANJIANG_TEST_WORKTREE_ROOT;
  process.env.TIANJIANG_TEST_DATA_ROOT = dataRoot;
  process.env.TIANJIANG_TEST_WORKTREE_ROOT = worktreeRoot;

  const fixtures = [
    { name: "reference.avi", mime: "video/x-msvideo" },
    { name: "reference.webm", mime: "video/webm" },
    { name: "reference.mov", mime: "video/quicktime" },
    { name: "reference.mkv", mime: "video/x-matroska" },
  ];
  const bytes = Buffer.from("0123456789abcdef", "ascii");
  for (const fixture of fixtures) {
    writeProjectFileAtomic(
      dataRoot,
      projectUuid,
      segment,
      `files/videos/${fixture.name}`,
      bytes,
    );
  }

  const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
  const { syncCoordinator } = await import("../../src/tianjiang/runtime/runtime");
  const originalListProjects = (
    syncCoordinator as { listProjects: (current: unknown) => Array<{ projectUuid: string }> }
  ).listProjects;
  (syncCoordinator as { listProjects: (current: unknown) => Array<{ projectUuid: string }> }).listProjects =
    () => [{ projectUuid }];

  const app = express();
  app.use((req, _res, next) => {
    (req as { centralSession?: unknown }).centralSession = session;
    next();
  });
  app.use("/api/tianjiang/runtime", runtimeRouter);
  const server = await new Promise<http.Server>((resolve) => {
    const running = app.listen(0, "127.0.0.1", () => resolve(running));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  try {
    for (const fixture of fixtures) {
      const url = `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${projectUuid}/files/videos/${fixture.name}`;
      const head = await fetch(url, { method: "HEAD" });
      assert.equal(head.status, 200, fixture.name);
      assert.equal(head.headers.get("content-type"), fixture.mime, fixture.name);
      assert.equal(head.headers.get("accept-ranges"), "bytes", fixture.name);
      assert.equal(head.headers.get("content-length"), String(bytes.length), fixture.name);
      assert.equal((await head.arrayBuffer()).byteLength, 0, fixture.name);
    }

    const range = await fetch(
      `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${projectUuid}/files/videos/reference.avi`,
      { headers: { range: "bytes=2-5" } },
    );
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("content-type"), "video/x-msvideo");
    assert.equal(range.headers.get("content-range"), `bytes 2-5/${bytes.length}`);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(2, 6));
  } finally {
    (
      syncCoordinator as { listProjects: typeof originalListProjects }
    ).listProjects = originalListProjects;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousDataRoot === undefined) delete process.env.TIANJIANG_TEST_DATA_ROOT;
    else process.env.TIANJIANG_TEST_DATA_ROOT = previousDataRoot;
    if (previousWorktree === undefined) delete process.env.TIANJIANG_TEST_WORKTREE_ROOT;
    else process.env.TIANJIANG_TEST_WORKTREE_ROOT = previousWorktree;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
