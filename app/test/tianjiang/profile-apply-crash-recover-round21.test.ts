/**
 * Round21 RED：apply journal 必须覆盖已提升、部分提升、DB 已提交但 journal 未改名、
 * staging/target 双缺、以及 rename 失败不得 copy 覆盖。
 * 生产入口：applyLiveAccountSettings → recoverProfileApplyJournal。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { resolveAccountModelPromptFile } from "../../src/tianjiang/prompts/account-model-prompt";
import { runWithUserStorage, userStorageRoot } from "../../src/tianjiang/runtime/user-storage-context";
import {
  accountDatabase,
  activateUserDatabase,
  destroyAllDatabaseHandles,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import getPath from "../../src/utils/getPath";
import {
  closeActivatedWorkspaceRuntime,
  createUniqueWorktreeRoot,
} from "./helpers/worktree-runtime";

const identity = { issuer: "https://api.j11.com.cn", userId: 2101 };

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function journalPath(): string {
  return path.join(userStorageRoot(getPath(), identity), "profile-apply-journal.json");
}

function writeJournal(journal: unknown): void {
  const file = journalPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(journal), "utf8");
}

async function recoverViaApply(): Promise<void> {
  const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
  await adapter.applyLiveAccountSettings({});
}

test("journal=db-committed 且 staging 已不存在、target 已是预期内容时，恢复不得 ENOENT", async () => {
  const root = createUniqueWorktreeRoot("r21-apply-a");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      const target = resolveAccountModelPromptFile({ relativePath: "video/r21-a.md" });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "already-promoted", "utf8");
      const staging = `${target}.gone.staging`;
      writeJournal({
        phase: "db-committed",
        writes: [{ target, staging, sha256: sha256("already-promoted"), size: Buffer.byteLength("already-promoted") }],
        deletes: [],
      });
      await recoverViaApply();
      assert.equal(fs.readFileSync(target, "utf8"), "already-promoted");
      assert.equal(fs.existsSync(journalPath()), false, "已完成项恢复后必须清 journal");
    });
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});

test("多文件第一项已提升、后续 staging 仍在时，恢复必须幂等完成全部项", async () => {
  const root = createUniqueWorktreeRoot("r21-apply-b");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      const first = resolveAccountModelPromptFile({ relativePath: "video/r21-b1.md" });
      const second = resolveAccountModelPromptFile({ relativePath: "video/r21-b2.md" });
      fs.mkdirSync(path.dirname(first), { recursive: true });
      fs.writeFileSync(first, "first-done", "utf8");
      const firstStaging = `${first}.1.staging`;
      const secondStaging = `${second}.2.staging`;
      fs.writeFileSync(secondStaging, "second-pending", "utf8");
      writeJournal({
        phase: "db-committed",
        writes: [
          { target: first, staging: firstStaging, sha256: sha256("first-done"), size: Buffer.byteLength("first-done") },
          { target: second, staging: secondStaging, sha256: sha256("second-pending"), size: Buffer.byteLength("second-pending") },
        ],
        deletes: [],
      });
      await recoverViaApply();
      assert.equal(fs.readFileSync(first, "utf8"), "first-done", "已提升项不得被破坏");
      assert.equal(fs.readFileSync(second, "utf8"), "second-pending", "剩余 staging 必须提升");
      assert.equal(fs.existsSync(secondStaging), false);
      assert.equal(fs.existsSync(journalPath()), false);
    });
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});

test("DB 已提交但 journal 仍是 staging 时，恢复不得丢弃 staging", async () => {
  const root = createUniqueWorktreeRoot("r21-apply-c");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      const target = resolveAccountModelPromptFile({ relativePath: "video/r21-c.md" });
      const staging = `${target}.c.staging`;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(staging, "db-committed-content", "utf8");
      await accountDatabase()("o_modelPrompt").insert({
        vendorId: "tianjiang",
        model: "r21-c",
        path: "video/r21-c.md",
        fileName: "r21-c.md",
      });
      const writes = [{
        target,
        staging,
        sha256: sha256("db-committed-content"),
        size: Buffer.byteLength("db-committed-content"),
      }];
      writeJournal({
        operationId: "crash-c",
        phase: "staging",
        writes,
        deletes: [],
      });
      await accountDatabase().raw(`
        CREATE TABLE IF NOT EXISTS o_profileApplyMarker (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          operationId TEXT NOT NULL,
          phase TEXT NOT NULL,
          journalJson TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        )
      `);
      await accountDatabase()("o_profileApplyMarker").where({ id: 1 }).del();
      await accountDatabase()("o_profileApplyMarker").insert({
        id: 1,
        operationId: "crash-c",
        phase: "db-committed",
        journalJson: JSON.stringify({
          operationId: "crash-c",
          phase: "db-committed",
          writes,
          deletes: [],
        }),
        updatedAt: new Date().toISOString(),
      });
      // 中文注释：模拟业务事务已提交、JSON journal 尚未改成 db-committed。
      await recoverViaApply();
      assert.equal(
        fs.existsSync(target) && fs.readFileSync(target, "utf8") === "db-committed-content",
        true,
        "DB 已提交时不得把 staging 当未提交丢弃",
      );
    });
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});

test("staging 与 target 都不满足预期时必须 fail-closed 并保留 journal", async () => {
  const root = createUniqueWorktreeRoot("r21-apply-d");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      const target = resolveAccountModelPromptFile({ relativePath: "video/r21-d.md" });
      const staging = `${target}.missing.staging`;
      writeJournal({
        phase: "db-committed",
        writes: [{ target, staging, sha256: sha256("expected"), size: Buffer.byteLength("expected") }],
        deletes: [],
      });
      let thrown: unknown;
      try {
        await recoverViaApply();
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown, "双缺必须失败关闭");
      assert.equal(fs.existsSync(journalPath()), true, "失败后不得清 journal");
    });
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});

test("rename 失败时禁止 copyFile 覆盖正式文件，必须保留 staging 并失败", async () => {
  const root = createUniqueWorktreeRoot("r21-apply-e");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";
  const originalRename = fs.renameSync;
  let copyCalled = false;
  const originalCopy = fs.copyFileSync;
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      const target = resolveAccountModelPromptFile({ relativePath: "video/r21-e.md" });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "old-official", "utf8");
      (fs as typeof fs).renameSync = ((src: fs.PathLike, dest: fs.PathLike) => {
        if (String(src).includes(".staging") && String(dest) === target) {
          const err = new Error("EPERM: locked") as NodeJS.ErrnoException;
          err.code = "EPERM";
          throw err;
        }
        return originalRename(src, dest);
      }) as typeof fs.renameSync;
      (fs as typeof fs).copyFileSync = ((src: fs.PathLike, dest: fs.PathLike, flags?: number) => {
        if (String(dest) === target) copyCalled = true;
        return originalCopy(src, dest, flags);
      }) as typeof fs.copyFileSync;

      let thrown: unknown;
      try {
        const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
        await adapter.applyLiveAccountSettings({
          "model.tianjiang.r21e": JSON.stringify({
            vendorId: "tianjiang",
            model: "r21e",
            path: "video/r21-e.md",
            fileName: "r21-e.md",
            content: "new-content",
          }),
        });
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown, "rename 失败必须使 apply 失败");
      assert.equal(copyCalled, false, "禁止 catch 后 copyFileSync 覆盖正式文件");
      assert.equal(fs.readFileSync(target, "utf8"), "old-official", "正式文件不得被部分覆盖");
      const leftovers = fs.readdirSync(path.dirname(target)).filter((name) => name.includes("staging"));
      assert.ok(leftovers.length > 0 || fs.existsSync(journalPath()), "必须保留 staging 或 journal");
    });
  } finally {
    (fs as typeof fs).renameSync = originalRename;
    (fs as typeof fs).copyFileSync = originalCopy;
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});
