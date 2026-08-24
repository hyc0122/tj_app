/**
 * Round19 RED：ProfileSync 并发新增、显式删除、空集合、崩溃恢复必须打到生产入口。
 * 禁止把「本机快照缺键」当成删除；pending 必须落入 profile.sqlite。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import express from "express";

import { ProfileCrypto } from "../../src/tianjiang/crypto/profile-crypto";
import { ProfileStore } from "../../src/tianjiang/data/profile-store";
import {
  ProfileConflictError,
  ProfileSync,
  type ProfileRemote,
  type ProfileSnapshot,
} from "../../src/tianjiang/sync/profile-sync";
import { enterUserStorage, runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import {
  activateUserDatabase,
  accountDatabase,
  destroyAllDatabaseHandles,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import getPath from "../../src/utils/getPath";
import { closeActivatedWorkspaceRuntime, createUniqueWorktreeRoot } from "./helpers/worktree-runtime";

const userUUID = "123e4567-e89b-42d3-a456-426614174190";
const identityA = { issuer: "https://api.j11.com.cn", userId: 1901 };
const identityB = { issuer: "https://api.j11.com.cn", userId: 1902 };
const sharedDataKey = crypto.randomBytes(32);

class MemoryRemote implements ProfileRemote {
  current: ProfileSnapshot = { version: 1, entries: {} };
  commits: Array<{ baseVersion: number; entries: ProfileSnapshot["entries"] }> = [];
  conflictInject: ProfileSnapshot["entries"] | null = null;
  getCurrentCalls = 0;
  getMetadataCalls = 0;

  async getMetadata() {
    this.getMetadataCalls += 1;
    return { version: this.current.version, etag: `profile-v${this.current.version}` };
  }

  async getCurrent(): Promise<ProfileSnapshot> {
    this.getCurrentCalls += 1;
    return structuredClone(this.current);
  }

  async commit(baseVersion: number, entries: ProfileSnapshot["entries"]): Promise<ProfileSnapshot> {
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
    return structuredClone(this.current);
  }
}

function decodePlain(entry: { value: string } | undefined): string {
  return (entry?.value ?? "").replace(/^plain:/, "");
}

function collectionKeys(entries: ProfileSnapshot["entries"], prefix: string): string[] {
  return Object.keys(entries).filter((key) => key.startsWith(prefix)).sort();
}

function findDecoded(
  entries: ProfileSnapshot["entries"],
  prefix: string,
  match: (payload: Record<string, unknown>) => boolean,
): [string, Record<string, unknown>] | undefined {
  for (const [key, entry] of Object.entries(entries)) {
    if (!key.startsWith(prefix)) continue;
    try {
      const payload = JSON.parse(decodePlain(entry)) as Record<string, unknown>;
      if (match(payload)) return [key, payload];
    } catch {
      // 非 JSON 集合值忽略。
    }
  }
  return undefined;
}

function pendingMutationCount(databasePath: string): number {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const tables = (database.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'",
    ).all() as Array<{ name: string }>).map((row) => row.name);
    const pendingTable = tables.find((name) => /pending|mutation/i.test(name) && name !== "profile_settings");
    if (!pendingTable) return 0;
    const row = database.prepare(`SELECT COUNT(*) AS c FROM "${pendingTable}"`).get() as { c: number };
    return Number(row.c ?? 0);
  } finally {
    database.close();
  }
}

async function listen(app: express.Express) {
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 200));
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function openSync(root: string, remote: MemoryRemote) {
  const store = new ProfileStore(root, userUUID, new ProfileCrypto(userUUID, sharedDataKey));
  const sync = new ProfileSync(store, remote, () => 0);
  return { store, sync };
}

async function postJson(port: number, route: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => undefined);
  return { status: response.status, json };
}

const appearanceBody = {
  theme: { mode: "dark" as const, primaryColor: "#111111", fontSize: 16 },
  language: "en",
};

async function drainAdapter(
  adapter: typeof import("../../src/tianjiang/sync/profile-settings-adapter"),
): Promise<void> {
  await adapter.notifyAccountSettingsMutated().catch(() => undefined);
  adapter.bindAccountProfileSync(null);
}

async function addLiveCollections(label: string): Promise<{
  vendorId: string;
  promptId: number;
  agentKey: string;
  model: string;
  skillRel: string;
}> {
  const vendorId = `remote${label}`;
  const promptId = label === "New" ? 19103 : 19100 + label.length;
  const agentKey = `r19Agent${label}`;
  const model = `r19model${label}`;
  const db = accountDatabase();
  await db("o_vendorConfig").insert({
    id: vendorId,
    inputValues: JSON.stringify({ apiKey: `sk-${label}` }),
    models: "[]",
    enable: 1,
  });
  await db("o_prompt").insert({
    id: promptId,
    name: `prompt-${label}`,
    type: "video",
    data: `body-${label}`,
    useData: `body-${label}`,
  });
  const maxAgent = await db("o_agentDeploy").max<{ maxId: number | null }>("id as maxId").first();
  await db("o_agentDeploy").insert({
    id: Number(maxAgent?.maxId ?? 0) + 1,
    key: agentKey,
    name: `Agent ${label}`,
    desc: `desc-${label}`,
    vendorId: "tianjiang",
    model: `m-${label}`,
    modelName: `模型${label}`,
    disabled: 0,
  });
  const { ensureCurrentAccountBuiltinSkills } = await import("../../src/tianjiang/skills/account-skills");
  const { skillsRoot } = await ensureCurrentAccountBuiltinSkills(getPath());
  const skillRel = `r19-${label}.md`;
  fs.writeFileSync(path.join(skillsRoot, skillRel), `# skill ${label}\nA新增`);
  return { vendorId, promptId, agentKey, model, skillRel };
}

test("A 新增集合后，旧快照 B 只改 language 不得静默删除 A 的新增", async () => {
  const rootA = createUniqueWorktreeRoot("r19-stale-a");
  const rootB = createUniqueWorktreeRoot("r19-stale-b");
  const originalCwd = process.cwd();
  const remote = new MemoryRemote();
  process.env.NODE_ENV = "prod";
  const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
  let storeA: ProfileStore | undefined;
  let storeB: ProfileStore | undefined;
  try {
    process.chdir(rootA);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identityA);
    await runWithUserStorage(identityA, async () => {
      const opened = openSync(rootA, remote);
      storeA = opened.store;
      adapter.bindAccountProfileSync(opened.sync);
      await opened.sync.login();
      const added = await addLiveCollections("New");
      const app = express();
      app.use(express.json());
      app.use((_req, _res, next) => {
        enterUserStorage(identityA);
        next();
      });
      app.use("/api/setting/modelMap/savePrompt", (await import("../../src/routes/setting/modelMap/savePrompt")).default);
      app.use("/api/setting/modelMap/bindingPrompt", (await import("../../src/routes/setting/modelMap/bindingPrompt")).default);
      const { server, port } = await listen(app);
      try {
        const saved = await postJson(port, "/api/setting/modelMap/savePrompt", {
          name: added.model,
          data: "# A模型提示词\nremote-new",
          type: "video",
        });
        assert.equal(saved.status, 200, `savePrompt 必须成功，实际=${saved.status}`);
        const bound = await postJson(port, "/api/setting/modelMap/bindingPrompt", {
          vendorId: "tianjiang",
          model: added.model,
          path: `video/${added.model}.md`,
          fileName: `${added.model}.md`,
        });
        assert.equal(bound.status, 200, `bindingPrompt 必须成功，实际=${bound.status}`);
      } finally {
        await closeServer(server);
      }
      await adapter.notifyAccountSettingsMutated();
      await opened.sync.flush();
      assert.ok(remote.current.entries[`vendor.${added.vendorId}`], "A flush 后远端必须有新增供应商");
      assert.ok(remote.current.entries[`prompt.${added.promptId}`], "A flush 后远端必须有新增提示词");
      assert.ok(remote.current.entries[`agent.${added.agentKey}`], "A flush 后远端必须有新增 Agent");
      assert.ok(
        findDecoded(remote.current.entries, "model.", (payload) => payload.model === added.model),
        "A flush 后远端必须有新增模型映射",
      );
      assert.ok(
        findDecoded(remote.current.entries, "skill.", (payload) => payload.path === added.skillRel),
        "A flush 后远端必须有新增 Skill",
      );
      await drainAdapter(adapter);
    });
    storeA?.close();
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());

    process.chdir(rootB);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identityB);
    await runWithUserStorage(identityB, async () => {
      const opened = openSync(rootB, remote);
      storeB = opened.store;
      adapter.bindAccountProfileSync(opened.sync);
      // 中文注释：B 只对齐旧基线，禁止先拉 A 的新快照。
      opened.store.applyStoredSnapshot({}, 1);
      const app = express();
      app.use(express.json());
      app.use((_req, _res, next) => {
        enterUserStorage(identityB);
        next();
      });
      app.use("/api/setting/appearance/updateAppearance", (await import("../../src/routes/setting/appearance/updateAppearance")).default);
      const { server, port } = await listen(app);
      try {
        const changed = await postJson(port, "/api/setting/appearance/updateAppearance", appearanceBody);
        assert.equal(changed.status, 200, `B 改 language 必须走正式入口，实际=${changed.status}`);
      } finally {
        await closeServer(server);
      }
      await opened.sync.flush();
      const remoteNewRetained = Boolean(remote.current.entries["vendor.remoteNew"]);
      const promptRetained = Boolean(remote.current.entries["prompt.19103"]);
      const agentRetained = Boolean(remote.current.entries["agent.r19AgentNew"]);
      const modelRetained = Boolean(findDecoded(
        remote.current.entries,
        "model.",
        (payload) => payload.model === "r19modelNew",
      ));
      const skillRetained = Boolean(findDecoded(
        remote.current.entries,
        "skill.",
        (payload) => payload.path === "r19-New.md",
      ));
      assert.equal(
        remoteNewRetained,
        true,
        `旧 B 只改 language 不得删除 A 新增供应商 remoteNewRetained=${remoteNewRetained} vendors=${collectionKeys(remote.current.entries, "vendor.").join(",")}`,
      );
      assert.equal(promptRetained, true, `A 新增提示词必须保留 promptRetained=${promptRetained}`);
      assert.equal(agentRetained, true, `A 新增 Agent 必须保留 agentRetained=${agentRetained}`);
      assert.equal(modelRetained, true, `A 新增模型映射必须保留 modelRetained=${modelRetained}`);
      assert.equal(skillRetained, true, `A 新增 Skill 必须保留 skillRetained=${skillRetained}`);
      assert.equal(decodePlain(remote.current.entries.language), "en");
    });
  } finally {
    adapter.bindAccountProfileSync(null);
    storeB?.close();
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});

test("A/B 并发新增不同集合项，最终两边都必须保留", async () => {
  const rootA = createUniqueWorktreeRoot("r19-conc-a");
  const rootB = createUniqueWorktreeRoot("r19-conc-b");
  const originalCwd = process.cwd();
  const remote = new MemoryRemote();
  process.env.NODE_ENV = "prod";
  const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
  let storeA: ProfileStore | undefined;
  let storeB: ProfileStore | undefined;
  try {
    process.chdir(rootA);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identityA);
    await runWithUserStorage(identityA, async () => {
      const opened = openSync(rootA, remote);
      storeA = opened.store;
      adapter.bindAccountProfileSync(opened.sync);
      await opened.sync.login();
      await accountDatabase()("o_vendorConfig").insert({
        id: "aOnly",
        inputValues: JSON.stringify({ apiKey: "sk-a-only" }),
        models: "[]",
        enable: 1,
      });
      await adapter.notifyAccountSettingsMutated();
      await opened.sync.flush();
      await drainAdapter(adapter);
    });
    storeA?.close();
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());

    process.chdir(rootB);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identityB);
    await runWithUserStorage(identityB, async () => {
      const opened = openSync(rootB, remote);
      storeB = opened.store;
      adapter.bindAccountProfileSync(opened.sync);
      opened.store.applyStoredSnapshot({}, 1);
      await accountDatabase()("o_vendorConfig").insert({
        id: "bOnly",
        inputValues: JSON.stringify({ apiKey: "sk-b-only" }),
        models: "[]",
        enable: 1,
      });
      await adapter.notifyAccountSettingsMutated();
      await opened.sync.flush();
      assert.ok(
        remote.current.entries["vendor.aOnly"],
        `并发新增后 A 的 vendor.aOnly 必须保留，实际=${collectionKeys(remote.current.entries, "vendor.").join(",")}`,
      );
      assert.ok(
        remote.current.entries["vendor.bOnly"],
        `并发新增后 B 的 vendor.bOnly 必须保留，实际=${collectionKeys(remote.current.entries, "vendor.").join(",")}`,
      );
    });
  } finally {
    adapter.bindAccountProfileSync(null);
    storeB?.close();
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});

test("B 观察到条目后显式删除必须传播；删到空集合时另一设备必须清空", async () => {
  const rootA = createUniqueWorktreeRoot("r19-del-a");
  const rootB = createUniqueWorktreeRoot("r19-del-b");
  const originalCwd = process.cwd();
  const remote = new MemoryRemote();
  process.env.NODE_ENV = "prod";
  const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
  let storeA: ProfileStore | undefined;
  let storeB: ProfileStore | undefined;
  try {
    process.chdir(rootA);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identityA);
    await runWithUserStorage(identityA, async () => {
      const opened = openSync(rootA, remote);
      storeA = opened.store;
      adapter.bindAccountProfileSync(opened.sync);
      await accountDatabase()("o_vendorConfig").insert({
        id: "lastVendor",
        inputValues: JSON.stringify({ apiKey: "sk-last" }),
        models: "[]",
        enable: 1,
      });
      await accountDatabase()("o_prompt").insert({
        id: 19201,
        name: "last-prompt",
        type: "video",
        data: "keep",
        useData: "keep",
      });
      await adapter.notifyAccountSettingsMutated();
      await opened.sync.flush();
      await drainAdapter(adapter);
    });
    storeA?.close();
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());

    process.chdir(rootB);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identityB);
    await runWithUserStorage(identityB, async () => {
      const opened = openSync(rootB, remote);
      storeB = opened.store;
      adapter.bindAccountProfileSync(opened.sync);
      const downloaded = await opened.sync.reconcile("login");
      assert.notEqual(downloaded.state, "failed", `B 首次对账不得失败，实际=${downloaded.state}`);
      const seen = await accountDatabase()("o_vendorConfig").where({ id: "lastVendor" }).first();
      assert.ok(seen, "B 必须先观察到 lastVendor");
      const app = express();
      app.use(express.json());
      app.use((_req, _res, next) => {
        enterUserStorage(identityB);
        next();
      });
      app.use("/api/setting/vendorConfig/deleteVendor", (await import("../../src/routes/setting/vendorConfig/deleteVendor")).default);
      const { server, port } = await listen(app);
      try {
        const deleted = await postJson(port, "/api/setting/vendorConfig/deleteVendor", { id: "lastVendor" });
        assert.equal(deleted.status, 200, `显式删除必须走 deleteVendor，实际=${deleted.status}`);
      } finally {
        await closeServer(server);
      }
      await accountDatabase()("o_prompt").del();
      await adapter.notifyAccountSettingsMutated();
      await opened.sync.flush();
      assert.equal(
        remote.current.entries["vendor.lastVendor"],
        undefined,
        `显式删除后远端 lastVendor 必须消失，实际=${collectionKeys(remote.current.entries, "vendor.").join(",")}`,
      );
      assert.equal(
        collectionKeys(remote.current.entries, "prompt.").length,
        0,
        `删光提示词后远端 prompt.* 必须为空，实际=${collectionKeys(remote.current.entries, "prompt.").join(",")}`,
      );
    });
    storeB?.close();
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());

    process.chdir(rootA);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identityA);
    await runWithUserStorage(identityA, async () => {
      const opened = openSync(rootA, remote);
      storeA = opened.store;
      adapter.bindAccountProfileSync(opened.sync);
      const applied = await opened.sync.reconcile("login");
      assert.notEqual(applied.state, "failed", `A 对账不得失败，实际=${applied.state} ${opened.sync.status().failureReason ?? ""}`);
      const vendor = await accountDatabase()("o_vendorConfig").where({ id: "lastVendor" }).first();
      assert.equal(vendor, undefined, "权威删除后 A 本地 lastVendor 必须清空");
      const prompts = await accountDatabase()("o_prompt").select("id");
      assert.equal(
        prompts.length,
        0,
        `权威空提示词集合必须清空 A 本地，实际残留=${prompts.map((row) => row.id).join(",")}`,
      );
    });
  } finally {
    adapter.bindAccountProfileSync(null);
    storeA?.close();
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});

test("409 冲突重试后，互不相关新增与显式删除仍须符合策略", async () => {
  const rootB = createUniqueWorktreeRoot("r19-409-b");
  const originalCwd = process.cwd();
  const remote = new MemoryRemote();
  process.env.NODE_ENV = "prod";
  const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
  const cryptoForUser = new ProfileCrypto(userUUID, sharedDataKey);
  const seedStore = new ProfileStore(rootB, userUUID, cryptoForUser);
  seedStore.set("language", "zh-CN", false);
  seedStore.set("vendor.keepMe", JSON.stringify({ inputValues: { apiKey: "keep" }, models: [], enable: 1 }), true);
  seedStore.set("vendor.deleteMe", JSON.stringify({ inputValues: { apiKey: "del" }, models: [], enable: 1 }), true);
  remote.current = { version: 4, entries: seedStore.exportStoredSnapshot() };
  seedStore.close();
  const aStore = new ProfileStore(createUniqueWorktreeRoot("r19-409-a"), userUUID, cryptoForUser);
  aStore.set("vendor.aConflict", JSON.stringify({ inputValues: { apiKey: "sk-a" }, models: [], enable: 1 }), true);
  const aNew = aStore.exportStoredSnapshot()["vendor.aConflict"];
  aStore.close();
  try {
    process.chdir(rootB);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identityB);
    await runWithUserStorage(identityB, async () => {
      const storeB = new ProfileStore(rootB, userUUID, cryptoForUser);
      const syncB = new ProfileSync(storeB, remote, () => 0);
      adapter.bindAccountProfileSync(syncB);
      await syncB.login();
      await accountDatabase()("o_vendorConfig").insert({
        id: "bConflict",
        inputValues: JSON.stringify({ apiKey: "sk-b" }),
        models: "[]",
        enable: 1,
      });
      const existingDelete = await accountDatabase()("o_vendorConfig").where({ id: "deleteMe" }).first();
      if (existingDelete) await accountDatabase()("o_vendorConfig").where({ id: "deleteMe" }).del();
      const app = express();
      app.use(express.json());
      app.use((_req, _res, next) => {
        enterUserStorage(identityB);
        next();
      });
      app.use("/api/setting/vendorConfig/deleteVendor", (await import("../../src/routes/setting/vendorConfig/deleteVendor")).default);
      const { server, port } = await listen(app);
      try {
        if (await accountDatabase()("o_vendorConfig").where({ id: "deleteMe" }).first()) {
          await postJson(port, "/api/setting/vendorConfig/deleteVendor", { id: "deleteMe" });
        }
      } finally {
        await closeServer(server);
      }
      await adapter.notifyAccountSettingsMutated();
      remote.conflictInject = { "vendor.aConflict": aNew };
      await syncB.flush();
      assert.ok(remote.current.entries["vendor.keepMe"], "冲突重试后无关保留项必须仍在");
      assert.ok(
        remote.current.entries["vendor.aConflict"],
        `冲突重试后 A 的新增不得被覆盖，实际=${collectionKeys(remote.current.entries, "vendor.").join(",")}`,
      );
      assert.ok(remote.current.entries["vendor.bConflict"], "冲突重试后 B 的新增必须提交");
      assert.equal(
        remote.current.entries["vendor.deleteMe"],
        undefined,
        "冲突重试后 B 的显式删除必须生效",
      );
      storeB.close();
    });
  } finally {
    adapter.bindAccountProfileSync(null);
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});

test("commit 前崩溃后重启不得丢 pending；commit 后未清 pending 不得错误重放", async () => {
  const rootA = createUniqueWorktreeRoot("r19-crash-a");
  const originalCwd = process.cwd();
  const remote = new MemoryRemote();
  process.env.NODE_ENV = "prod";
  const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
  try {
    process.chdir(rootA);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identityA);
    await runWithUserStorage(identityA, async () => {
      const first = openSync(rootA, remote);
      adapter.bindAccountProfileSync(first.sync);
      await first.sync.login();
      const app = express();
      app.use(express.json());
      app.use((_req, _res, next) => {
        enterUserStorage(identityA);
        next();
      });
      app.use("/api/setting/appearance/updateAppearance", (await import("../../src/routes/setting/appearance/updateAppearance")).default);
      const { server, port } = await listen(app);
      try {
        const changed = await postJson(port, "/api/setting/appearance/updateAppearance", appearanceBody);
        assert.equal(changed.status, 200);
      } finally {
        await closeServer(server);
      }
      const pendingBeforeFlush = pendingMutationCount(first.store.databasePath);
      assert.ok(
        pendingBeforeFlush > 0,
        `pending 必须落入 profile.sqlite，实际 pendingCount=${pendingBeforeFlush} path=${first.store.databasePath}`,
      );
      const dbPath = first.store.databasePath;
      // 中文注释：模拟进程崩溃，禁止再 flush；只解绑避免定时器打到已关闭句柄。
      adapter.bindAccountProfileSync(null);
      first.store.close();

      const restarted = openSync(rootA, remote);
      adapter.bindAccountProfileSync(restarted.sync);
      await restarted.sync.flush();
      assert.equal(
        decodePlain(remote.current.entries.language),
        "en",
        `commit 前崩溃重启后 language 必须仍能提交，实际=${decodePlain(remote.current.entries.language)}`,
      );
      const pendingAfterFlush = pendingMutationCount(dbPath);
      assert.equal(
        pendingAfterFlush,
        0,
        `远端提交成功后必须清 pending，实际=${pendingAfterFlush}`,
      );

      // 中文注释：模拟 commit 已成功但本地 pending 未清，再注入无关远端新增。
      restarted.sync.setPersistent("language", "ja", false);
      const leftover = pendingMutationCount(dbPath);
      assert.ok(leftover > 0, `再次本地变更必须重新落入 sqlite，实际=${leftover}`);
      const keepStore = new ProfileStore(createUniqueWorktreeRoot("r19-crash-keep"), userUUID, new ProfileCrypto(userUUID, sharedDataKey));
      keepStore.set("vendor.crashKeep", JSON.stringify({ inputValues: {}, models: [], enable: 1 }), true);
      remote.current = {
        version: remote.current.version + 1,
        entries: {
          ...remote.current.entries,
          "vendor.crashKeep": keepStore.exportStoredSnapshot()["vendor.crashKeep"],
        },
      };
      keepStore.close();
      await restarted.sync.flush();
      assert.ok(
        remote.current.entries["vendor.crashKeep"],
        `未清 pending 重启重放不得删掉本机未观察的远端新增，实际=${collectionKeys(remote.current.entries, "vendor.").join(",")}`,
      );
      assert.equal(decodePlain(remote.current.entries.language), "ja");
      restarted.store.close();
    });
  } finally {
    adapter.bindAccountProfileSync(null);
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});

test("删除模型提示词后库行和 Markdown 都必须消失，空正文必须截断文件", async () => {
  const rootA = createUniqueWorktreeRoot("r19-prompt-a");
  const rootB = createUniqueWorktreeRoot("r19-prompt-b");
  const originalCwd = process.cwd();
  const remote = new MemoryRemote();
  process.env.NODE_ENV = "prod";
  const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
  let storeA: ProfileStore | undefined;
  let storeB: ProfileStore | undefined;
  try {
    process.chdir(rootA);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identityA);
    await runWithUserStorage(identityA, async () => {
      const opened = openSync(rootA, remote);
      storeA = opened.store;
      adapter.bindAccountProfileSync(opened.sync);
      const app = express();
      app.use(express.json());
      app.use((_req, _res, next) => {
        enterUserStorage(identityA);
        next();
      });
      app.use("/api/setting/modelMap/savePrompt", (await import("../../src/routes/setting/modelMap/savePrompt")).default);
      app.use("/api/setting/modelMap/bindingPrompt", (await import("../../src/routes/setting/modelMap/bindingPrompt")).default);
      app.use("/api/setting/modelMap/updatePrompt", (await import("../../src/routes/setting/modelMap/updatePrompt")).default);
      app.use("/api/setting/modelMap/deletePrompt", (await import("../../src/routes/setting/modelMap/deletePrompt")).default);
      app.use("/api/setting/dreaminaCli/updateSettings", (await import("../../src/routes/setting/dreaminaCli/updateSettings")).default);
      const { server, port } = await listen(app);
      try {
        for (const item of [
          { name: "r19keep", data: "# keep\nbody" },
          { name: "r19ghost", data: "# ghost\nshould-delete" },
          { name: "r19empty", data: "# empty\ntruncate-me" },
        ]) {
          const saved = await postJson(port, "/api/setting/modelMap/savePrompt", {
            name: item.name,
            data: item.data,
            type: "video",
          });
          assert.equal(saved.status, 200, `${item.name} savePrompt 必须成功，实际=${saved.status}`);
          const bound = await postJson(port, "/api/setting/modelMap/bindingPrompt", {
            vendorId: "tianjiang",
            model: item.name,
            path: `video/${item.name}.md`,
            fileName: `${item.name}.md`,
          });
          assert.equal(bound.status, 200, `${item.name} bindingPrompt 必须成功`);
        }
        const dreamina = await postJson(port, "/api/setting/dreaminaCli/updateSettings", {
          preferredExecutionTarget: "wsl",
          maxConcurrency: 3,
        });
        assert.equal(dreamina.status, 200);
        await adapter.notifyAccountSettingsMutated();
        await opened.sync.flush();
      } finally {
        await closeServer(server);
      }
    });
    storeA?.close();
    await drainAdapter(adapter);
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());

    process.chdir(rootB);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identityB);
    await runWithUserStorage(identityB, async () => {
      const opened = openSync(rootB, remote);
      storeB = opened.store;
      adapter.bindAccountProfileSync(opened.sync);
      const firstApply = await opened.sync.reconcile("login");
      assert.notEqual(firstApply.state, "failed", `B 首次对账不得失败，实际=${firstApply.state}`);
      const { resolveAccountModelPromptFile } = await import("../../src/tianjiang/prompts/account-model-prompt");
      assert.equal(
        fs.readFileSync(resolveAccountModelPromptFile({ relativePath: "video/r19ghost.md" }), "utf8").includes("should-delete"),
        true,
        "B 必须先拿到将被删除的正文，才能证明删除会清文件",
      );
      assert.match(
        fs.readFileSync(resolveAccountModelPromptFile({ relativePath: "video/r19empty.md" }), "utf8"),
        /truncate-me/,
        "B 必须先拿到非空正文，才能证明空字符串会截断",
      );
      storeB.close();
      await drainAdapter(adapter);
    });
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());

    process.chdir(rootA);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identityA);
    await runWithUserStorage(identityA, async () => {
      const opened = openSync(rootA, remote);
      storeA = opened.store;
      adapter.bindAccountProfileSync(opened.sync);
      const app = express();
      app.use(express.json());
      app.use((_req, _res, next) => {
        enterUserStorage(identityA);
        next();
      });
      app.use("/api/setting/modelMap/updatePrompt", (await import("../../src/routes/setting/modelMap/updatePrompt")).default);
      app.use("/api/setting/modelMap/deletePrompt", (await import("../../src/routes/setting/modelMap/deletePrompt")).default);
      const { server, port } = await listen(app);
      try {
        const emptied = await postJson(port, "/api/setting/modelMap/updatePrompt", {
          name: "r19empty",
          data: "",
          type: "video",
        });
        assert.equal(emptied.status, 200, `空正文更新必须成功，实际=${emptied.status}`);
        const deleted = await postJson(port, "/api/setting/modelMap/deletePrompt", {
          path: "video/r19ghost.md",
        });
        assert.equal(deleted.status, 200, `deletePrompt 必须成功，实际=${deleted.status}`);
      } finally {
        await closeServer(server);
      }
      await adapter.notifyAccountSettingsMutated();
      await opened.sync.flush();
      await drainAdapter(adapter);
      const leakedDreamina = Object.keys(remote.current.entries).filter((key) => key.startsWith("dreamina."));
      assert.deepEqual(leakedDreamina, [], `dreamina.* 不得进入 ProfileSync，实际=${leakedDreamina.join(",")}`);
      assert.equal(
        Boolean(findDecoded(remote.current.entries, "model.", (payload) => payload.model === "r19ghost")),
        false,
        "删除后远端不得再有 r19ghost 映射",
      );
      const emptyEntry = findDecoded(remote.current.entries, "model.", (payload) => payload.model === "r19empty");
      assert.ok(emptyEntry, "空正文模型映射必须仍在远端");
      assert.equal(emptyEntry[1].content, "", `远端空正文必须是空字符串，实际=${JSON.stringify(emptyEntry[1].content)}`);
    });
    storeA?.close();
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());

    process.chdir(rootB);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identityB);
    await runWithUserStorage(identityB, async () => {
      const opened = openSync(rootB, remote);
      storeB = opened.store;
      adapter.bindAccountProfileSync(opened.sync);
      const downloaded = await opened.sync.reconcile("login");
      assert.notEqual(downloaded.state, "failed", `B 对账不得失败，实际=${downloaded.state} ${opened.sync.status().failureReason ?? ""}`);
      const ghostRow = await accountDatabase()("o_modelPrompt").where({ vendorId: "tianjiang", model: "r19ghost" }).first();
      assert.equal(ghostRow, undefined, "B 数据库不得残留已删模型映射");
      const { resolveAccountModelPromptFile } = await import("../../src/tianjiang/prompts/account-model-prompt");
      const ghostFile = resolveAccountModelPromptFile({ relativePath: "video/r19ghost.md" });
      assert.equal(fs.existsSync(ghostFile), false, `B 必须删除幽灵 Markdown，实际仍存在=${ghostFile}`);
      const emptyFile = resolveAccountModelPromptFile({ relativePath: "video/r19empty.md" });
      assert.equal(fs.existsSync(emptyFile), true, "空正文文件必须存在以便截断");
      assert.equal(
        fs.readFileSync(emptyFile, "utf8"),
        "",
        `远端空字符串必须把 B 文件截断为空，实际长度=${fs.existsSync(emptyFile) ? fs.readFileSync(emptyFile, "utf8").length : "missing"}`,
      );
      const app = express();
      app.use(express.json());
      app.use((_req, _res, next) => {
        enterUserStorage(identityB);
        next();
      });
      app.use("/api/setting/modelMap/getPromptList", (await import("../../src/routes/setting/modelMap/getPromptList")).default);
      app.use("/api/setting/dreaminaCli/getSettings", (await import("../../src/routes/setting/dreaminaCli/getSettings")).default);
      const { server, port } = await listen(app);
      try {
        const listed = await fetch(`http://127.0.0.1:${port}/api/setting/modelMap/getPromptList`);
        assert.equal(listed.status, 200);
        const body = await listed.json() as { data?: Array<{ path?: string; data?: string }> };
        const ghost = (body.data ?? []).find((item) => String(item.path ?? "").includes("r19ghost"));
        assert.equal(ghost, undefined, `getPromptList 不得出现幽灵项，实际=${JSON.stringify(body.data?.map((item) => item.path))}`);
        const dreamina = await fetch(`http://127.0.0.1:${port}/api/setting/dreaminaCli/getSettings`);
        const dreaminaBody = await dreamina.json() as { data?: { preferredExecutionTarget?: string } };
        assert.notEqual(
          dreaminaBody.data?.preferredExecutionTarget,
          "wsl",
          `B 不得被 A 的即梦设置覆盖，实际=${dreaminaBody.data?.preferredExecutionTarget}`,
        );
      } finally {
        await closeServer(server);
      }
    });
  } finally {
    adapter.bindAccountProfileSync(null);
    storeB?.close();
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});
