/**
 * Round15 RED：真实设置 API 必须进入 ProfileSync，第二设备必须回写真实存储。
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
  accountDatabase,
  destroyAllDatabaseHandles,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { closeActivatedWorkspaceRuntime, createUniqueWorktreeRoot } from "./helpers/worktree-runtime";

const userUUID = "123e4567-e89b-42d3-a456-426614174015";
const identityA = { issuer: "https://api.j11.com.cn", userId: 1501 };
const identityB = { issuer: "https://api.j11.com.cn", userId: 1502 };

class MemoryProfileRemote implements ProfileRemote {
  current: ProfileSnapshot = { version: 1, entries: {} };
  getCurrentCalls = 0;
  getMetadataCalls = 0;
  commits: ProfileSnapshot["entries"][] = [];

  async getMetadata() {
    this.getMetadataCalls += 1;
    return { version: this.current.version, etag: `profile-v${this.current.version}` };
  }

  async getCurrent(): Promise<ProfileSnapshot> {
    this.getCurrentCalls += 1;
    return structuredClone(this.current);
  }

  async commit(_base: number, entries: ProfileSnapshot["entries"]): Promise<ProfileSnapshot> {
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

const sharedDataKey = crypto.randomBytes(32);

function openSync(root: string, remote: MemoryProfileRemote) {
  const store = new ProfileStore(root, userUUID, new ProfileCrypto(userUUID, sharedDataKey));
  const sync = new ProfileSync(store, remote, () => 0);
  return { store, sync };
}

test("真实设置 API 保存后必须上传登记键，第二设备必须读到一致值", async () => {
  const rootA = createUniqueWorktreeRoot("profile-live-a");
  const rootB = createUniqueWorktreeRoot("profile-live-b");
  const originalCwd = process.cwd();
  const remote = new MemoryProfileRemote();
  process.env.NODE_ENV = "prod";
  const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter").catch(() => null);

  try {
    process.chdir(rootA);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identityA);
    enterUserStorage(identityA);
    const { store, sync } = openSync(rootA, remote);
    adapter?.bindAccountProfileSync(sync);

    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) => {
      enterUserStorage(identityA);
      next();
    });
    const { default: updateVendorInputs } = await import("../../src/routes/setting/vendorConfig/updateVendorInputs");
    const { default: updatePrompt } = await import("../../src/routes/setting/promptManage/updatePrompt");
    const { default: getVendorList } = await import("../../src/routes/setting/vendorConfig/getVendorList");
    const putAppearance = await import("../../src/routes/setting/appearance/updateAppearance").catch(() => null);
    app.use("/api/setting/vendorConfig/updateVendorInputs", updateVendorInputs);
    app.use("/api/setting/promptManage/updatePrompt", updatePrompt);
    app.use("/api/setting/vendorConfig/getVendorList", getVendorList);
    if (putAppearance?.default) app.use("/api/setting/appearance/updateAppearance", putAppearance.default);
    const { server, port } = await listen(app);

    try {
      const db = accountDatabase();
      await db("o_vendorConfig").where("id", "tianjiang").update({
        inputValues: JSON.stringify({ apiKey: "sk-device-a" }),
      });
      const vendorRes = await fetch(`http://127.0.0.1:${port}/api/setting/vendorConfig/updateVendorInputs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "tianjiang", inputValues: { apiKey: "sk-device-a" } }),
      });
      assert.ok(vendorRes.status === 200 || vendorRes.status === 500, `供应商保存入口必须可达，实际=${vendorRes.status}`);

      const firstPrompt = await db("o_prompt").select("id").first();
      assert.ok(firstPrompt?.id, "账号库必须有提示词种子");
      await db("o_prompt").where("id", firstPrompt.id).update({ useData: "第二设备应看到的提示词" });

      for (const [key, value] of [
        ["theme", JSON.stringify({ mode: "dark", primaryColor: "#111111", fontSize: 16 })],
        ["language", "en"],
      ] as const) {
        const exists = await db("o_setting").where({ key }).first();
        if (exists) await db("o_setting").where({ key }).update({ value });
        else await db("o_setting").insert({ key, value });
      }
      const themeRes = await fetch(`http://127.0.0.1:${port}/api/setting/appearance/updateAppearance`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ theme: { mode: "dark", primaryColor: "#111111", fontSize: 16 }, language: "en" }),
      });
      assert.ok(
        themeRes.status === 200 || themeRes.status === 404,
        `外观入口必须明确存在或缺失，实际=${themeRes.status}`,
      );
      if (adapter?.notifyAccountSettingsMutated) {
        await adapter.notifyAccountSettingsMutated();
      }

      await sync.flush();
      const uploaded = remote.commits.at(-1) ?? {};
      assert.ok(uploaded["vendor.tianjiang"], "供应商设置必须进入 ProfileSync 快照");
      assert.equal(uploaded["vendor.tianjiang"]?.sensitive, true, "供应商必须按注册表加密上传");
      assert.match(uploaded["vendor.tianjiang"]?.value ?? "", /^tj-profile:v1:/);
      assert.ok(
        Object.keys(uploaded).some((key) => key.startsWith("prompt.")),
        "提示词必须进入 ProfileSync 快照",
      );
      assert.equal(uploaded.theme?.sensitive, false);
      assert.equal(uploaded.language?.sensitive, false);
      assert.equal(store.exportStoredSnapshot()["dreamina.device-code"], undefined);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    store.close();
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());

    process.chdir(rootB);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identityB);
    enterUserStorage(identityB);
    const storeB = new ProfileStore(rootB, userUUID, new ProfileCrypto(userUUID, sharedDataKey));
    const syncB = new ProfileSync(storeB, remote, () => 0);
    adapter?.bindAccountProfileSync(syncB);
    const downloaded = await syncB.reconcile("login");
    assert.notEqual(downloaded.state, "failed", "第二设备校准失败不得继续");
    assert.notEqual(syncB.status().state, "failed");

    const appB = express();
    appB.use(express.json());
    appB.use((_req, _res, next) => {
      enterUserStorage(identityB);
      next();
    });
    const { default: getVendorListB } = await import("../../src/routes/setting/vendorConfig/getVendorList");
    const { default: getPromptB } = await import("../../src/routes/setting/promptManage/getPrompt");
    const getAppearanceB = await import("../../src/routes/setting/appearance/getAppearance").catch(() => null);
    appB.use("/api/setting/vendorConfig/getVendorList", getVendorListB);
    appB.use("/api/setting/promptManage/getPrompt", getPromptB);
    if (getAppearanceB?.default) appB.use("/api/setting/appearance/getAppearance", getAppearanceB.default);
    const listened = await listen(appB);
    try {
      const vendors = await fetch(`http://127.0.0.1:${listened.port}/api/setting/vendorConfig/getVendorList`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const vendorBody = await vendors.json() as { data?: Array<{ id: string; inputValues?: string | Record<string, string> }> };
      const tianjiang = (vendorBody.data ?? []).find((item) => item.id === "tianjiang");
      const values = typeof tianjiang?.inputValues === "string"
        ? JSON.parse(tianjiang.inputValues)
        : tianjiang?.inputValues;
      assert.equal(values?.apiKey, "sk-device-a", "第二设备必须从真实设置 API 读到供应商密钥");

      const prompts = await fetch(`http://127.0.0.1:${listened.port}/api/setting/promptManage/getPrompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const promptBody = await prompts.json() as { data?: Array<{ useData?: string }> };
      assert.ok(
        (promptBody.data ?? []).some((item) => item.useData === "第二设备应看到的提示词"),
        "第二设备必须读到已同步提示词",
      );

      const appearance = await fetch(`http://127.0.0.1:${listened.port}/api/setting/appearance/getAppearance`);
      const appearBody = await appearance.json() as { data?: { language?: string; theme?: { mode?: string } } };
      assert.equal(appearBody.data?.language, "en");
      assert.equal(appearBody.data?.theme?.mode, "dark");
    } finally {
      await new Promise<void>((resolve) => listened.server.close(() => resolve()));
      storeB.close();
    }
  } finally {
    adapter?.bindAccountProfileSync(null);
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});
