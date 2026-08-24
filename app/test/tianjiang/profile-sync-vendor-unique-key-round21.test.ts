/**
 * Round21 RED：供应商必须只有一个权威键。
 * 生产入口：applyLiveAccountSettings / captureLiveAccountSettings / ProfileSync.flush。
 *
 * 合同：
 * - 能安全表示为旧键的 ID（/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/ 且无点号/冒号）只生成 vendor.{id}。
 * - 点号等不能安全表示的 ID 只生成 vendorItem.<sha256 前 16 位>。
 * - 新快照禁止同一 ID 同时生成两种键。
 * - vendorItem.<token> 必须与 payload.id 的稳定摘要匹配。
 * - 同一逻辑 vendor 的双键以相反对象顺序输入，结果必须一致。
 * - 内容冲突 fail-closed，禁止按 Object.entries 顺序覆盖。
 * - 删除 / 409 / 响应丢失 / 旧快照迁移不得让兼容别名复活 vendor。
 * - 去掉冗余别名是快照迁移，不得写成用户删除 tombstone。
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

const identity = { issuer: "https://api.j11.com.cn", userId: 2110 };
const userUUID = "123e4567-e89b-42d3-a456-426614174210";
const SAFE_VENDOR_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

function sha16(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function expectedVendorKey(id: string): string {
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

function vendorKeys(values: Record<string, string>): string[] {
  return Object.keys(values)
    .filter((key) => key.startsWith("vendor.") || key.startsWith("vendorItem."))
    .sort();
}

function keysForVendor(values: Record<string, string>, id: string): string[] {
  return vendorKeys(values).filter((key) => {
    try {
      const parsed = JSON.parse(values[key] ?? "") as { id?: unknown };
      return parsed.id === id;
    } catch {
      return values[key]?.includes(`"id":"${id}"`) === true;
    }
  });
}

async function apiKeyOf(id: string): Promise<string | undefined> {
  const row = await accountDatabase()("o_vendorConfig").where({ id }).first();
  if (!row) return undefined;
  const parsed = JSON.parse(String(row.inputValues ?? "{}")) as { apiKey?: string };
  return parsed.apiKey;
}

class MemoryRemote implements ProfileRemote {
  current: ProfileSnapshot = { version: 1, entries: {} };
  commits: Array<{ baseVersion: number; entries: ProfileSnapshot["entries"] }> = [];
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
    this.commits.push({ baseVersion, entries: structuredClone(entries) });
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

test("同一逻辑 vendor 的 vendorItem 与 vendor 键以相反对象顺序输入，结果必须一致；冲突不得按遍历顺序覆盖", async () => {
  const root = createUniqueWorktreeRoot("r21-vendor-order");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";
  const id = "orderVendor";
  const token = sha16(id);
  const itemKey = `vendorItem.${token}`;
  const legacyKey = `vendor.${id}`;
  const first = vendorPayload(id, "sk-first");
  const second = vendorPayload(id, "sk-second");
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");

      const sameA: Record<string, string> = {};
      sameA[itemKey] = vendorPayload(id, "sk-same");
      sameA[legacyKey] = vendorPayload(id, "sk-same");
      const sameB: Record<string, string> = {};
      sameB[legacyKey] = vendorPayload(id, "sk-same");
      sameB[itemKey] = vendorPayload(id, "sk-same");
      assert.deepEqual(Object.keys(sameA), [itemKey, legacyKey]);
      assert.deepEqual(Object.keys(sameB), [legacyKey, itemKey]);
      await adapter.applyLiveAccountSettings(sameA);
      const afterSameA = await apiKeyOf(id);
      await accountDatabase()("o_vendorConfig").where({ id }).del();
      await adapter.applyLiveAccountSettings(sameB);
      const afterSameB = await apiKeyOf(id);
      assert.equal(afterSameA, "sk-same");
      assert.equal(afterSameB, afterSameA, "相同内容的双键相反顺序必须得到同一结果");

      const conflictA: Record<string, string> = {};
      conflictA[itemKey] = first;
      conflictA[legacyKey] = second;
      const conflictB: Record<string, string> = {};
      conflictB[legacyKey] = second;
      conflictB[itemKey] = first;
      assert.notDeepEqual(Object.keys(conflictA), Object.keys(conflictB), "必须用相反 Object.entries 顺序");

      const runConflict = async (values: Record<string, string>): Promise<string | "threw"> => {
        await accountDatabase()("o_vendorConfig").where({ id }).del();
        try {
          await adapter.applyLiveAccountSettings(values);
          return (await apiKeyOf(id)) ?? "<missing>";
        } catch {
          return "threw";
        }
      };
      const resultA = await runConflict(conflictA);
      const resultB = await runConflict(conflictB);
      assert.equal(
        resultA,
        "threw",
        `冲突必须 fail-closed，不得按 Object.entries 顺序写成 ${resultA}`,
      );
      assert.equal(resultB, resultA, `相反顺序的冲突结果必须一致，A=${resultA} B=${resultB}`);
    });
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});

test("vendorItem token 必须匹配 payload.id 摘要；伪造、空 id、超长、非法 id 必须失败关闭", async () => {
  const root = createUniqueWorktreeRoot("r21-vendor-token");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
      const validId = "tokenVendor";
      const forged = {
        [`vendorItem.${"0".repeat(16)}`]: vendorPayload(validId, "sk-forged"),
      };
      await assert.rejects(
        () => adapter.applyLiveAccountSettings(forged),
        /供应商|vendor|token|摘要|不匹配/i,
        "伪造 token 必须失败关闭",
      );
      assert.equal(await apiKeyOf(validId), undefined, "伪造 token 不得写入供应商");

      await assert.rejects(
        () => adapter.applyLiveAccountSettings({
          [`vendorItem.${sha16("empty-id")}`]: JSON.stringify({
            id: "",
            inputValues: { apiKey: "sk-empty" },
            models: [],
            enable: 1,
          }),
        }),
        /供应商|vendor|id/i,
        "空 id 必须失败关闭",
      );

      const tooLong = `v${"x".repeat(200)}`;
      await assert.rejects(
        () => adapter.applyLiveAccountSettings({
          [`vendorItem.${sha16(tooLong)}`]: vendorPayload(tooLong, "sk-long"),
        }),
        /供应商|vendor|id|过长|超长/i,
        "超长 id 必须失败关闭",
      );
      assert.equal(await apiKeyOf(tooLong), undefined, "超长 id 不得入库");

      await assert.rejects(
        () => adapter.applyLiveAccountSettings({
          [`vendorItem.${sha16("../escape")}`]: vendorPayload("../escape", "sk-path"),
        }),
        /供应商|vendor|id|非法/i,
        "非法路径 id 必须失败关闭",
      );
      await assert.rejects(
        () => adapter.applyLiveAccountSettings({
          [`vendorItem.${sha16("evil:colon")}`]: vendorPayload("evil:colon", "sk-colon"),
        }),
        /供应商|vendor|id|非法/i,
        "含冒号 id 必须失败关闭",
      );
    });
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});

test("删除后旧快照别名不得复活 vendor；409 与响应丢失同样不得靠兼容键写回", async () => {
  const root = createUniqueWorktreeRoot("r21-vendor-resurrect");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";
  const id = "ghostVendor";
  const token = sha16(id);
  const itemKey = `vendorItem.${token}`;
  const legacyKey = `vendor.${id}`;
  const live = vendorPayload(id, "sk-ghost");
  const tombstone = JSON.stringify({ $tombstone: true, id });
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
      await adapter.applyLiveAccountSettings({ [legacyKey]: live });
      assert.ok(await accountDatabase()("o_vendorConfig").where({ id }).first(), "删除前必须已有供应商");

      await adapter.applyLiveAccountSettings({ [`deleted.${legacyKey}`]: tombstone });
      assert.equal(
        await accountDatabase()("o_vendorConfig").where({ id }).first(),
        undefined,
        "tombstone 后供应商必须消失",
      );

      await adapter.applyLiveAccountSettings({ [itemKey]: live });
      assert.equal(
        await accountDatabase()("o_vendorConfig").where({ id }).first(),
        undefined,
        "已删除供应商不得被 vendorItem 兼容别名复活",
      );

      const dotted = "partner.v2";
      const dottedItem = `vendorItem.${sha16(dotted)}`;
      const dottedAlias = "vendor.partner.v2";
      await adapter.applyLiveAccountSettings({ [dottedItem]: vendorPayload(dotted, "sk-dot") });
      await adapter.applyLiveAccountSettings({
        [`deleted.${dottedItem}`]: JSON.stringify({ $tombstone: true, id: dotted }),
      });
      await adapter.applyLiveAccountSettings({ [dottedAlias]: vendorPayload(dotted, "sk-dot") });
      assert.equal(
        await accountDatabase()("o_vendorConfig").where({ id: dotted }).first(),
        undefined,
        "已删除的点号供应商不得被 vendor.partner.v2 兼容别名复活",
      );

      const remote = new MemoryRemote();
      const store = new ProfileStore(root, userUUID, new ProfileCrypto(userUUID, crypto.randomBytes(32)));
      const sync = new ProfileSync(store, remote, () => 0, { account: identity });
      adapter.bindAccountProfileSync(sync);
      try {
        await adapter.applyLiveAccountSettings({ [legacyKey]: live, [itemKey]: live });
        store.set(itemKey, live, true);
        const aliasBeforeDelete = store.exportStoredSnapshot()[itemKey];
        await adapter.notifyAccountSettingsMutated();
        await accountDatabase()("o_vendorConfig").where({ id }).del();
        await adapter.notifyAccountSettingsMutated();
        assert.ok(aliasBeforeDelete, "删除前必须已捕获 vendorItem 别名快照");
        remote.conflictInject = { [itemKey]: aliasBeforeDelete };
        await sync.flush();
        assert.equal(
          await accountDatabase()("o_vendorConfig").where({ id }).first(),
          undefined,
          "409 重试注入兼容别名后供应商必须仍删除",
        );

        sync.setPersistent(itemKey, live, true);
        remote.dropNextResponse = true;
        await assert.rejects(() => sync.flush(), /连接已断开/);
        await sync.flush();
        assert.equal(
          await accountDatabase()("o_vendorConfig").where({ id }).first(),
          undefined,
          "响应丢失重放兼容别名不得复活已删除供应商",
        );
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

test("partner.v2、my-vendor、my_vendor、内置供应商必须往返且新快照只有一个权威键；非集合键不得入库", async () => {
  const root = createUniqueWorktreeRoot("r21-vendor-roundtrip");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
      await adapter.applyLiveAccountSettings({
        [expectedVendorKey("partner.v2")]: vendorPayload("partner.v2", "sk-dot"),
        [expectedVendorKey("my-vendor")]: vendorPayload("my-vendor", "sk-hyphen"),
        [expectedVendorKey("my_vendor")]: vendorPayload("my_vendor", "sk-under"),
        "vendor.synthetic.api_key": "http-test-secret-value",
      });

      for (const id of ["partner.v2", "my-vendor", "my_vendor", "tianjiang"] as const) {
        const row = await accountDatabase()("o_vendorConfig").where({ id }).first();
        assert.ok(row, `${id} 必须写入或保留在 o_vendorConfig`);
      }
      assert.equal(
        await accountDatabase()("o_vendorConfig").where({ id: "synthetic.api_key" }).first(),
        undefined,
        "vendor.synthetic.api_key 不得插入供应商表",
      );

      const captured = await adapter.captureLiveAccountSettings();
      for (const id of ["partner.v2", "my-vendor", "my_vendor", "tianjiang"] as const) {
        const keys = keysForVendor(captured, id);
        assert.deepEqual(
          keys,
          [expectedVendorKey(id)],
          `${id} 必须只有权威键 ${expectedVendorKey(id)}，实际=${keys.join(",")}`,
        );
        assert.match(captured[expectedVendorKey(id)] ?? "", new RegExp(`"id":"${id.replace(".", "\\.")}"`));
      }
      assert.equal(captured["vendor.synthetic.api_key"], undefined, "非集合键不得进入 capture 供应商集合");

      const remote = new MemoryRemote();
      const store = new ProfileStore(root, userUUID, new ProfileCrypto(userUUID, crypto.randomBytes(32)));
      const sync = new ProfileSync(store, remote, () => 0, { account: identity });
      adapter.bindAccountProfileSync(sync);
      try {
        const dualPayload = vendorPayload("dualHist", "sk-hist");
        await adapter.applyLiveAccountSettings({
          "vendor.dualHist": dualPayload,
          [`vendorItem.${sha16("dualHist")}`]: dualPayload,
        });
        store.set("vendor.dualHist", dualPayload, true);
        store.set(`vendorItem.${sha16("dualHist")}`, dualPayload, true);
        await adapter.notifyAccountSettingsMutated();
        const liveKeys = store.listKeys().filter((key) => {
          if (key.startsWith("deleted.")) return false;
          if (!key.startsWith("vendor.") && !key.startsWith("vendorItem.")) return false;
          const raw = store.get(key);
          if (!raw) return false;
          try {
            return (JSON.parse(raw) as { id?: string }).id === "dualHist";
          } catch {
            return false;
          }
        });
        assert.deepEqual(
          liveKeys.sort(),
          [expectedVendorKey("dualHist")],
          `历史双键迁移后只保留权威键，实际=${liveKeys.join(",")}`,
        );
        const tombstones = store.listKeys().filter((key) => key.startsWith("deleted.vendor") && store.get(key)?.includes("dualHist"));
        assert.deepEqual(
          tombstones,
          [],
          `去掉冗余别名不得生成用户删除 tombstone，实际=${tombstones.join(",")}`,
        );
        assert.ok(
          await accountDatabase()("o_vendorConfig").where({ id: "dualHist" }).first(),
          "历史双键迁移不得删掉仍存在的供应商",
        );

        await accountDatabase()("o_vendorConfig").where({ id: "partner.v2" }).del();
        await adapter.notifyAccountSettingsMutated();
        const dottedAuth = expectedVendorKey("partner.v2");
        assert.equal(store.get(dottedAuth), undefined, "删除点号供应商后权威键必须离开 live 快照");
        assert.ok(
          store.get(`deleted.${dottedAuth}`)?.includes("partner.v2"),
          "删除点号供应商必须留下 vendorItem tombstone，不得只删 vendor.* 前缀",
        );
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
