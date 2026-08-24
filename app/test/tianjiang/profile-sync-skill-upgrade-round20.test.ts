/**
 * Round20 RED：从 Round18/b8f05e9 风格的 185 条未修改内置 skill.* 升级后，
 * 第一次 capture/flush 不得把它们变成用户 tombstone，也不得再上传约 1.5MB。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { ProfileCrypto } from "../../src/tianjiang/crypto/profile-crypto";
import { ProfileStore } from "../../src/tianjiang/data/profile-store";
import {
  ProfileSync,
  type ProfileRemote,
  type ProfileSnapshot,
} from "../../src/tianjiang/sync/profile-sync";
import { resolveBuiltinSkillsResources } from "../../src/tianjiang/skills/account-skills";
import { loadBuiltinSkillsManifest } from "../../src/tianjiang/skills/builtin-skill-installer";
import { runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import {
  activateUserDatabase,
  destroyAllDatabaseHandles,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import {
  closeActivatedWorkspaceRuntime,
  createUniqueWorktreeRoot,
} from "./helpers/worktree-runtime";

const userUUID = "123e4567-e89b-42d3-a456-426614174209";
const identity = { issuer: "https://api.j11.com.cn", userId: 2009 };

class MemoryRemote implements ProfileRemote {
  current: ProfileSnapshot = { version: 1, entries: {} };

  async getMetadata() {
    return { version: this.current.version, etag: `profile-v${this.current.version}` };
  }

  async getCurrent(): Promise<ProfileSnapshot> {
    return structuredClone(this.current);
  }

  async commit(baseVersion: number, entries: ProfileSnapshot["entries"]): Promise<ProfileSnapshot> {
    this.current = { version: baseVersion + 1, entries: structuredClone(entries) };
    return structuredClone(this.current);
  }
}

function stableToken(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function snapshotBytes(entries: ProfileSnapshot["entries"]): number {
  return Buffer.byteLength(JSON.stringify(entries), "utf8");
}

test("升级旧 185 条内置 Skill 快照不得生成 tombstone，也不得再上传 1.5MB", async () => {
  const root = createUniqueWorktreeRoot("r20-skill-upgrade");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";
  const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      const resources = resolveBuiltinSkillsResources();
      const manifest = loadBuiltinSkillsManifest(resources.manifestPath);
      const builtins = manifest.files.filter((item) => item.path.endsWith(".md"));
      assert.ok(builtins.length >= 100, `旧快照夹具必须接近全量内置，实际=${builtins.length}`);

      const remote = new MemoryRemote();
      const store = new ProfileStore(root, userUUID, new ProfileCrypto(userUUID, crypto.randomBytes(32)));
      const sync = new ProfileSync(store, remote, () => 0, { account: identity });
      adapter.bindAccountSyncBindings(sync);

      for (const file of builtins) {
        const full = `${resources.builtinRoot}/${file.path}`;
        const content = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "legacy";
        store.set(`skill.${stableToken(file.path)}`, JSON.stringify({
          path: file.path,
          fileName: file.path.split("/").pop(),
          content,
          kind: "builtin",
          sha256: file.sha256,
        }), false);
      }
      const customKey = `skill.${stableToken("user/custom.md")}`;
      store.set(customKey, JSON.stringify({
        path: "user/custom.md",
        fileName: "custom.md",
        content: "mine",
        kind: "custom",
        sha256: "deadbeef",
      }), false);
      const { ensureCurrentAccountBuiltinSkills, resolveAccountSkillFile } = await import(
        "../../src/tianjiang/skills/account-skills"
      );
      const { skillsRoot } = await ensureCurrentAccountBuiltinSkills((await import("../../src/utils/getPath")).default());
      const customFile = resolveAccountSkillFile(skillsRoot, "user/custom.md", { mustExist: false });
      fs.mkdirSync(path.dirname(customFile), { recursive: true });
      fs.writeFileSync(customFile, "mine", "utf8");
      remote.current = { version: 3, entries: store.exportStoredSnapshot() };
      store.applyStoredSnapshot(store.exportStoredSnapshot(), 3);

      const started = Date.now();
      await adapter.recordLiveSettingsToProfile(sync);
      await sync.flush();
      const elapsed = Date.now() - started;

      const tombstones = store.listPendingMutations().filter((item) => item.key.startsWith("deleted.skill."));
      const remoteSkills = Object.keys(remote.current.entries).filter((key) => key.startsWith("skill."));
      const remoteTombs = Object.keys(remote.current.entries).filter((key) => key.startsWith("deleted.skill."));
      const bytes = snapshotBytes(remote.current.entries);

      assert.equal(
        tombstones.length + remoteTombs.length,
        0,
        `不得把未修改内置项变成 tombstone，pending=${tombstones.length} remote=${remoteTombs.length} elapsed=${elapsed}`,
      );
      assert.ok(
        remoteSkills.length <= 2,
        `远端不得再挂约 ${builtins.length} 条内置 skill.*，实际=${remoteSkills.length} bytes=${bytes}`,
      );
      assert.ok(bytes < 256 * 1024, `升级后不得再上传约 1.5MB，实际=${bytes}`);
      assert.ok(remote.current.entries[customKey] || store.get(customKey), "自定义 Skill 必须保留");
      store.close();
    });
  } finally {
    adapter.bindAccountSyncBindings(null);
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});
