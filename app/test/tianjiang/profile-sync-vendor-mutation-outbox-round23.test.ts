/**
 * Round23 RED：vendor 明确 mutation 必须有账号归属并持久化。
 * 生产入口：afterVendorConfigWrite / 七条 vendorConfig 路由 / ProfileSync.flush。
 * 禁止用进程全局数组表达业务事实。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import test from "node:test";
import express from "express";

import { ProfileCrypto } from "../../src/tianjiang/crypto/profile-crypto";
import { ProfileStore } from "../../src/tianjiang/data/profile-store";
import { enterUserStorage, runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import {
  ProfileSync,
  type ProfileRemote,
  type ProfileSnapshot,
} from "../../src/tianjiang/sync/profile-sync";
import {
  accountDatabase,
  activateUserDatabase,
  destroyAllDatabaseHandles,
  prepareUserDatabase,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import {
  closeActivatedWorkspaceRuntime,
  createUniqueWorktreeRoot,
} from "./helpers/worktree-runtime";

const identityA = { issuer: "https://api.j11.com.cn", userId: 2301 };
const identityB = { issuer: "https://api.j11.com.cn", userId: 2302 };
const uuidA = "123e4567-e89b-42d3-a456-426614174231";
const uuidB = "123e4567-e89b-42d3-a456-426614174232";
const OUTBOX = "o_profileVendorOutbox";

function sha16(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function vendorPayload(id: string, apiKey: string): string {
  return JSON.stringify({ id, inputValues: { apiKey }, models: [], enable: 1 });
}

class MemoryRemote implements ProfileRemote {
  current: ProfileSnapshot = { version: 1, entries: {} };
  commitCalls = 0;
  async getMetadata() {
    return { version: this.current.version, etag: `profile-v${this.current.version}` };
  }
  async getCurrent(): Promise<ProfileSnapshot> {
    return structuredClone(this.current);
  }
  async commit(baseVersion: number, entries: ProfileSnapshot["entries"]): Promise<ProfileSnapshot> {
    this.commitCalls += 1;
    if (baseVersion !== this.current.version) throw new Error("个人配置基础版本已过期");
    this.current = { version: baseVersion + 1, entries: structuredClone(entries) };
    return structuredClone(this.current);
  }
}

function tombstonesFor(decoded: Record<string, string>, id: string): string[] {
  return Object.keys(decoded)
    .filter((key) => key.startsWith("deleted.vendor"))
    .filter((key) => {
      try {
        return (JSON.parse(decoded[key] ?? "") as { id?: string }).id === id
          || key.endsWith(`.${id}`)
          || key.endsWith(`.${sha16(id)}`);
      } catch {
        return key.includes(id);
      }
    })
    .sort();
}

async function insertVendor(id: string, apiKey: string): Promise<void> {
  await accountDatabase()("o_vendorConfig").insert({
    id,
    inputValues: JSON.stringify({ apiKey }),
    models: JSON.stringify({ custom: [], excluded: [] }),
    enable: 1,
  });
}

async function commitExplicitVendor(
  adapter: typeof import("../../src/tianjiang/sync/profile-settings-adapter"),
  mutation: { op: "upsert" | "delete"; id: string },
  apiKey = "sk-explicit",
): Promise<void> {
  await adapter.commitVendorConfigMutation(accountDatabase(), mutation, async (trx) => {
    if (mutation.op === "delete") {
      await trx("o_vendorConfig").where({ id: mutation.id }).del();
      return;
    }
    const exists = await trx("o_vendorConfig").where({ id: mutation.id }).first();
    if (exists) {
      await trx("o_vendorConfig").where({ id: mutation.id }).update({
        inputValues: JSON.stringify({ apiKey }),
        enable: 1,
      });
      return;
    }
    await trx("o_vendorConfig").insert({
      id: mutation.id,
      inputValues: JSON.stringify({ apiKey }),
      models: JSON.stringify({ custom: [], excluded: [] }),
      enable: 1,
    });
  });
}

async function seedTombstone(
  store: ProfileStore,
  remote: MemoryRemote,
  id: string,
  version: number,
): Promise<void> {
  const key = `deleted.vendor.${id}`;
  store.set(key, JSON.stringify({ $tombstone: true, id }), false);
  remote.current = { version, entries: store.exportStoredSnapshot() };
}

async function readOutbox(): Promise<Array<Record<string, unknown>>> {
  const db = accountDatabase();
  if (!await db.schema.hasTable(OUTBOX)) return [];
  return db(OUTBOX).select("operationId", "sequence", "op", "vendorId", "status");
}

function openPair(
  root: string,
  userUUID: string,
  account: { issuer: string; userId: number },
  dataKey = crypto.randomBytes(32),
) {
  const remote = new MemoryRemote();
  const store = new ProfileStore(root, userUUID, new ProfileCrypto(userUUID, dataKey));
  const sync = new ProfileSync(store, remote, () => 0, { account });
  return { remote, store, sync, dataKey };
}

test("1. A 的延迟 upsert 切到 B 后，不得清 B tombstone 或复活 B 陈旧供应商", async () => {
  const root = createUniqueWorktreeRoot("r23-switch-b");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";
  const id = "crossVendor";
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await prepareUserDatabase(identityA);
    await prepareUserDatabase(identityB);
    const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
    const a = openPair(root, uuidA, identityA);
    const b = openPair(root, uuidB, identityB);
    try {
      await runWithUserStorage(identityB, async () => {
        await insertVendor(id, "sk-b-stale");
      });
      await seedTombstone(b.store, b.remote, id, 4);
      adapter.bindAccountProfileSync(null);
      await runWithUserStorage(identityA, async () => {
        await commitExplicitVendor(adapter, { op: "upsert", id }, "sk-a-new");
        await adapter.afterVendorConfigWrite({ op: "upsert", id });
      });
      adapter.bindAccountProfileSync(b.sync);
      await runWithUserStorage(identityB, () => adapter.afterAccountSettingsWrite());
      await b.sync.flush();
      const decoded = b.store.decodeStoredEntries(b.remote.current.entries);
      assert.ok(
        tombstonesFor(decoded, id).length > 0,
        `B 的 deleted.vendor* 必须保留，实际=${tombstonesFor(decoded, id).join(",")}`,
      );
      assert.equal(decoded[`vendor.${id}`], undefined, "不得把 B 的陈旧供应商上传为 live");
      const aDecoded = a.store.exportStoredSnapshot();
      assert.equal(
        Object.keys(aDecoded).some((key) => key === `vendor.${id}` || key.includes(id)),
        false,
        "A 的 mutation 在未绑定 A 时不得被 B 消费掉",
      );
    } finally {
      adapter.bindAccountProfileSync(null);
      a.store.close();
      b.store.close();
    }
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});

test("2. 相同 vendor id 的 A upsert 与 B delete 必须按账号隔离，不得由 boundSync 决定归属", async () => {
  const root = createUniqueWorktreeRoot("r23-same-id");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";
  const id = "sharedId";
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await prepareUserDatabase(identityA);
    await prepareUserDatabase(identityB);
    const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
    const a = openPair(root, uuidA, identityA);
    const b = openPair(root, uuidB, identityB);
    try {
      await seedTombstone(a.store, a.remote, id, 2);
      await seedTombstone(b.store, b.remote, id, 2);
      adapter.bindAccountProfileSync(null);
      await runWithUserStorage(identityA, async () => {
        await commitExplicitVendor(adapter, { op: "upsert", id }, "sk-a-keep");
        await adapter.afterVendorConfigWrite({ op: "upsert", id });
      });
      await runWithUserStorage(identityB, async () => {
        await commitExplicitVendor(adapter, { op: "delete", id });
        await adapter.afterVendorConfigWrite({ op: "delete", id });
      });
      adapter.bindAccountProfileSync(b.sync);
      await runWithUserStorage(identityB, () => adapter.notifyAccountSettingsMutated());
      adapter.bindAccountProfileSync(a.sync);
      await runWithUserStorage(identityA, () => adapter.notifyAccountSettingsMutated());
      await a.sync.flush();
      const aDecoded = a.store.decodeStoredEntries(a.remote.current.entries);
      assert.ok(aDecoded[`vendor.${id}`], "A 的 upsert 必须仍属于 A，不得被 B 的 boundSync 吃掉");
      assert.deepEqual(tombstonesFor(aDecoded, id), [], "A 明确重建后 A 的 tombstone 必须清掉");
    } finally {
      adapter.bindAccountProfileSync(null);
      a.store.close();
      b.store.close();
    }
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});

test("3. boundSync=null 时产生的 A mutation，登录 B 不得消费，也不得滞留全局队列", async () => {
  const root = createUniqueWorktreeRoot("r23-login-b");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";
  const id = "unboundA";
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await prepareUserDatabase(identityA);
    await prepareUserDatabase(identityB);
    const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
    const b = openPair(root, uuidB, identityB);
    try {
      await runWithUserStorage(identityB, async () => {
        await insertVendor(id, "sk-b-stale");
      });
      await seedTombstone(b.store, b.remote, id, 3);
      adapter.bindAccountProfileSync(null);
      await runWithUserStorage(identityA, async () => {
        await commitExplicitVendor(adapter, { op: "upsert", id }, "sk-a-only");
        await adapter.afterVendorConfigWrite({ op: "upsert", id });
      });
      adapter.bindAccountProfileSync(b.sync);
      await b.sync.login();
      await runWithUserStorage(identityB, () => adapter.notifyAccountSettingsMutated());
      await b.sync.flush();
      const decoded = b.store.decodeStoredEntries(b.remote.current.entries);
      assert.ok(tombstonesFor(decoded, id).length > 0, "登录 B 不得消费 A 的未绑定 mutation");
      assert.equal(decoded[`vendor.${id}`], undefined, "B 不得出现 A 的 live 键");
    } finally {
      adapter.bindAccountProfileSync(null);
      b.store.close();
    }
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});

test("4. 供应商 DB 已提交、capture 前崩溃，重启同一账号必须恢复 mutation", async () => {
  const root = createUniqueWorktreeRoot("r23-crash-recover");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";
  const id = "crashKeep";
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identityA);
    const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
    const first = openPair(root, uuidA, identityA);
    try {
      await seedTombstone(first.store, first.remote, id, 5);
      await runWithUserStorage(identityA, async () => {
        await commitExplicitVendor(adapter, { op: "upsert", id }, "sk-crash-keep");
      });
      first.store.close();
      await destroyAllDatabaseHandles();
      await activateUserDatabase(identityA);
      const restarted = openPair(root, uuidA, identityA, first.dataKey);
      try {
        restarted.remote.current = first.remote.current;
        adapter.bindAccountProfileSync(restarted.sync);
        await runWithUserStorage(identityA, () => adapter.notifyAccountSettingsMutated());
        await restarted.sync.flush();
        assert.ok(
          await runWithUserStorage(identityA, () => accountDatabase()("o_vendorConfig").where({ id }).first()),
          "崩溃恢复后 DB 行必须仍在",
        );
        const decoded = restarted.store.decodeStoredEntries(restarted.remote.current.entries);
        assert.ok(decoded[`vendor.${id}`], "重启后必须恢复明确 upsert，不得要求用户重做");
        assert.deepEqual(tombstonesFor(decoded, id), [], "恢复的 upsert 必须清掉历史 tombstone");
      } finally {
        adapter.bindAccountProfileSync(null);
        restarted.store.close();
      }
    } finally {
      first.store.close();
    }
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});

test("5. 供应商事务注入失败时，vendor 行与 mutation 必须一起回滚", async () => {
  const root = createUniqueWorktreeRoot("r23-trx-rollback");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";
  const id = "trxFail";
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identityA);
    await runWithUserStorage(identityA, async () => {
      const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
      const pair = openPair(root, uuidA, identityA);
      try {
        adapter.bindAccountProfileSync(pair.sync);
        await adapter.ensureVendorMutationOutbox(accountDatabase());
        await accountDatabase().raw(`
          CREATE TRIGGER r23_fail_vendor_outbox
          BEFORE INSERT ON ${OUTBOX}
          BEGIN
            SELECT RAISE(ABORT, 'injected outbox failure');
          END
        `);
        await assert.rejects(
          () => commitExplicitVendor(adapter, { op: "upsert", id }, "sk-trx-secret"),
          /injected outbox failure|SQLITE|outbox/i,
        );
        assert.equal(
          await accountDatabase()("o_vendorConfig").where({ id }).first(),
          undefined,
          "mutation 消费失败时 o_vendorConfig 必须回滚",
        );
        pair.store.close();
      } finally {
        adapter.bindAccountProfileSync(null);
      }
    });
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});

test("6. pending 已落盘、outbox 未确认时重启重放必须幂等", async () => {
  const root = createUniqueWorktreeRoot("r23-replay");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";
  const id = "replayOnce";
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identityA);
    const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
    const first = openPair(root, uuidA, identityA);
    try {
      adapter.bindAccountProfileSync(first.sync);
      await runWithUserStorage(identityA, async () => {
        await commitExplicitVendor(adapter, { op: "upsert", id }, "sk-replay");
        await adapter.afterVendorConfigWrite({ op: "upsert", id });
      });
      assert.ok(first.store.hasPendingMutations() || first.store.get(`vendor.${id}`), "profile pending 必须已落盘");
      first.store.close();
      await destroyAllDatabaseHandles();
      await activateUserDatabase(identityA);
      const restarted = openPair(root, uuidA, identityA, first.dataKey);
      try {
        restarted.remote.current = first.remote.current;
        adapter.bindAccountProfileSync(restarted.sync);
        await runWithUserStorage(identityA, () => adapter.notifyAccountSettingsMutated());
        await restarted.sync.flush();
        await runWithUserStorage(identityA, () => adapter.notifyAccountSettingsMutated());
        await restarted.sync.flush();
        const decoded = restarted.store.decodeStoredEntries(restarted.remote.current.entries);
        const lives = Object.keys(decoded).filter((key) => key === `vendor.${id}` || key === `vendorItem.${sha16(id)}`);
        assert.deepEqual(lives, [`vendor.${id}`], `重放不得产生重复 live 键，实际=${lives.join(",")}`);
        assert.equal(tombstonesFor(decoded, id).length, 0, "重放不得额外生成 tombstone");
      } finally {
        adapter.bindAccountProfileSync(null);
        restarted.store.close();
      }
    } finally {
      first.store.close();
    }
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});

test("7. 同一账号同一 ID 的 upsert→delete→upsert 必须收敛到最后一次明确操作", async () => {
  const root = createUniqueWorktreeRoot("r23-last-op");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";
  const id = "lastWins";
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identityA);
    const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
    const pair = openPair(root, uuidA, identityA);
    try {
      adapter.bindAccountProfileSync(null);
      await runWithUserStorage(identityA, async () => {
        await commitExplicitVendor(adapter, { op: "upsert", id }, "sk-first");
        await commitExplicitVendor(adapter, { op: "delete", id });
        await commitExplicitVendor(adapter, { op: "upsert", id }, "sk-final");
        await adapter.afterVendorConfigWrite();
      });
      adapter.bindAccountProfileSync(pair.sync);
      await runWithUserStorage(identityA, () => adapter.notifyAccountSettingsMutated());
      await pair.sync.flush();
      const decoded = pair.store.decodeStoredEntries(pair.remote.current.entries);
      assert.ok(decoded[`vendor.${id}`], "最后一次 upsert 必须获胜");
      assert.match(decoded[`vendor.${id}`], /sk-final/);
      assert.deepEqual(tombstonesFor(decoded, id), [], "最后一次是 upsert 时不得留下 tombstone");
    } finally {
      adapter.bindAccountProfileSync(null);
      pair.store.close();
    }
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});

test("8. 七条生产路由必须在账号库留下 durable outbox，且不得写入密钥", async () => {
  const root = createUniqueWorktreeRoot("r23-routes");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identityA);
    await runWithUserStorage(identityA, async () => {
      const app = express();
      app.use(express.json());
      app.use((_req, _res, next) => {
        enterUserStorage(identityA);
        next();
      });
      app.use("/addVendor", (await import("../../src/routes/setting/vendorConfig/addVendor")).default);
      app.use("/updateVendorInputs", (await import("../../src/routes/setting/vendorConfig/updateVendorInputs")).default);
      app.use("/enableVendor", (await import("../../src/routes/setting/vendorConfig/enableVendor")).default);
      app.use("/addVendorModel", (await import("../../src/routes/setting/vendorConfig/addVendorModel")).default);
      app.use("/upVendorModel", (await import("../../src/routes/setting/vendorConfig/upVendorModel")).default);
      app.use("/delVendorModel", (await import("../../src/routes/setting/vendorConfig/delVendorModel")).default);
      app.use("/deleteVendor", (await import("../../src/routes/setting/vendorConfig/deleteVendor")).default);
      const server = await new Promise<http.Server>((resolve) => {
        const created = app.listen(0, "127.0.0.1", () => resolve(created));
      });
      const port = Number((server.address() as { port: number }).port);
      const post = async (route: string, body: unknown) => {
        const response = await fetch(`http://127.0.0.1:${port}${route}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: response.status, json: await response.json().catch(() => undefined) };
      };
      try {
        const tsCode = `
exports.vendor = {
  id: "routeAdd",
  author: "t",
  name: "routeAdd",
  inputs: [{ key: "apiKey", label: "k", type: "password", required: true }],
  inputValues: { apiKey: "sk-route-secret" },
  models: [],
};
exports.textRequest = {};
exports.imageRequest = {};
exports.videoRequest = {};
`;
        const added = await post("/addVendor", { tsCode });
        assert.equal(added.status, 200, `addVendor 必须成功，实际=${added.status} ${JSON.stringify(added.json)}`);
        let box = await readOutbox();
        assert.ok(box.some((row) => row.vendorId === "routeAdd" && row.op === "upsert"), `addVendor 必须写 outbox，实际=${JSON.stringify(box)}`);

        await insertVendor("routeUpd", "sk-old");
        const updated = await post("/updateVendorInputs", { id: "routeUpd", inputValues: { apiKey: "sk-new" } });
        assert.equal(updated.status, 200, `updateVendorInputs 必须成功，实际=${updated.status}`);
        box = await readOutbox();
        assert.ok(box.some((row) => row.vendorId === "routeUpd" && row.op === "upsert"), "updateVendorInputs 必须写 outbox");

        const enabled = await post("/enableVendor", { id: "routeUpd", enable: 0 });
        assert.equal(enabled.status, 200, "enableVendor 必须成功");
        const modeled = await post("/addVendorModel", {
          id: "routeUpd",
          model: { name: "m", modelName: "m1", type: "text", think: false },
        });
        assert.equal(modeled.status, 200, `addVendorModel 必须成功，实际=${modeled.status}`);
        const upped = await post("/upVendorModel", {
          id: "routeUpd",
          modelName: "m1",
          model: { name: "m2", modelName: "m2", type: "text", think: false },
        });
        assert.equal(upped.status, 200, `upVendorModel 必须成功，实际=${upped.status}`);
        const deletedModel = await post("/delVendorModel", { id: "routeUpd", modelName: "m2" });
        assert.equal(deletedModel.status, 200, `delVendorModel 必须成功，实际=${deletedModel.status}`);
        const deleted = await post("/deleteVendor", { id: "routeUpd" });
        assert.equal(deleted.status, 200, `deleteVendor 必须成功，实际=${deleted.status}`);
        box = await readOutbox();
        assert.ok(box.some((row) => row.vendorId === "routeUpd" && row.op === "delete"), "deleteVendor 必须写 delete outbox");
        const dumped = JSON.stringify(box);
        assert.doesNotMatch(dumped, /sk-route-secret|sk-new|apiKey|inputValues/i, "outbox 不得包含密钥或 payload");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});
