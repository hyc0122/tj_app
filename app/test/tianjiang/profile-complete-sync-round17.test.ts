/**
 * Round17 RED：注册表全量双向同步、删除传播、Memory 原键、Skill/提示词正文。即梦本机设置不得同步。
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
  accountDatabase,
  destroyAllDatabaseHandles,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import getPath from "../../src/utils/getPath";
import { closeActivatedWorkspaceRuntime, createUniqueWorktreeRoot } from "./helpers/worktree-runtime";

const userUUID = "123e4567-e89b-42d3-a456-426614174071";
const identityA = { issuer: "https://api.j11.com.cn", userId: 1701 };
const identityB = { issuer: "https://api.j11.com.cn", userId: 1702 };
const sharedDataKey = crypto.randomBytes(32);

const MEMORY_KEYS = [
  "messagesPerSummary",
  "shortTermLimit",
  "summaryMaxLength",
  "summaryLimit",
  "ragLimit",
  "deepRetrieveSummaryLimit",
  "modelOnnxFile",
  "modelDtype",
  "agentUseMode",
] as const;

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

function decodePlain(entry: { value: string } | undefined): string {
  return (entry?.value ?? "").replace(/^plain:/, "");
}

test("A 设备完整设置必须按原键上传，B 设备真实 API/文件读到相同值", async () => {
  const rootA = createUniqueWorktreeRoot("r17-complete-a");
  const rootB = createUniqueWorktreeRoot("r17-complete-b");
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
    app.use("/api/setting/memoryConfig/sureMemory", (await import("../../src/routes/setting/memoryConfig/sureMemory")).default);
    app.use("/api/setting/agentDeploy/updateAgentModel", (await import("../../src/routes/setting/agentDeploy/updateAgentModel")).default);
    app.use("/api/setting/agentDeploy/updateUseMode", (await import("../../src/routes/setting/agentDeploy/updateUseMode")).default);
    app.use("/api/setting/skillManagement/saveSkillContent", (await import("../../src/routes/setting/skillManagement/saveSkillContent")).default);
    app.use("/api/setting/modelMap/savePrompt", (await import("../../src/routes/setting/modelMap/savePrompt")).default);
    app.use("/api/setting/modelMap/bindingPrompt", (await import("../../src/routes/setting/modelMap/bindingPrompt")).default);
    app.use("/api/setting/dreaminaCli/updateSettings", (await import("../../src/routes/setting/dreaminaCli/updateSettings")).default);
    const { server, port } = await listen(app);
    try {
      const memoryRes = await fetch(`http://127.0.0.1:${port}/api/setting/memoryConfig/sureMemory`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messagesPerSummary: 7,
          shortTermLimit: 11,
          summaryMaxLength: 222,
          summaryLimit: 3,
          ragLimit: 5,
          deepRetrieveSummaryLimit: 2,
          modelOnnxFile: ["alpha.onnx"],
          modelDtype: "fp16",
        }),
      });
      assert.equal(memoryRes.status, 200, `sureMemory 必须成功，实际=${memoryRes.status}`);
      const useModeRes = await fetch(`http://127.0.0.1:${port}/api/setting/agentDeploy/updateUseMode`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentUseMode: "1" }),
      });
      assert.equal(useModeRes.status, 200);

      const agent = await accountDatabase()("o_agentDeploy").where({ key: "scriptAgent" }).first();
      assert.ok(agent?.id, "必须有 scriptAgent");
      const agentRes = await fetch(`http://127.0.0.1:${port}/api/setting/agentDeploy/updateAgentModel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: agent.id,
          name: "自定义剧本",
          desc: "第二设备必须看到的说明",
          model: "m1",
          modelName: "模型一",
          vendorId: "tianjiang",
          temperature: 0.2,
          maxOutputTokens: 1024,
        }),
      });
      assert.equal(agentRes.status, 200);

      const { ensureCurrentAccountBuiltinSkills } = await import("../../src/tianjiang/skills/account-skills");
      const { skillsRoot } = await ensureCurrentAccountBuiltinSkills(getPath());
      const sample = fs.readdirSync(skillsRoot, { recursive: true, encoding: "utf8" })
        .map(String)
        .find((entry) => entry.replace(/\\/g, "/").endsWith(".md"));
      assert.ok(sample, "账号 Skills 必须有可写 Markdown");
      const skillRel = String(sample).replace(/\\/g, "/");
      const skillRes = await fetch(`http://127.0.0.1:${port}/api/setting/skillManagement/saveSkillContent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: skillRel, content: "# 同步技能正文\n第二设备必须读到" }),
      });
      assert.equal(skillRes.status, 200, `saveSkillContent 必须成功，实际=${skillRes.status}`);

      const savePrompt = await fetch(`http://127.0.0.1:${port}/api/setting/modelMap/savePrompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "sync-video", data: "# 同步模型提示词\nB 生成链必须读取", type: "video" }),
      });
      assert.equal(savePrompt.status, 200);
      const bind = await fetch(`http://127.0.0.1:${port}/api/setting/modelMap/bindingPrompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          vendorId: "tianjiang",
          model: "sync-model",
          path: "video/sync-video.md",
          fileName: "sync-video.md",
        }),
      });
      assert.equal(bind.status, 200);

      const dreamina = await fetch(`http://127.0.0.1:${port}/api/setting/dreaminaCli/updateSettings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ preferredExecutionTarget: "wsl", maxConcurrency: 3 }),
      });
      assert.equal(dreamina.status, 200);

      await adapter.notifyAccountSettingsMutated();
      await syncA.flush();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const uploaded = remote.commits.at(-1) ?? {};
    for (const key of MEMORY_KEYS) {
      assert.ok(uploaded[key] || uploaded[`memory.${key}`], `Memory 原键必须上传：${key}，实际键=${Object.keys(uploaded).join(",")}`);
      const hashed = Object.keys(uploaded).filter((item) => item.startsWith("memory.") && item !== `memory.${key}`);
      assert.equal(
        hashed.some((item) => item === `memory.${key}` ? false : /memory\.[0-9a-f]{8,}/.test(item) && decodePlain(uploaded[item]).includes(key)),
        false,
      );
    }
    assert.ok(!Object.keys(uploaded).some((key) => /^memory\.[0-9a-f]{16}$/.test(key)), `Memory 不得使用哈希键：${Object.keys(uploaded).filter((k) => k.startsWith("memory.")).join(",")}`);
    assert.equal(decodePlain(uploaded.messagesPerSummary), "7");
    assert.equal(decodePlain(uploaded.shortTermLimit), "11");
    assert.equal(decodePlain(uploaded.modelDtype), "fp16");
    assert.equal(decodePlain(uploaded.modelOnnxFile), JSON.stringify(["alpha.onnx"]));
    assert.equal(decodePlain(uploaded.agentUseMode), "1");
    const agentEntry = Object.entries(uploaded).find(([key, entry]) => {
      if (!key.startsWith("agent.")) return false;
      try {
        return JSON.parse(decodePlain(entry)).key === "scriptAgent";
      } catch {
        return false;
      }
    });
    assert.ok(agentEntry, "Agent 必须上传");
    const agentPayload = JSON.parse(decodePlain(agentEntry[1]));
    assert.equal(agentPayload.name, "自定义剧本", `Agent name 必须同步，实际=${JSON.stringify(agentPayload)}`);
    assert.equal(agentPayload.desc, "第二设备必须看到的说明");
    const skillEntry = Object.entries(uploaded).find(([key, entry]) => {
      if (!key.startsWith("skill.")) return false;
      try {
        return /第二设备必须读到/.test(String(JSON.parse(decodePlain(entry)).content ?? ""));
      } catch {
        return false;
      }
    });
    assert.ok(skillEntry, `Skill 正文必须上传，实际键=${Object.keys(uploaded).filter((key) => key.startsWith("skill.")).join(",")}`);
    const skillPayload = JSON.parse(decodePlain(skillEntry[1]));
    assert.match(String(skillPayload.content ?? ""), /第二设备必须读到/);
    const modelEntry = Object.entries(uploaded).find(([key, entry]) => {
      if (!key.startsWith("model.")) return false;
      try {
        const payload = JSON.parse(decodePlain(entry)) as { model?: string; content?: string };
        return payload.model === "sync-model" || /B 生成链必须读取/.test(String(payload.content ?? ""));
      } catch {
        return false;
      }
    });
    assert.ok(modelEntry, `模型映射必须上传，实际键=${Object.keys(uploaded).filter((key) => key.startsWith("model.")).join(",")}`);
    const modelPayload = JSON.parse(decodePlain(modelEntry[1]));
    assert.match(String(modelPayload.content ?? ""), /B 生成链必须读取/, `模型提示词正文必须进快照，实际=${JSON.stringify({
      keys: Object.keys(modelPayload),
      hasContent: Boolean(modelPayload.content),
    })}`);
    const leakedDreamina = Object.keys(uploaded).filter((key) => key.startsWith("dreamina."));
    assert.deepEqual(leakedDreamina, [], `即梦本机键不得上传，实际=${leakedDreamina.join(",")}`);
    storeA.close();
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());

    process.chdir(rootB);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identityB);
    enterUserStorage(identityB);
    const storeB = new ProfileStore(rootB, userUUID, new ProfileCrypto(userUUID, sharedDataKey));
    const syncB = new ProfileSync(storeB, remote, () => 0);
    adapter.bindAccountProfileSync(syncB);
    const downloaded = await syncB.login();
    void downloaded;
    const appB = express();
    appB.use(express.json());
    appB.use((_req, _res, next) => {
      enterUserStorage(identityB);
      next();
    });
    appB.use("/api/setting/memoryConfig/getMemory", (await import("../../src/routes/setting/memoryConfig/getMemory")).default);
    appB.use("/api/setting/agentDeploy/getAgentDeploy", (await import("../../src/routes/setting/agentDeploy/getAgentDeploy")).default);
    appB.use("/api/setting/agentDeploy/getAgentUseMode", (await import("../../src/routes/setting/agentDeploy/getAgentUseMode")).default);
    appB.use("/api/setting/dreaminaCli/getSettings", (await import("../../src/routes/setting/dreaminaCli/getSettings")).default);
    appB.use("/api/setting/modelMap/getPromptList", (await import("../../src/routes/setting/modelMap/getPromptList")).default);
    const listened = await listen(appB);
    try {
      const memory = await fetch(`http://127.0.0.1:${listened.port}/api/setting/memoryConfig/getMemory`);
      const memoryBody = await memory.json() as { data?: Record<string, unknown> };
      assert.equal(memoryBody.data?.messagesPerSummary, 7, `B Memory 原键必须相同，实际=${JSON.stringify(memoryBody.data)}`);
      assert.equal(memoryBody.data?.shortTermLimit, 11);
      assert.equal(memoryBody.data?.modelDtype, "fp16");
      assert.deepEqual(memoryBody.data?.modelOnnxFile, ["alpha.onnx"]);
      const useMode = await fetch(`http://127.0.0.1:${listened.port}/api/setting/agentDeploy/getAgentUseMode`);
      const useModeBody = await useMode.json() as { data?: string };
      assert.equal(String(useModeBody.data), "1");
      const agents = await fetch(`http://127.0.0.1:${listened.port}/api/setting/agentDeploy/getAgentDeploy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const agentBody = await agents.json() as { data?: { qrdinaryData?: Array<{ key?: string; name?: string; desc?: string }> } };
      const script = (agentBody.data?.qrdinaryData ?? []).find((item) => item.key === "scriptAgent");
      assert.equal(script?.name, "自定义剧本");
      assert.equal(script?.desc, "第二设备必须看到的说明");
      const dreamina = await fetch(`http://127.0.0.1:${listened.port}/api/setting/dreaminaCli/getSettings`);
      const dreaminaBody = await dreamina.json() as { data?: { preferredExecutionTarget?: string; maxConcurrency?: number } };
      assert.notEqual(
        dreaminaBody.data?.preferredExecutionTarget,
        "wsl",
        `B 不得被 A 的即梦执行目标覆盖，实际=${dreaminaBody.data?.preferredExecutionTarget}`,
      );
      assert.notEqual(
        dreaminaBody.data?.maxConcurrency,
        3,
        `B 不得被 A 的即梦并发数覆盖，实际=${dreaminaBody.data?.maxConcurrency}`,
      );

      const adapterApi = await import("../../src/tianjiang/sync/profile-settings-adapter");
      assert.equal(typeof adapterApi.readBoundModelPromptContent, "function", "生成链必须导出真实读入口");
      const promptText = await adapterApi.readBoundModelPromptContent!("tianjiang", "sync-model");
      assert.match(promptText ?? "", /B 生成链必须读取/, `生成链必须读到同步正文，实际=${promptText}`);
      const promptList = await fetch(`http://127.0.0.1:${listened.port}/api/setting/modelMap/getPromptList`);
      assert.equal(promptList.status, 200, `B getPromptList 必须成功，实际=${promptList.status}`);
      const promptListBody = await promptList.json() as { data?: Array<{ data?: string; path?: string }> };
      const listed = (promptListBody.data ?? []).find((item) => String(item.data ?? "").includes("B 生成链必须读取"));
      assert.ok(listed, `B 提示词列表必须读到同步正文，实际条数=${promptListBody.data?.length ?? 0}`);

      const { ensureCurrentAccountBuiltinSkills } = await import("../../src/tianjiang/skills/account-skills");
      const { skillsRoot } = await ensureCurrentAccountBuiltinSkills(getPath());
      const restoredSkill = fs.readdirSync(skillsRoot, { recursive: true, encoding: "utf8" })
        .map(String)
        .map((entry) => path.join(skillsRoot, entry))
        .find((full) => fs.existsSync(full) && fs.statSync(full).isFile() && fs.readFileSync(full, "utf8").includes("第二设备必须读到"));
      assert.ok(restoredSkill, "B 设备 Skills 目录必须恢复 Markdown 正文");
    } finally {
      await new Promise<void>((resolve) => listened.server.close(() => resolve()));
      storeB.close();
    }
  } finally {
    adapter.bindAccountProfileSync(null);
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});

test("A 删除 vendor/prompt/model/agent/skill 后 B 对账不得复活", async () => {
  const rootA = createUniqueWorktreeRoot("r17-delete-a");
  const rootB = createUniqueWorktreeRoot("r17-delete-b");
  const originalCwd = process.cwd();
  const remote = new MemoryRemote();
  process.env.NODE_ENV = "prod";
  const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
  try {
    process.chdir(rootA);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identityA);
    await runWithUserStorage(identityA, async () => {
      const storeA = new ProfileStore(rootA, userUUID, new ProfileCrypto(userUUID, sharedDataKey));
      const syncA = new ProfileSync(storeA, remote, () => 0);
      adapter.bindAccountProfileSync(syncA);
      await accountDatabase()("o_vendorConfig").insert({
        id: "custom-gone",
        inputValues: "{}",
        models: "[]",
        enable: 0,
      });
      await accountDatabase()("o_prompt").insert({
        id: 88001,
        name: "将被删除",
        type: "video",
        data: "old",
        useData: "old",
      });
      await accountDatabase()("o_modelPrompt").insert({
        vendorId: "tianjiang",
        model: "gone-model",
        path: "video/gone.md",
        fileName: "gone.md",
      });
      await accountDatabase()("o_agentDeploy").insert({
        id: 88901,
        key: "r17GoneAgent",
        name: "将被删除的Agent",
        desc: "gone",
        vendorId: "tianjiang",
        model: "gone",
        modelName: "gone",
        disabled: 0,
      });
      const { ensureCurrentAccountBuiltinSkills } = await import("../../src/tianjiang/skills/account-skills");
      const { skillsRoot } = await ensureCurrentAccountBuiltinSkills(getPath());
      fs.writeFileSync(path.join(skillsRoot, "r17-gone.md"), "# 将被删除的技能");
      await adapter.notifyAccountSettingsMutated();
      await syncA.flush();
      assert.ok(remote.current.entries["vendor.custom-gone"], "删除前必须已上传自定义供应商");
      assert.ok(remote.current.entries["prompt.88001"], "删除前必须已上传提示词");
      assert.ok(remote.current.entries["agent.r17GoneAgent"], "删除前必须已上传 Agent");
      const uploadedModel = Object.entries(remote.current.entries).find(([key, entry]) => {
        if (!key.startsWith("model.")) return false;
        try {
          return JSON.parse(decodePlain(entry)).model === "gone-model";
        } catch {
          return false;
        }
      });
      assert.ok(uploadedModel, "删除前必须已上传模型映射");
      const uploadedSkill = Object.entries(remote.current.entries).find(([key, entry]) => {
        if (!key.startsWith("skill.")) return false;
        try {
          const payload = JSON.parse(decodePlain(entry)) as { path?: string; content?: string };
          return payload.path === "r17-gone.md" || /将被删除的技能/.test(String(payload.content ?? ""));
        } catch {
          return false;
        }
      });
      assert.ok(uploadedSkill, "删除前必须已上传 Skill");
      const app = express();
      app.use(express.json());
      app.use((_req, _res, next) => {
        enterUserStorage(identityA);
        next();
      });
      app.use("/api/setting/vendorConfig/deleteVendor", (await import("../../src/routes/setting/vendorConfig/deleteVendor")).default);
      const { server, port } = await listen(app);
      try {
        const deleted = await fetch(`http://127.0.0.1:${port}/api/setting/vendorConfig/deleteVendor`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "custom-gone" }),
        });
        assert.equal(deleted.status, 200);
        await accountDatabase()("o_prompt").where({ id: 88001 }).del();
        await accountDatabase()("o_modelPrompt").where({ vendorId: "tianjiang", model: "gone-model" }).del();
        await accountDatabase()("o_agentDeploy").where({ key: "r17GoneAgent" }).del();
        const goneSkill = path.join(skillsRoot, "r17-gone.md");
        if (fs.existsSync(goneSkill)) fs.unlinkSync(goneSkill);
        await adapter.notifyAccountSettingsMutated();
        await syncA.flush();
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      assert.equal(
        remote.current.entries["vendor.custom-gone"],
        undefined,
        `删除后远端旧供应商必须消失，实际=${Object.keys(remote.current.entries).filter((k) => k.startsWith("vendor.")).join(",")}`,
      );
      assert.equal(remote.current.entries["prompt.88001"], undefined, "删除后远端旧提示词必须消失");
      assert.equal(remote.current.entries["agent.r17GoneAgent"], undefined, "删除后远端旧 Agent 必须消失");
      assert.equal(
        Object.entries(remote.current.entries).some(([key, entry]) => {
          if (!key.startsWith("model.")) return false;
          try {
            return JSON.parse(decodePlain(entry)).model === "gone-model";
          } catch {
            return false;
          }
        }),
        false,
        "删除后远端旧模型映射必须消失",
      );
      assert.equal(
        Object.entries(remote.current.entries).some(([key, entry]) => {
          if (!key.startsWith("skill.")) return false;
          try {
            const payload = JSON.parse(decodePlain(entry)) as { path?: string; content?: string };
            return payload.path === "r17-gone.md" || /将被删除的技能/.test(String(payload.content ?? ""));
          } catch {
            return false;
          }
        }),
        false,
        "删除后远端旧 Skill 必须消失",
      );
      storeA.close();
    });
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());

    process.chdir(rootB);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identityB);
    await runWithUserStorage(identityB, async () => {
      const storeB = new ProfileStore(rootB, userUUID, new ProfileCrypto(userUUID, sharedDataKey));
      const syncB = new ProfileSync(storeB, remote, () => 0);
      adapter.bindAccountProfileSync(syncB);
      await syncB.login();
      const vendor = await accountDatabase()("o_vendorConfig").where({ id: "custom-gone" }).first();
      assert.equal(vendor, undefined, "B 对账后已删供应商不得复活");
      const prompt = await accountDatabase()("o_prompt").where({ id: 88001 }).first();
      assert.equal(prompt, undefined, "B 对账后已删提示词不得复活");
      const model = await accountDatabase()("o_modelPrompt").where({ vendorId: "tianjiang", model: "gone-model" }).first();
      assert.equal(model, undefined, "B 对账后已删模型映射不得复活");
      const agent = await accountDatabase()("o_agentDeploy").where({ key: "r17GoneAgent" }).first();
      assert.equal(agent, undefined, "B 对账后已删 Agent 不得复活");
      const { ensureCurrentAccountBuiltinSkills } = await import("../../src/tianjiang/skills/account-skills");
      const { skillsRoot: skillsRootB } = await ensureCurrentAccountBuiltinSkills(getPath());
      const resurrected = fs.readdirSync(skillsRootB, { recursive: true, encoding: "utf8" })
        .map(String)
        .map((entry) => path.join(skillsRootB, entry))
        .some((full) => fs.existsSync(full) && fs.statSync(full).isFile() && fs.readFileSync(full, "utf8").includes("将被删除的技能"));
      assert.equal(resurrected, false, "B 对账后已删 Skill 不得复活");
      storeB.close();
    });
  } finally {
    adapter.bindAccountProfileSync(null);
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});
