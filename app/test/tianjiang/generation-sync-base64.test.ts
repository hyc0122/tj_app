/**
 * 同步 Ai.Image.run(taskRecord) 必须接受 Base64 产物，写入受管 staging，
 * 再走统一完成事务。禁止只直接调用 settleCompletedGenerationTask。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import u from "../../src/utils";
import Ai from "../../src/utils/ai";
import {
  accountDatabase,
  activateUserDatabase,
  destroyAllDatabaseHandles,
  initializeWorkspaceProject,
  pauseGenerationTaskRecovery,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { runWithProjectStorage, runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import { stringifyGenerationCompletionContract, createGenerationCompletionContract } from "../../src/tianjiang/tasks/generation-completion-contract";
import { toProjectLogicalPath } from "../../src/utils/oss";
import { MINIMAL_PNG } from "./helpers/minimal-png";
import { closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 8841 };
const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa41";
const PROJECT_ID = 8841;

function vendorSource(id: string, imageRequestBody: string): string {
  return `
const vendor = {
  id: ${JSON.stringify(id)}, version: "2.0", name: "sync-base64", author: "test",
  mediaCapabilities: { image: "url", audio: "none", video: "none" }, inputs: [], inputValues: {},
  models: [{ name: "model", modelName: "model", type: "image", mode: ["text", "singleImage"] }]
};
async function imageRequest() { ${imageRequestBody} }
exports.vendor = vendor;
exports.imageRequest = imageRequest;
export {};
`;
}

async function withAccount(run: () => Promise<void>): Promise<void> {
  const root = path.join(process.cwd(), "..", ".tmp", `b64-${process.pid}-${crypto.randomUUID().slice(0, 8)}`);
  const previousCwd = process.cwd();
  const previousNodeEnv = process.env.NODE_ENV;
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  resetDatabaseRuntimeForServe();
  await activateUserDatabase(IDENTITY);
  try {
    await runWithUserStorage(IDENTITY, async () => {
      await initializeWorkspaceProject(PROJECT, {
        id: PROJECT_ID,
        name: "sync-base64",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      await runWithProjectStorage(PROJECT, run);
    });
  } finally {
    await pauseGenerationTaskRecovery().catch(() => undefined);
    await runWithUserStorage(IDENTITY, () => closeActivatedWorkspaceRuntime()).catch(() => undefined);
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(previousCwd);
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

test("Ai.Image.run 带 taskRecord 时 Base64 必须进受管 staging 并完成统一事务", async () => {
  await withAccount(async () => {
    const vendorId = "syncbase64";
    const pngB64 = MINIMAL_PNG.toString("base64");
    u.vendor.writeCode(vendorId, vendorSource(vendorId, `return "data:image/png;base64,${pngB64}";`));
    await accountDatabase()("o_vendorConfig").insert({
      id: vendorId,
      inputValues: "{}",
      models: "[]",
      enable: 1,
    });
    const savePath = `${PROJECT_ID}/workFlow/sync-base64.png`;
    const [imageId] = await u.db("o_image").insert({
      type: "workflow",
      state: "生成中",
      model: "model",
      filePath: savePath,
    });
    await Ai.Image(`${vendorId}:model`).run(
      {
        prompt: "base64 staging",
        referenceList: [],
        size: "1K",
        aspectRatio: "1:1",
      },
      {
        taskClass: "工作流图片生成",
        describe: "工作流图片生成",
        relatedObjects: stringifyGenerationCompletionContract(createGenerationCompletionContract({
          kind: "workflow-image",
          mediaType: "image",
          relativePath: toProjectLogicalPath(savePath),
          imageId: Number(imageId),
          projectId: PROJECT_ID,
        })),
        projectId: PROJECT_ID,
      },
    );
    const task = await u.db("o_tasks").orderBy("id", "desc").first();
    const image = await u.db("o_image").where("id", imageId).first();
    assert.equal(task.state, "已完成");
    assert.equal(task.generationStatus, "completed");
    assert.equal(image.state, "已完成");
    const locator = task.resultLocator ? JSON.parse(String(task.resultLocator)) : {};
    assert.equal(locator.stagingPath, undefined, "完成后必须清除 stagingPath");
    assert.ok(String(image.filePath || "").length > 0);
  });
});

test("Ai.Image.run 在 locator 持久化后失败必须保持 pending_finalize，不得改写为 temporary_failure", async () => {
  await withAccount(async () => {
    const vendorId = "synclocator";
    u.vendor.writeCode(vendorId, vendorSource(vendorId, `return "https://cdn.example/result.png";`));
    await accountDatabase()("o_vendorConfig").insert({
      id: vendorId,
      inputValues: "{}",
      models: "[]",
      enable: 1,
    });
    const { setGenerationArtifactDownloaderForTests } = await import(
      "../../src/tianjiang/tasks/generation-artifact-downloader"
    );
    setGenerationArtifactDownloaderForTests({
      lookup: async () => {
        throw new Error("materialize-boom");
      },
    });
    try {
      const savePath = `${PROJECT_ID}/workFlow/locator-fail.png`;
      const [imageId] = await u.db("o_image").insert({
        type: "workflow",
        state: "生成中",
        model: "model",
        filePath: savePath,
      });
      await assert.rejects(() => Ai.Image(`${vendorId}:model`).run(
        {
          prompt: "locator then fail",
          referenceList: [],
          size: "1K",
          aspectRatio: "1:1",
        },
        {
          taskClass: "工作流图片生成",
          describe: "工作流图片生成",
          relatedObjects: stringifyGenerationCompletionContract(createGenerationCompletionContract({
            kind: "workflow-image",
            mediaType: "image",
            relativePath: toProjectLogicalPath(savePath),
            imageId: Number(imageId),
            projectId: PROJECT_ID,
          })),
          projectId: PROJECT_ID,
        },
      ));
      const task = await u.db("o_tasks").orderBy("id", "desc").first();
      assert.equal(task.state, "进行中");
      assert.equal(task.generationStatus, "pending_finalize");
      assert.notEqual(task.generationStatus, "temporary_failure");
      const locator = JSON.parse(String(task.resultLocator ?? "{}"));
      assert.equal(locator.remoteUrl, "https://cdn.example/result.png");
    } finally {
      setGenerationArtifactDownloaderForTests(null);
    }
  });
});
