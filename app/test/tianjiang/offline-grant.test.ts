import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateOfflineWrite,
  type CachedOfflineGrant,
} from "../../src/tianjiang/auth/offline-grant";

const grant: CachedOfflineGrant = {
  grantId: "grant-1",
  userId: 7,
  deviceUuid: "018f3d6e-2d9e-7b6c-8a9b-1234567890ab",
  expiresAt: "2026-07-29T13:00:00Z",
};

test("有效离线授权只允许本人的本地个人项目", () => {
  const now = new Date("2026-07-29T12:00:00Z");
  assert.equal(evaluateOfflineWrite(grant, {
    userId: 7, deviceUuid: grant.deviceUuid, projectKind: "personal",
    projectOwnerId: 7, now,
  }).allowed, true);
  assert.equal(evaluateOfflineWrite(grant, {
    userId: 7, deviceUuid: grant.deviceUuid, projectKind: "team",
    projectOwnerId: 7, now,
  }).allowed, false);
  assert.equal(evaluateOfflineWrite(grant, {
    userId: 8, deviceUuid: grant.deviceUuid, projectKind: "personal",
    projectOwnerId: 8, now,
  }).allowed, false);
});

test("离线缓存过期后不能继续写入", () => {
  const decision = evaluateOfflineWrite(grant, {
    userId: 7, deviceUuid: grant.deviceUuid, projectKind: "personal",
    projectOwnerId: 7, now: new Date("2026-07-29T13:00:01Z"),
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "OFFLINE_GRANT_EXPIRED");
});
