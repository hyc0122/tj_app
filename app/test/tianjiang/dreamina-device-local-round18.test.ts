/**
 * Round18 RED：即梦是设备本地能力，全部设置不得进入账号 ProfileSync。
 * A/B 可使用不同执行目标、并发数；login 对账不得互相覆盖。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import test from "node:test";
import express from "express";

import { ProfileCrypto } from "../../src/tianjiang/crypto/profile-crypto";
import { ProfileStore } from "../../src/tianjiang/data/profile-store";
import {
  ProfileSync,
  type ProfileRemote,
  type ProfileSnapshot,
} from "../../src/tianjiang/sync/profile-sync";
import { enterUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import {
  activateUserDatabase,
  destroyAllDatabaseHandles,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { closeActivatedWorkspaceRuntime, createUniqueWorktreeRoot } from "./helpers/worktree-runtime";

const userUUID = "123e4567-e89b-42d3-a456-426614174181";
const identityA = { issuer: "https://api.j11.com.cn", userId: 1801 };
const identityB = { issuer: "https://api.j11.com.cn", userId: 1802 };
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

async function listen(app: express.Express) {
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

function dreaminaKeys(entries: ProfileSnapshot["entries"]): string[] {
  return Object.keys(entries).filter((key) => key.startsWith("dreamina.") || /preferred-execution-target|max-concurrency|device-code|executable/i.test(key));
}

test("即梦本机设置不得进入远端快照，B 的执行目标与并发数不得被 A 覆盖", async () => {
  const rootA = createUniqueWorktreeRoot("r18-dreamina-local-a");
  const rootB = createUniqueWorktreeRoot("r18-dreamina-local-b");
  const originalCwd = process.cwd();
  const remote = new MemoryRemote();
  process.env.NODE_ENV = "prod";
  const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
  try {
    process.chdir(rootA);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identityA);
    enterUserStorage(identityA);
    const storeA = new ProfileStore(rootA, userUUID, new ProfileCrypto(userUUID, sharedDataKey));
    const syncA = new ProfileSync(storeA, remote, () => 0);
    adapter.bindAccountProfileSync(syncA);

    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) => {
      enterUserStorage(identityA);
      next();
    });
    app.use("/api/setting/dreaminaCli/updateSettings", (await import("../../src/routes/setting/dreaminaCli/updateSettings")).default);
    app.use("/api/setting/dreaminaCli/getSettings", (await import("../../src/routes/setting/dreaminaCli/getSettings")).default);
    const { server, port } = await listen(app);
    try {
      const saved = await fetch(`http://127.0.0.1:${port}/api/setting/dreaminaCli/updateSettings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ preferredExecutionTarget: "wsl", maxConcurrency: 3 }),
      });
      assert.equal(saved.status, 200, `A 保存即梦本机设置必须成功，实际=${saved.status}`);
      const localA = await fetch(`http://127.0.0.1:${port}/api/setting/dreaminaCli/getSettings`);
      const localABody = await localA.json() as { data?: { preferredExecutionTarget?: string; maxConcurrency?: number } };
      assert.equal(localABody.data?.preferredExecutionTarget, "wsl");
      assert.equal(localABody.data?.maxConcurrency, 3);

      await adapter.notifyAccountSettingsMutated();
      await syncA.flush();
    } finally {
      await new Promise<void>((resolve) => {
        if (typeof server.closeAllConnections === "function") server.closeAllConnections();
        server.close(() => resolve());
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    const uploaded = remote.current.entries;
    const leaked = dreaminaKeys(uploaded);
    assert.deepEqual(leaked, [], `远端快照不得出现即梦本机键，实际=${leaked.join(",") || "无"} 全部键=${Object.keys(uploaded).join(",")}`);

    let registerError: unknown;
    try {
      syncA.setPersistent("dreamina.preferred-execution-target", "wsl", false);
    } catch (error) {
      registerError = error;
    }
    assert.match(
      registerError instanceof Error ? registerError.message : "",
      /PROFILE_SYNC_KEY_NOT_REGISTERED/,
      `执行目标不得再登记为可同步键，实际=${registerError instanceof Error ? registerError.message : registerError}`,
    );
    try {
      syncA.setPersistent("dreamina.max-concurrency", "3", false);
    } catch (error) {
      registerError = error;
    }
    assert.match(
      registerError instanceof Error ? registerError.message : "",
      /PROFILE_SYNC_KEY_NOT_REGISTERED/,
      `并发数不得再登记为可同步键，实际=${registerError instanceof Error ? registerError.message : registerError}`,
    );

    storeA.close();
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());

    process.chdir(rootB);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identityB);
    enterUserStorage(identityB);
    const storeB = new ProfileStore(rootB, userUUID, new ProfileCrypto(userUUID, sharedDataKey));
    const syncB = new ProfileSync(storeB, remote, () => 0);
    adapter.bindAccountProfileSync(syncB);

    const appB = express();
    appB.use(express.json());
    appB.use((_req, _res, next) => {
      enterUserStorage(identityB);
      next();
    });
    appB.use("/api/setting/dreaminaCli/updateSettings", (await import("../../src/routes/setting/dreaminaCli/updateSettings")).default);
    appB.use("/api/setting/dreaminaCli/getSettings", (await import("../../src/routes/setting/dreaminaCli/getSettings")).default);
    const listened = await listen(appB);
    try {
      const savedB = await fetch(`http://127.0.0.1:${listened.port}/api/setting/dreaminaCli/updateSettings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ preferredExecutionTarget: "windows_native", maxConcurrency: 1 }),
      });
      assert.equal(savedB.status, 200, `B 保存即梦本机设置必须成功，实际=${savedB.status}`);

      await syncB.login();

      const after = await fetch(`http://127.0.0.1:${listened.port}/api/setting/dreaminaCli/getSettings`);
      const afterBody = await after.json() as { data?: { preferredExecutionTarget?: string; maxConcurrency?: number; executablePath?: string | null } };
      assert.equal(
        afterBody.data?.preferredExecutionTarget,
        "windows_native",
        `B 对账后执行目标必须仍是本机值，实际=${afterBody.data?.preferredExecutionTarget}`,
      );
      assert.equal(
        afterBody.data?.maxConcurrency,
        1,
        `B 对账后并发数必须仍是本机值，实际=${afterBody.data?.maxConcurrency}`,
      );
    } finally {
      await new Promise<void>((resolve) => {
        if (typeof listened.server.closeAllConnections === "function") listened.server.closeAllConnections();
        listened.server.close(() => resolve());
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      storeB.close();
    }
  } finally {
    adapter.bindAccountProfileSync(null);
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});
