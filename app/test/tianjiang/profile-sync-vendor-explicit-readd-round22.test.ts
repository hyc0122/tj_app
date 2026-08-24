/**
 * Round22 RED：明确重新添加必须清掉同逻辑 ID 的历史 tombstone；
 * 后台 capture 发现陈旧本地副本不得复活远端删除。
 * 生产入口：真实写入 o_vendorConfig 后 addVendor 收尾（afterAccountSettingsWrite /
 * afterVendorConfigWrite）→ ProfileSync.flush。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { ProfileCrypto } from "../../src/tianjiang/crypto/profile-crypto";
import { ProfileStore } from "../../src/tianjiang/data/profile-store";
import { runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import {
  ProfileConflictError,
  ProfileSync,
  type ProfileRemote,
  type ProfileSnapshot,
} from "../../src/tianjiang/sync/profile-sync";
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

const identity = { issuer: "https://api.j11.com.cn", userId: 2202 };
const userUUID = "123e4567-e89b-42d3-a456-426614174222";
const SAFE_VENDOR_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

function sha16(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function authKey(id: string): string {
  return SAFE_VENDOR_ID_RE.test(id) ? `vendor.${id}` : `vendorItem.${sha16(id)}`;
}

function vendorPayload(id: string, apiKey: string): string {
  return JSON.stringify({
    id,
    inputValues: { apiKey },
    models: [],
    enable: 1,
  });
}

class MemoryRemote implements ProfileRemote {
  current: ProfileSnapshot = { version: 1, entries: {} };
  conflictInject: ProfileSnapshot["entries"] | null = null;
  dropNextResponse = false;
  commitCalls = 0;

  async getMetadata() {
    return { version: this.current.version, etag: `profile-v${this.current.version}` };
  }

  async getCurrent(): Promise<ProfileSnapshot> {
    return structuredClone(this.current);
  }

  async commit(baseVersion: number, entries: ProfileSnapshot["entries"]): Promise<ProfileSnapshot> {
    this.commitCalls += 1;
    if (this.conflictInject) {
      const extra = this.conflictInject;
      this.conflictInject = null;
      this.current = {
        version: this.current.version + 1,
        entries: { ...this.current.entries, ...extra },
      };
      throw new ProfileConflictError();
    }
    if (baseVersion !== this.current.version) throw new ProfileConflictError();
    this.current = { version: baseVersion + 1, entries: structuredClone(entries) };
    if (this.dropNextResponse) {
      this.dropNextResponse = false;
      throw new Error("连接已断开");
    }
    return structuredClone(this.current);
  }
}

function tombstonesFor(decoded: Record<string, string>, id: string): string[] {
  return Object.keys(decoded)
    .filter((key) => key.startsWith("deleted.vendor"))
    .filter((key) => {
      try {
        const parsed = JSON.parse(decoded[key] ?? "") as { id?: unknown };
        return parsed.id === id || key.endsWith(`.${id}`) || key.endsWith(`.${sha16(id)}`);
      } catch {
        return key.includes(id) || key.includes(sha16(id));
      }
    })
    .sort();
}

async function insertVendor(id: string, apiKey: string): Promise<void> {
  await accountDatabase()("o_vendorConfig").insert({
    id,
    inputValues: JSON.stringify({ apiKey }),
    models: "[]",
    enable: 1,
  });
}

async function finishExplicitUpsert(
  adapter: typeof import("../../src/tianjiang/sync/profile-settings-adapter"),
  id: string,
): Promise<void> {
  await adapter.commitVendorConfigMutation(accountDatabase(), { op: "upsert", id }, async (trx) => {
    const exists = await trx("o_vendorConfig").where({ id }).first();
    if (!exists) throw new Error("供应商不存在");
    await trx("o_vendorConfig").where({ id }).update({ enable: exists.enable });
  });
  await adapter.afterVendorConfigWrite({ op: "upsert", id });
}

test("A: 历史 deleted.vendorItem 存在时，明确重新添加 vendor.{safeId} 必须清 tombstone 并保留 DB 行", async () => {
  const root = createUniqueWorktreeRoot("r22-readd-a");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";
  const id = "readdSafe";
  const itemTomb = `deleted.vendorItem.${sha16(id)}`;
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
      const remote = new MemoryRemote();
      const store = new ProfileStore(root, userUUID, new ProfileCrypto(userUUID, crypto.randomBytes(32)));
      const sync = new ProfileSync(store, remote, () => 0, { account: identity });
      adapter.bindAccountProfileSync(sync);
      try {
        store.set(itemTomb, JSON.stringify({ $tombstone: true, id }), false);
        remote.current = { version: 3, entries: store.exportStoredSnapshot() };
        await insertVendor(id, "sk-readd-safe");
        await finishExplicitUpsert(adapter, id);
        await sync.flush();
        assert.ok(
          await accountDatabase()("o_vendorConfig").where({ id }).first(),
          "明确重新添加后 DB 必须保留供应商",
        );
        const decoded = store.decodeStoredEntries(remote.current.entries);
        assert.deepEqual(tombstonesFor(decoded, id), [], `必须清掉同逻辑 ID tombstone，实际=${tombstonesFor(decoded, id).join(",")}`);
        assert.ok(decoded[authKey(id)], `远端必须有权威键 ${authKey(id)}`);
        assert.equal(decoded[`vendorItem.${sha16(id)}`], undefined, "不得再上传 vendorItem 别名");
      } finally {
        adapter.bindAccountProfileSync(null);
        store.close();
      }
    });
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});

test("B: 历史 deleted.vendor.partner.v2 存在时，明确重新添加权威 vendorItem 必须清 tombstone", async () => {
  const root = createUniqueWorktreeRoot("r22-readd-b");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";
  const id = "partner.v2";
  const aliasTomb = "deleted.vendor.partner.v2";
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
      const remote = new MemoryRemote();
      const store = new ProfileStore(root, userUUID, new ProfileCrypto(userUUID, crypto.randomBytes(32)));
      const sync = new ProfileSync(store, remote, () => 0, { account: identity });
      adapter.bindAccountProfileSync(sync);
      try {
        store.set(aliasTomb, JSON.stringify({ $tombstone: true, id }), false);
        remote.current = { version: 4, entries: store.exportStoredSnapshot() };
        await insertVendor(id, "sk-readd-dot");
        await finishExplicitUpsert(adapter, id);
        await sync.flush();
        assert.ok(
          await accountDatabase()("o_vendorConfig").where({ id }).first(),
          "点号供应商明确重建后必须仍在 DB",
        );
        const decoded = store.decodeStoredEntries(remote.current.entries);
        assert.deepEqual(tombstonesFor(decoded, id), [], `必须清掉 deleted.vendor.partner.v2，实际=${tombstonesFor(decoded, id).join(",")}`);
        assert.ok(decoded[authKey(id)], `远端必须有 ${authKey(id)}`);
      } finally {
        adapter.bindAccountProfileSync(null);
        store.close();
      }
    });
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});

test("C: 后台 capture 发现陈旧本地 vendor 时，不得清 tombstone 也不得上传 live 键", async () => {
  const root = createUniqueWorktreeRoot("r22-readd-c");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";
  const id = "staleLocal";
  const itemTomb = `deleted.vendorItem.${sha16(id)}`;
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
      const remote = new MemoryRemote();
      const store = new ProfileStore(root, userUUID, new ProfileCrypto(userUUID, crypto.randomBytes(32)));
      const sync = new ProfileSync(store, remote, () => 0, { account: identity });
      adapter.bindAccountProfileSync(sync);
      try {
        store.set(itemTomb, JSON.stringify({ $tombstone: true, id }), false);
        remote.current = { version: 5, entries: store.exportStoredSnapshot() };
        await insertVendor(id, "sk-stale-local");
        await adapter.afterAccountSettingsWrite();
        await sync.flush();
        const decoded = store.decodeStoredEntries(remote.current.entries);
        assert.ok(decoded[itemTomb], "后台校准不得清掉历史 tombstone");
        assert.equal(decoded[authKey(id)], undefined, "没有明确 upsert 不得上传权威 live 键");
        assert.equal(decoded[`vendorItem.${sha16(id)}`], undefined, "不得上传别名复活");
      } finally {
        adapter.bindAccountProfileSync(null);
        store.close();
      }
    });
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});

test("D: 明确删除与明确重建的 409/响应丢失必须幂等，不依赖条目顺序", async () => {
  const root = createUniqueWorktreeRoot("r22-readd-d");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";
  const id = "retryVendor";
  const itemTomb = `deleted.vendorItem.${sha16(id)}`;
  const auth = authKey(id);
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
      const remote = new MemoryRemote();
      const store = new ProfileStore(root, userUUID, new ProfileCrypto(userUUID, crypto.randomBytes(32)));
      const sync = new ProfileSync(store, remote, () => 0, { account: identity });
      adapter.bindAccountProfileSync(sync);
      try {
        await insertVendor(id, "sk-retry");
        await finishExplicitUpsert(adapter, id);
        await sync.flush();
        const liveEntry = store.exportStoredSnapshot()[auth];
        await adapter.commitVendorConfigMutation(accountDatabase(), { op: "delete", id }, async (trx) => {
          await trx("o_vendorConfig").where({ id }).del();
        });
        await adapter.afterVendorConfigWrite({ op: "delete", id });
        remote.conflictInject = liveEntry ? { [auth]: liveEntry } : null;
        await sync.flush();
        assert.equal(
          await accountDatabase()("o_vendorConfig").where({ id }).first(),
          undefined,
          "明确删除后 409 注入 live 别名不得复活",
        );

        store.set(itemTomb, JSON.stringify({ $tombstone: true, id }), false);
        const tombEntry = store.exportStoredSnapshot()[itemTomb];
        remote.current.entries = { ...remote.current.entries, [itemTomb]: tombEntry! };
        await insertVendor(id, "sk-retry-2");
        await finishExplicitUpsert(adapter, id);
        remote.conflictInject = { [itemTomb]: tombEntry! };
        remote.dropNextResponse = false;
        await sync.flush();
        assert.ok(
          await accountDatabase()("o_vendorConfig").where({ id }).first(),
          "明确重建后 409 注入旧 tombstone 不得再删掉供应商",
        );
        const decoded = store.decodeStoredEntries(remote.current.entries);
        assert.deepEqual(tombstonesFor(decoded, id), [], "重建重试后 tombstone 必须消失");
        assert.ok(decoded[auth], "重建重试后权威键必须存在");
      } finally {
        adapter.bindAccountProfileSync(null);
        store.close();
      }
    });
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});
