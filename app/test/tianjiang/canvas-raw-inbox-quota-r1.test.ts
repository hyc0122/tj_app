import assert from "node:assert/strict";
import test from "node:test";

import { runWithTemporaryAccount } from "./helpers/worktree-runtime";

process.env.NODE_ENV = "test";

const SENTINEL = "RED_EXPECTED:CANVAS_RAW_INBOX_QUOTA";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000001071";
const RUN_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000001072";

test("raw inbox 必须执行 24h TTL、账号配额、单事件大小与超限清理", async () => {
  await runWithTemporaryAccount("canvas-raw-inbox-quota", async () => {
    const inbox = await import("../../src/tianjiang/canvas/canvas-provider-raw-inbox");
    if (
      typeof inbox.setRawInboxClock !== "function"
      || typeof inbox.setRawInboxLimitsForTest !== "function"
      || typeof inbox.listRawInboxRecords !== "function"
      || typeof inbox.markProviderRawEventProcessed !== "function"
    ) {
      console.error(SENTINEL);
      assert.equal(typeof inbox.markProviderRawEventProcessed, "function", SENTINEL);
    }
    inbox.setRawInboxLimitsForTest({
      ttlMs: 24 * 60 * 60 * 1000,
      quotaBytes: 800,
      maxEventBytes: 80,
    });
    let now = Date.parse("2026-08-31T00:00:00.000Z");
    inbox.setRawInboxClock(() => now);

    let oversized = false;
    try {
      await inbox.captureProviderRawEvent({
        projectUuid: PROJECT_UUID,
        runUuid: RUN_UUID,
        eventId: "too-big",
        payload: { blob: "x".repeat(200) },
      });
    } catch {
      oversized = true;
    }
    if (!oversized) {
      console.error(SENTINEL);
      assert.equal(oversized, true, SENTINEL);
    }

    await inbox.captureProviderRawEvent({
      projectUuid: PROJECT_UUID,
      runUuid: RUN_UUID,
      eventId: "old-1",
      payload: { n: 1 },
    });
    await inbox.markProviderRawEventProcessed(PROJECT_UUID, RUN_UUID, "old-1");
    now += 25 * 60 * 60 * 1000;
    await inbox.captureProviderRawEvent({
      projectUuid: PROJECT_UUID,
      runUuid: RUN_UUID,
      eventId: "fresh-1",
      payload: { n: 2 },
    });
    const afterTtl = inbox.listRawInboxRecords();
    if (afterTtl.some((row) => row.eventId === "old-1") || !afterTtl.some((row) => row.eventId === "fresh-1")) {
      console.error(SENTINEL);
      assert.equal(afterTtl.some((row) => row.eventId === "old-1"), false, SENTINEL);
    }

    let quotaRejected = false;
    for (let index = 0; index < 12; index += 1) {
      try {
        await inbox.captureProviderRawEvent({
          projectUuid: PROJECT_UUID,
          runUuid: RUN_UUID,
          eventId: `quota-${index}`,
          payload: { n: index },
        });
      } catch {
        quotaRejected = true;
        break;
      }
    }
    const afterQuota = inbox.listRawInboxRecords();
    const totalBytes = afterQuota.reduce((sum, row) => sum + row.envelopeBytes, 0);
    if (totalBytes > 800 || !afterQuota.some((row) => row.eventId === "fresh-1") || !quotaRejected) {
      console.error(SENTINEL);
      assert.equal(totalBytes <= 800, true, SENTINEL);
      assert.equal(afterQuota.some((row) => row.eventId === "fresh-1"), true, SENTINEL);
      assert.equal(quotaRejected, true, SENTINEL);
    }
    if (afterQuota.length === 0) {
      console.error(SENTINEL);
      assert.notEqual(afterQuota.length, 0, SENTINEL);
    }
  });
});
