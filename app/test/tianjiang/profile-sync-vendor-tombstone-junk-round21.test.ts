/**
 * Round21 自审 P1 RED：非法 vendorItem tombstone 不得把整次 apply 打崩。
 * 生产入口：applyLiveAccountSettings。
 * 历史快照或 forgetMissing 可能留下 deleted.vendorItem.<forged>；
 * 这不是一次有效的供应商写入，必须跳过并继续应用其余键。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import {
  accountDatabase,
  activateUserDatabase,
  destroyAllDatabaseHandles,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import {
  closeActivatedWorkspaceRuntime,
  createUniqueWorktreeRoot,
} from "./helpers/worktree-runtime";

const identity = { issuer: "https://api.j11.com.cn", userId: 2111 };

test("非法 vendorItem tombstone 必须跳过，同批 language 仍须写入", async () => {
  const root = createUniqueWorktreeRoot("r21-vendor-junk-tomb");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
      await adapter.applyLiveAccountSettings({
        "deleted.vendorItem.0000000000000000": JSON.stringify({ $tombstone: true }),
        language: "en",
      });
      const language = await accountDatabase()("o_setting").where({ key: "language" }).first();
      assert.equal(language?.value, "en", `同批 language 必须写入，实际=${language?.value}`);
      const forged = await accountDatabase()("o_vendorConfig").where({ id: "0000000000000000" }).first();
      assert.equal(forged, undefined, "伪造 token tombstone 不得插入供应商");
    });
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});
