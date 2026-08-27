import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import u from "../../src/utils";
import Ai from "../../src/utils/ai";
import {
  accountDatabase,
  activateUserDatabase,
  initializeWorkspaceProject,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { configureModelMediaResolver } from "../../src/tianjiang/media/model-media-reference";
import { projectDirectory } from "../../src/tianjiang/data/paths";
import {
  currentUserStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import { closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";
import getPath from "../../src/utils/getPath";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9732 };
const PROJECT_UUID = "32323232-3232-4232-a232-323232323232";

function vendorSource(id: string, topLevel = "", imageRequestBody = 'return "result";'): string {
  return `
${topLevel}
const vendor = {
  id: ${JSON.stringify(id)}, version: "2.0", name: "preflight", author: "test",
  mediaCapabilities: { image: "url", audio: "none", video: "none" }, inputs: [], inputValues: {},
  models: [{ name: "model", modelName: "model", type: "image", mode: ["text", "singleImage"] }]
};
async function imageRequest() { ${imageRequestBody} }
exports.vendor = vendor;
exports.imageRequest = imageRequest;
export {};
`;
}

test("真实 vendor 预备阶段必须阻断 VM 顶层网络并延后媒体 staging", async () => {
  const root = path.resolve(process.cwd(), "..", ".local", "t", `vendor-real-preflight-${process.pid}-${crypto.randomUUID()}`);
  const previousCwd = process.cwd();
  const previousNodeEnv = process.env.NODE_ENV;
  const serverApp = express();
  let networkCalls = 0;
  serverApp.use((_req, res) => {
    networkCalls += 1;
    res.status(204).end();
  });
  const server = await new Promise<http.Server>((resolve) => {
    const created = serverApp.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  resetDatabaseRuntimeForServe();
  await activateUserDatabase(IDENTITY);
  try {
    await runWithUserStorage(IDENTITY, async () => {
      await initializeWorkspaceProject(PROJECT_UUID, {
        id: 9732,
        name: "真实供应商预检",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      const context = currentUserStorage();
      assert.ok(context);
      const projectRoot = projectDirectory(getPath(), PROJECT_UUID, context.segment);
      const mediaIdentity = (fileName: string) => {
        const relativePath = `files/images/${fileName}`;
        const content = Buffer.from(`preflight:${fileName}`, "utf8");
        const absolutePath = path.join(projectRoot, ...relativePath.split("/"));
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, content);
        return {
          projectUuid: PROJECT_UUID,
          relativePath,
          md5: crypto.createHash("md5").update(content).digest("hex"),
          size: content.length,
        };
      };
      const referenceMedia = mediaIdentity("reference.png");
      const batchMedia = new Map([
        ["first.png", mediaIdentity("first.png")],
        ["second.png", mediaIdentity("second.png")],
      ]);
      const networkVendor = "preflightnetwork";
      u.vendor.writeCode(
        networkVendor,
        vendorSource(networkVendor, `fetch("http://127.0.0.1:${port}/top-level").catch(() => {});`),
      );
      await accountDatabase()("o_vendorConfig").insert({
        id: networkVendor,
        inputValues: "{}",
        models: "[]",
        enable: 1,
      });
      let topLevelRejected = false;
      try {
        await Ai.Image(`${networkVendor}:model`).prepare({
          prompt: "本地预检",
          referenceList: [],
          size: "1K",
          aspectRatio: "1:1",
        });
      } catch {
        topLevelRejected = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 80));

      const formDataVendor = "preflightformdata";
      u.vendor.writeCode(
        formDataVendor,
        vendorSource(formDataVendor, `
const topLevelForm = new FormData();
topLevelForm.append("probe", "blocked");
topLevelForm.submit("http://127.0.0.1:${port}/form-data", () => {});
`),
      );
      await accountDatabase()("o_vendorConfig").insert({
        id: formDataVendor,
        inputValues: "{}",
        models: "[]",
        enable: 1,
      });
      let formDataTopLevelRejected = false;
      try {
        await Ai.Image(`${formDataVendor}:model`).prepare({
          prompt: "FormData 禁网预检",
          referenceList: [],
          size: "1K",
          aspectRatio: "1:1",
        });
      } catch {
        formDataTopLevelRejected = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
      const formDataNetworkCalls = networkCalls;

      const stagingVendor = "preflightstaging";
      u.vendor.writeCode(stagingVendor, vendorSource(stagingVendor));
      await accountDatabase()("o_vendorConfig").insert({
        id: stagingVendor,
        inputValues: "{}",
        models: "[]",
        enable: 1,
      });
      let stagingCalls = 0;
      configureModelMediaResolver({
        stageLocalPath: async () => {
          stagingCalls += 1;
          return "https://signed.example/staged.png";
        },
      });
      const prepared = await Ai.Image(`${stagingVendor}:model`).prepare({
        prompt: "媒体预检",
        referenceList: [{
          type: "image",
          media: referenceMedia,
        }],
        size: "1K",
        aspectRatio: "1:1",
      });
      const stagingCallsAfterPrepare = stagingCalls;
      const stage = (prepared as unknown as { stage?: () => Promise<{ execute?: unknown }> }).stage;
      let hasExecuteAfterStage = false;
      if (stage) {
        const staged = await stage();
        hasExecuteAfterStage = typeof staged.execute === "function";
      }
      assert.deepEqual({
        topLevelRejected,
        formDataTopLevelRejected,
        formDataNetworkCalls,
        networkCalls,
        stagingCallsAfterPrepare,
        stagingCalls,
        hasStage: typeof stage === "function",
        hasExecuteAfterStage,
      }, {
        topLevelRejected: true,
        formDataTopLevelRejected: true,
        formDataNetworkCalls: 0,
        networkCalls: 0,
        stagingCallsAfterPrepare: 0,
        stagingCalls: 1,
        hasStage: true,
        hasExecuteAfterStage: true,
      });

      // 中文注释：真实两项 staging 中第二项失败时，已通过本地预检的第一项也不得执行 vendor 函数。
      networkCalls = 0;
      const batchVendor = "preflightbatch";
      u.vendor.writeCode(
        batchVendor,
        vendorSource(
          batchVendor,
          "",
          `await fetch("http://127.0.0.1:${port}/paid-provider"); return "result";`,
        ),
      );
      await accountDatabase()("o_vendorConfig").insert({
        id: batchVendor,
        inputValues: "{}",
        models: "[]",
        enable: 1,
      });
      let batchStagingCalls = 0;
      configureModelMediaResolver({
        stageLocalPath: async (reference) => {
          batchStagingCalls += 1;
          if (reference.relativePath?.endsWith("second.png")) {
            throw new Error("staging sk-secret C:\\private\\second.png");
          }
          return "https://signed.example/first.png";
        },
      });
      const batchPrepared = await Promise.all(["first.png", "second.png"].map((fileName) =>
        Ai.Image(`${batchVendor}:model`).prepare({
          prompt: "批次预检",
          referenceList: [{
            type: "image",
            media: batchMedia.get(fileName)!,
          }],
          size: "1K",
          aspectRatio: "1:1",
        })));
      const staged = await Promise.allSettled(batchPrepared.map((item) => item.stage()));
      assert.deepEqual({
        stagingStates: staged.map((item) => item.status),
        batchStagingCalls,
        providerFunctionNetworkCalls: networkCalls,
      }, {
        stagingStates: ["fulfilled", "rejected"],
        batchStagingCalls: 2,
        providerFunctionNetworkCalls: 0,
      });
    });
  } finally {
    configureModelMediaResolver(undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runWithUserStorage(IDENTITY, () => closeActivatedWorkspaceRuntime());
    process.chdir(previousCwd);
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows 句柄延迟释放时只保留当前 worktree 的 .local/t。
    }
  }
});
