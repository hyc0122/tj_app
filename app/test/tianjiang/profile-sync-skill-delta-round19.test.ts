/**
 * Round19 RED：未修改的内置 Skill 不是用户数据，不得进入 ProfileSync。
 * 只同步自定义、override 与显式 tombstone；ensure builtin 每批最多一次。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import express from "express";

import { ProfileCrypto } from "../../src/tianjiang/crypto/profile-crypto";
import { ProfileStore } from "../../src/tianjiang/data/profile-store";
import {
  ProfileSync,
  type ProfileRemote,
  type ProfileSnapshot,
} from "../../src/tianjiang/sync/profile-sync";
import { enterUserStorage, runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import {
  activateUserDatabase,
  destroyAllDatabaseHandles,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import getPath from "../../src/utils/getPath";
import { closeActivatedWorkspaceRuntime, createUniqueWorktreeRoot } from "./helpers/worktree-runtime";
import {
  hashFileSha256,
  loadBuiltinSkillsManifest,
} from "../../src/tianjiang/skills/builtin-skill-installer";
import { resolveBuiltinSkillsResources } from "../../src/tianjiang/skills/account-skills";

const userUUID = "123e4567-e89b-42d3-a456-426614174193";
const identityA = { issuer: "https://api.j11.com.cn", userId: 1931 };
const identityB = { issuer: "https://api.j11.com.cn", userId: 1932 };
const sharedDataKey = crypto.randomBytes(32);

class MemoryRemote implements ProfileRemote {
  current: ProfileSnapshot = { version: 1, entries: {} };
  commits: ProfileSnapshot["entries"][] = [];
  async getMetadata() {
    return { version: this.current.version, etag: `profile-v${this.current.version}` };
  }
  async getCurrent() {
    return structuredClone(this.current);
  }
  async commit(_base: number, entries: ProfileSnapshot["entries"]) {
    this.commits.push(structuredClone(entries));
    this.current = { version: this.current.version + 1, entries: structuredClone(entries) };
    return structuredClone(this.current);
  }
}

function decodePlain(entry: { value: string } | undefined): string {
  return (entry?.value ?? "").replace(/^plain:/, "");
}

function skillEntries(entries: ProfileSnapshot["entries"]) {
  return Object.entries(entries).filter(([key]) => key.startsWith("skill."));
}

function snapshotBytes(entries: ProfileSnapshot["entries"]): number {
  return Buffer.byteLength(JSON.stringify(entries), "utf8");
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

async function postJson(port: number, route: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => undefined) };
}

function firstBuiltinMarkdown(): { path: string; sha256: string } {
  const resources = resolveBuiltinSkillsResources();
  const manifest = loadBuiltinSkillsManifest(resources.manifestPath);
  const entry = manifest.files.find((item) => item.path.endsWith(".md"));
  assert.ok(entry, "内置 manifest 必须有 Markdown");
  return { path: entry.path, sha256: entry.sha256 };
}

test("新账号未修改内置 Skill 时远端 skill.* 必须为 0，且不得上传约 1.5MB", async () => {
  const rootA = createUniqueWorktreeRoot("r19-skill-new-a");
  const originalCwd = process.cwd();
  const remote = new MemoryRemote();
  process.env.NODE_ENV = "prod";
  const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
  const skillsApi = await import("../../src/tianjiang/skills/account-skills");
  try {
    process.chdir(rootA);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identityA);
    await runWithUserStorage(identityA, async () => {
      const opened = openSync(rootA, remote);
      adapter.bindAccountProfileSync(opened.sync);
      skillsApi.resetEnsureBuiltinSkillsCallCount?.();
      const captureStarted = Date.now();
      await adapter.notifyAccountSettingsMutated();
      const captureMs = Date.now() - captureStarted;
      const capturedSkills = opened.store.listKeys().filter((key) => key.startsWith("skill."));
      assert.equal(
        capturedSkills.length,
        0,
        `capture 后本地 profile 不得收录未修改内置 Skill，实际=${capturedSkills.length} captureMs=${captureMs}`,
      );
      await opened.sync.flush();
      const skills = skillEntries(remote.current.entries);
      const bytes = snapshotBytes(remote.current.entries);
      const ensureCalls = skillsApi.takeEnsureBuiltinSkillsCallCount?.() ?? Number.POSITIVE_INFINITY;
      assert.equal(
        skills.length,
        0,
        `新账号未修改内置 Skill 时 skill.* 必须为 0，实际=${skills.length} bytes=${bytes} captureMs=${captureMs} ensure=${ensureCalls}`,
      );
      assert.ok(bytes < 256 * 1024, `无用户 Skill 时快照不得再上传约 1.5MB，实际=${bytes}`);
      assert.ok(ensureCalls <= 1, `capture 一批 ensure 最多一次，实际=${ensureCalls}`);
      opened.store.close();
    });
  } finally {
    adapter.bindAccountProfileSync(null);
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});

test("只同步自定义 Skill 与内置 override，删除按 tombstone 传播且不 prune 新内置", async () => {
  const rootA = createUniqueWorktreeRoot("r19-skill-delta-a");
  const rootB = createUniqueWorktreeRoot("r19-skill-delta-b");
  const originalCwd = process.cwd();
  const remote = new MemoryRemote();
  process.env.NODE_ENV = "prod";
  const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
  const skillsApi = await import("../../src/tianjiang/skills/account-skills");
  const builtin = firstBuiltinMarkdown();
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
      const { skillsRoot } = await skillsApi.ensureCurrentAccountBuiltinSkills(getPath());
      fs.writeFileSync(path.join(skillsRoot, "r19-user-custom.md"), "# 用户自定义技能\nB必须读到");
      const app = express();
      app.use(express.json());
      app.use((_req, _res, next) => {
        enterUserStorage(identityA);
        next();
      });
      app.use("/api/setting/skillManagement/saveSkillContent", (await import("../../src/routes/setting/skillManagement/saveSkillContent")).default);
      const { server, port } = await listen(app);
      try {
        const saved = await postJson(port, "/api/setting/skillManagement/saveSkillContent", {
          path: builtin.path,
          content: "# 用户覆盖内置\nB必须读到override",
        });
        assert.equal(saved.status, 200, `覆盖内置必须走 saveSkillContent，实际=${saved.status}`);
      } finally {
        await closeServer(server);
      }
      skillsApi.resetEnsureBuiltinSkillsCallCount?.();
      const captureStarted = Date.now();
      await adapter.notifyAccountSettingsMutated();
      const captureMs = Date.now() - captureStarted;
      const captureEnsure = skillsApi.takeEnsureBuiltinSkillsCallCount?.() ?? Number.POSITIVE_INFINITY;
      await opened.sync.flush();
      const applyEnsure = skillsApi.takeEnsureBuiltinSkillsCallCount?.() ?? Number.POSITIVE_INFINITY;
      const skills = skillEntries(remote.current.entries);
      const bytes = snapshotBytes(Object.fromEntries(skills));
      assert.equal(
        skills.length,
        2,
        `远端只能有自定义+override 两条，实际=${skills.length} keys=${skills.map(([key]) => key).join(",")} captureMs=${captureMs} captureEnsure=${captureEnsure} applyEnsure=${applyEnsure} bytes=${bytes}`,
      );
      const bodies = skills.map(([, entry]) => {
        try {
          return JSON.parse(decodePlain(entry)) as { path?: string; content?: string };
        } catch {
          return {};
        }
      });
      assert.ok(bodies.some((item) => item.path === "r19-user-custom.md"), "必须上传自定义 Skill");
      assert.ok(bodies.some((item) => item.path === builtin.path), "必须上传内置 override");
      assert.ok(captureEnsure <= 1, `capture 一批 ensure 最多一次，实际=${captureEnsure}`);
      assert.ok(applyEnsure <= 1, `flush/apply 一批 ensure 最多一次，实际=${applyEnsure}`);
    });
    storeA?.close();
    adapter.bindAccountProfileSync(null);
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());

    process.chdir(rootB);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identityB);
    await runWithUserStorage(identityB, async () => {
      const opened = openSync(rootB, remote);
      storeB = opened.store;
      adapter.bindAccountProfileSync(opened.sync);
      skillsApi.resetEnsureBuiltinSkillsCallCount?.();
      const applyStarted = Date.now();
      const applied = await opened.sync.reconcile("login");
      const applyMs = Date.now() - applyStarted;
      const ensureCalls = skillsApi.takeEnsureBuiltinSkillsCallCount?.() ?? Number.POSITIVE_INFINITY;
      assert.notEqual(applied.state, "failed", `B 对账不得失败，实际=${applied.state} ${opened.sync.status().failureReason ?? ""}`);
      assert.ok(applyMs < 15_000, `全量相关 apply 不得再出现约 69 秒阻塞，实际=${applyMs}ms ensure=${ensureCalls}`);
      assert.ok(ensureCalls <= 1, `apply 一批 ensure 最多一次，实际=${ensureCalls}`);

      const { skillsRoot } = await skillsApi.ensureCurrentAccountBuiltinSkills(getPath());
      const futureBuiltin = path.join(skillsRoot, "future-version-builtin.md");
      fs.writeFileSync(futureBuiltin, "# 新版本内置不得被旧快照 prune");

      const app = express();
      app.use(express.json());
      app.use((_req, _res, next) => {
        enterUserStorage(identityB);
        next();
      });
      app.use("/api/setting/skillManagement/getSkillContent", (await import("../../src/routes/setting/skillManagement/getSkillContent")).default);
      const { server, port } = await listen(app);
      try {
        const custom = await postJson(port, "/api/setting/skillManagement/getSkillContent", { path: "r19-user-custom.md" });
        assert.equal(custom.status, 200);
        assert.match(String((custom.json as { data?: string })?.data ?? ""), /B必须读到/);
        const overridden = await postJson(port, "/api/setting/skillManagement/getSkillContent", { path: builtin.path });
        assert.equal(overridden.status, 200);
        assert.match(String((overridden.json as { data?: string })?.data ?? ""), /B必须读到override/);
      } finally {
        await closeServer(server);
      }

      remote.current = { version: remote.current.version + 1, entries: structuredClone(remote.current.entries) };
      const second = await opened.sync.reconcile("login");
      assert.notEqual(second.state, "failed", `再次对账不得失败，实际=${second.state}`);
      assert.equal(
        fs.existsSync(futureBuiltin),
        true,
        "新版本增加的内置 Skill 不得因旧快照被 prune",
      );
    });
    storeB?.close();
    adapter.bindAccountProfileSync(null);
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());

    process.chdir(rootA);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identityA);
    await runWithUserStorage(identityA, async () => {
      const opened = openSync(rootA, remote);
      storeA = opened.store;
      adapter.bindAccountProfileSync(opened.sync);
      const { skillsRoot } = await skillsApi.ensureCurrentAccountBuiltinSkills(getPath());
      const customFile = path.join(skillsRoot, "r19-user-custom.md");
      if (fs.existsSync(customFile)) fs.unlinkSync(customFile);
      const resources = resolveBuiltinSkillsResources();
      const original = fs.readFileSync(path.join(resources.builtinRoot, ...builtin.path.split("/")));
      fs.writeFileSync(path.join(skillsRoot, ...builtin.path.split("/")), original);
      assert.equal(hashFileSha256(path.join(skillsRoot, ...builtin.path.split("/"))).toLowerCase(), builtin.sha256.toLowerCase());
      await adapter.notifyAccountSettingsMutated();
      await opened.sync.flush();
      const skills = skillEntries(remote.current.entries);
      assert.equal(
        skills.length,
        0,
        `删除自定义并移除 override 后远端不得再有 live skill.*，实际=${skills.map(([key, entry]) => {
          try {
            return JSON.parse(decodePlain(entry)).path;
          } catch {
            return key;
          }
        }).join(",")}`,
      );
    });
    storeA?.close();
    adapter.bindAccountProfileSync(null);
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());

    process.chdir(rootB);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identityB);
    await runWithUserStorage(identityB, async () => {
      const opened = openSync(rootB, remote);
      storeB = opened.store;
      adapter.bindAccountProfileSync(opened.sync);
      const applied = await opened.sync.reconcile("login");
      assert.notEqual(applied.state, "failed", `删除传播对账不得失败，实际=${applied.state}`);
      const { skillsRoot } = await skillsApi.ensureCurrentAccountBuiltinSkills(getPath());
      assert.equal(
        fs.existsSync(path.join(skillsRoot, "r19-user-custom.md")),
        false,
        "自定义 Skill 删除必须传播到 B",
      );
      const restored = path.join(skillsRoot, ...builtin.path.split("/"));
      assert.equal(fs.existsSync(restored), true, "移除 override 后必须保留内置基线文件");
      assert.equal(
        hashFileSha256(restored).toLowerCase(),
        builtin.sha256.toLowerCase(),
        "移除 override 后 B 必须恢复内置 SHA",
      );
    });
  } finally {
    adapter.bindAccountProfileSync(null);
    storeA?.close();
    storeB?.close();
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});
