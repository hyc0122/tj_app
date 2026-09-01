import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { runWithTemporaryAccount } from "./helpers/worktree-runtime";
import { defaultCredentialStore } from "../../src/tianjiang/crypto/default-credential-store";
import { currentUserStorage } from "../../src/tianjiang/runtime/user-storage-context";

const SENTINEL = "RED_EXPECTED:CANVAS_PROVIDER_RAW_INBOX";

test("raw inbox 必须按账号+项目隔离加密，跨账号解密失败关闭", async () => {
  const modulePath = path.resolve(
    __dirname,
    "../../src/tianjiang/canvas/canvas-provider-raw-inbox.ts",
  );
  if (!fs.existsSync(modulePath)) {
    console.error(SENTINEL);
    assert.fail(SENTINEL);
  }
  await runWithTemporaryAccount("canvas-raw-inbox-a", async () => {
    const inbox = await import("../../src/tianjiang/canvas/canvas-provider-raw-inbox");
    const captured = await inbox.captureProviderRawEvent({
      projectUuid: "018f3d6e-2d9e-7b6c-8a9b-000000001041",
      runUuid: "018f3d6e-2d9e-7b6c-8a9b-000000001042",
      eventId: "raw-1",
      payload: { Authorization: "Bearer secret-canary-KEY", body: "ok" },
    });
    const replay = await inbox.captureProviderRawEvent({
      projectUuid: "018f3d6e-2d9e-7b6c-8a9b-000000001041",
      runUuid: "018f3d6e-2d9e-7b6c-8a9b-000000001042",
      eventId: "raw-1",
      payload: { Authorization: "Bearer secret-canary-KEY", body: "ok" },
    });
    if (!captured.recordId || replay.duplicate !== true || captured.state !== "captured") {
      console.error(SENTINEL);
      assert.equal(replay.duplicate, true, SENTINEL);
    }
    const context = currentUserStorage();
    const keyName = `canvas-raw-inbox-key:${context?.segment ?? ""}`;
    const storedKey = defaultCredentialStore.get(keyName);
    const publicSeedKey = crypto.createHash("sha256")
      .update(`tianjiang-raw-inbox:${context?.issuer ?? "local"}:${context?.userId ?? 0}`)
      .digest("base64");
    assert.equal(Buffer.from(storedKey ?? "", "base64").length, 32, SENTINEL);
    assert.notEqual(storedKey, publicSeedKey, SENTINEL);
  }, 7601);
  await runWithTemporaryAccount("canvas-raw-inbox-b", async () => {
    const inbox = await import("../../src/tianjiang/canvas/canvas-provider-raw-inbox");
    let isolated = false;
    try {
      await inbox.readProviderRawEvent("018f3d6e-2d9e-7b6c-8a9b-000000001041", "018f3d6e-2d9e-7b6c-8a9b-000000001042", "raw-1");
    } catch {
      isolated = true;
    }
    if (!isolated) {
      console.error(SENTINEL);
      assert.equal(isolated, true, SENTINEL);
    }
  }, 7602);
});
