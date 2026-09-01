import assert from "node:assert/strict";
import test from "node:test";

import { runWithProjectStorage } from "../../src/tianjiang/runtime/user-storage-context";
import { db as activeDb, initializeCanvasWorkspace } from "../../src/utils/db";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";

const SENTINEL = "RED_EXPECTED:CANVAS_PROJECT_MIGRATION";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000901";

const PROJECT_TABLES = [
  "canvas_documents",
  "canvas_revisions",
  "canvas_revision_pin_mutations",
  "canvas_document_mutations",
  "canvas_assets",
  "canvas_asset_references",
  "canvas_asset_gc",
  "canvas_asset_mutations",
  "canvas_import_jobs",
  "canvas_import_items",
  "canvas_import_action_receipts",
  "canvas_conversations",
  "canvas_messages",
  "canvas_chat_requests",
  "canvas_applied_plans",
  "canvas_execution_confirmations",
  "canvas_execution_batches",
  "canvas_node_runs",
  "canvas_execution_events",
  "canvas_execution_intents",
  "canvas_execution_cancel_receipts",
];

const ACCOUNT_FORBIDDEN = [
  "canvas_execution_outbox",
  "canvas_provider_raw_inbox",
  "canvas_import_staging_reservations",
];

test("项目库安装画布表且账号库不得装入可同步 outbox", async () => {
  await runWithTemporaryAccount("canvas-project-migration", async () => {
    await initializeCanvasWorkspace(PROJECT_UUID);
    try {
    const names = await runWithProjectStorage(PROJECT_UUID, async () => {
      const rows = await activeDb.raw(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      ) as Array<{ name: string }>;
      return rows.map((row) => row.name);
    });
    for (const table of PROJECT_TABLES) {
      assert.ok(names.includes(table), `${SENTINEL} 缺少项目表 ${table}`);
    }
    for (const table of ACCOUNT_FORBIDDEN) {
      assert.ok(!names.includes(table), `${SENTINEL} 项目库不得安装 ${table}`);
    }
    const doc = await runWithProjectStorage(PROJECT_UUID, () =>
      activeDb("canvas_documents").where({ id: 1 }).first(),
    );
    assert.equal(doc?.home_initialization_state, "pending", SENTINEL);
    assert.equal(doc?.revision, 0, SENTINEL);
    } catch (error) {
      if ((error as { code?: string })?.code === "ERR_ASSERTION") {
        console.error(SENTINEL);
      } else {
        console.error(SENTINEL);
      }
      throw error;
    }
  });
});
