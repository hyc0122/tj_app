import assert from "node:assert/strict";
import test from "node:test";

import { SyncProgressStore } from "../../src/tianjiang/runtime/sync-progress";

test("进度单调递增，operationId 隔离迟到事件，敏感 URL 脱敏", () => {
  const store = new SyncProgressStore();
  store.begin({
    operationId: "op-1",
    intent: "close_project",
    totalProjects: 2,
    projectUuid: "p1",
    projectName: "Demo",
    projectKind: "personal",
  });
  store.update({
    operationId: "op-1",
    phase: "uploading",
    completedObjects: 1,
    totalObjects: 5,
    objectIndex: 1,
    objectTotal: 5,
    uploadedBytes: 100,
    totalBytes: 500,
  });
  store.update({
    operationId: "op-1",
    completedObjects: 0, // 不得回退
    uploadedBytes: 50,
  });
  let snap = store.get();
  assert.equal(snap.completedObjects, 1);
  assert.equal(snap.uploadedBytes, 100);
  assert.equal(snap.state, "running");

  // 迟到事件
  store.update({
    operationId: "old-op",
    completedObjects: 99,
  });
  snap = store.get();
  assert.equal(snap.completedObjects, 1);

  store.fail("op-1", "HTTP_503", "failed https://oss.example/a?signature=secret token=abc");
  snap = store.get();
  assert.equal(snap.state, "failed");
  assert.doesNotMatch(String(snap.errorMessage), /signature=secret|token=abc/);
  assert.match(String(snap.errorMessage), /redacted/i);
});
