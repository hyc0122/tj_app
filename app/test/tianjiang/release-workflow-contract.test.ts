import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

// 以当前测试文件为锚点，同时兼容 CommonJS tsc 与现有 tsx 执行方式。
const require = createRequire(__filename);
const { load: parseYaml } = require("js-yaml") as {
  load: (source: string) => Record<string, any>;
};

// 所有合同文件都从源码位置确定性解析，不依赖调用命令时的当前目录。
const appRoot = path.resolve(__dirname, "../..");
const repositoryRoot = path.resolve(appRoot, "..");
const workflowPath = path.join(repositoryRoot, ".github", "workflows", "app-release.yml");
const workflowSource = fs.readFileSync(workflowPath, "utf8");
const workflow = parseYaml(workflowSource);
const forbiddenCscPattern = new RegExp([
  ["WINDOWS", "CSC"].join("_"),
  ["CSC", "LINK"].join("_"),
  ["CSC", "KEY", "PASSWORD"].join("_"),
].join("|"));

const expectedMatrix = [
  {
    id: "windows-x64", platform: "windows", processPlatform: "win32",
    builderPlatform: "win", arch: "x64", runner: "windows-2025",
    metadataFile: "latest.yml", releaseMetadataFile: "latest-windows-x64.yml",
    binaryExtensions: [".exe"],
    feedUrl: "https://api.j11.com.cn/desktop/beta/windows/x64",
  },
  {
    id: "macos-x64", platform: "macos", processPlatform: "darwin",
    builderPlatform: "mac", arch: "x64", runner: "macos-15-intel",
    metadataFile: "latest-mac.yml", releaseMetadataFile: "latest-mac-x64.yml",
    binaryExtensions: [".dmg", ".zip"],
    feedUrl: "https://api.j11.com.cn/desktop/beta/macos/x64",
  },
  {
    id: "macos-arm64", platform: "macos", processPlatform: "darwin",
    builderPlatform: "mac", arch: "arm64", runner: "macos-15",
    metadataFile: "latest-mac.yml", releaseMetadataFile: "latest-mac-arm64.yml",
    binaryExtensions: [".dmg", ".zip"],
    feedUrl: "https://api.j11.com.cn/desktop/beta/macos/arm64",
  },
  {
    id: "linux-x64", platform: "linux", processPlatform: "linux",
    builderPlatform: "linux", arch: "x64", runner: "ubuntu-24.04",
    metadataFile: "latest-linux.yml", releaseMetadataFile: "latest-linux-x64.yml",
    binaryExtensions: [".AppImage"],
    feedUrl: "https://api.j11.com.cn/desktop/beta/linux/x64",
  },
  {
    id: "linux-arm64", platform: "linux", processPlatform: "linux",
    builderPlatform: "linux", arch: "arm64", runner: "ubuntu-24.04-arm",
    metadataFile: "latest-linux.yml", releaseMetadataFile: "latest-linux-arm64.yml",
    binaryExtensions: [".AppImage"],
    feedUrl: "https://api.j11.com.cn/desktop/beta/linux/arm64",
  },
] as const;

const allowedActions = new Set([
  "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
  "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
  "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
  "sigstore/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6",
  "softprops/action-gh-release@3bb12739c298aeb8a4eeaf626c5b8d85266b0e65",
]);

test("Beta workflow 只展开 Task 1 五目标和三个固定 Job", () => {
  assert.deepEqual(Object.keys(workflow.jobs).sort(), ["build", "provenance", "publish"]);
  assert.deepEqual(workflow.jobs.build.strategy.matrix.include, expectedMatrix);
  assert.equal(workflow.jobs.build.strategy["fail-fast"], false);
  assert.equal(workflow.jobs.build["runs-on"], "${{ matrix.runner }}");
});

test("五目标公开 Beta feed 只由原生打包 step 按 matrix 注入", () => {
  const feedEnvironmentName = "TIANJIANG_UPDATE_FEED_URL";
  const buildStep = workflow.jobs.build.steps.find(
    (step: any) => step.name === "构建未签名矩阵目标",
  );

  // 独立确认注入入口，防止 matrix 正确但打包命令未消费。
  assert.equal(buildStep.env[feedEnvironmentName], "${{ matrix.feedUrl }}");
  assert.equal(workflow.env?.[feedEnvironmentName], undefined);
  assert.equal(workflow.jobs.build.env?.[feedEnvironmentName], undefined);
  assert.equal(workflow.jobs.provenance.env?.[feedEnvironmentName], undefined);
  assert.equal(workflow.jobs.publish.env?.[feedEnvironmentName], undefined);
});

test("五目标共用的矩阵打包 step 固定 4096 MiB V8 heap", () => {
  const nodeOptionsEnvironmentName = "NODE_OPTIONS";
  const buildStep = workflow.jobs.build.steps.find(
    (step: any) => step.name === "构建未签名矩阵目标",
  );

  // 同一个 build step 会被五行 matrix 逐一展开，确保所有目标获得同一显式上限。
  assert.equal(workflow.jobs.build.strategy.matrix.include.length, 5);
  assert.equal(buildStep.env[nodeOptionsEnvironmentName], "--max-old-space-size=4096");
});

test("V8 heap 上限只进入矩阵打包 step，不跨入来源证明或发布事务", () => {
  const nodeOptionsEnvironmentName = "NODE_OPTIONS";
  const buildStep = workflow.jobs.build.steps.find(
    (step: any) => step.name === "构建未签名矩阵目标",
  );

  assert.equal(workflow.env?.[nodeOptionsEnvironmentName], undefined);
  for (const job of Object.values(workflow.jobs) as any[]) {
    assert.equal(job.env?.[nodeOptionsEnvironmentName], undefined);
    for (const step of job.steps) {
      if (step !== buildStep) assert.equal(step.env?.[nodeOptionsEnvironmentName], undefined);
    }
  }
});

test("三个 Job 权限最小化且 Action 全部命中固定 SHA allowlist", () => {
  assert.deepEqual(workflow.jobs.build.permissions, { contents: "read" });
  assert.deepEqual(workflow.jobs.provenance.permissions, {
    contents: "read",
    "id-token": "write",
  });
  assert.deepEqual(workflow.jobs.publish.permissions, { contents: "write" });

  const steps = Object.values(workflow.jobs)
    .flatMap((job: any) => job.steps)
    .filter((step: any) => step.uses);
  for (const step of steps) assert.ok(allowedActions.has(step.uses), step.uses);

  // 两个上传根都位于 .local，必须显式允许固定 Action 收集隐藏目录内容。
  const buildUpload = workflow.jobs.build.steps.find(
    (step: any) => step.name === "上传唯一目标目录",
  );
  const provenanceUpload = workflow.jobs.provenance.steps.find(
    (step: any) => step.name === "上传完整 publication root",
  );
  assert.equal(buildUpload.with["include-hidden-files"], true);
  assert.equal(provenanceUpload.with["include-hidden-files"], true);
});

test("Sigstore 先签后验且只证明 Manifest 来源", () => {
  const steps = workflow.jobs.provenance.steps;
  const signIndex = steps.findIndex((step: any) => step.run?.includes("cosign sign-blob"));
  const verifyIndex = steps.findIndex((step: any) => step.run?.includes("cosign verify-blob"));
  const prepareIndex = steps.findIndex((step: any) => step.run?.includes("prepare-release-publication.mjs"));
  assert.ok(signIndex >= 0 && signIndex < verifyIndex && verifyIndex < prepareIndex);
  assert.match(steps[verifyIndex].run, /--certificate-oidc-issuer https:\/\/token\.actions\.githubusercontent\.com/);
  assert.match(steps[verifyIndex].run, /app-release\.yml@refs\/tags\/\$\{GITHUB_REF_NAME\}/);
});

test("OSS Beta 事务成功后紧邻创建 GitHub prerelease", () => {
  const steps = workflow.jobs.publish.steps;
  const publishIndex = steps.findIndex((step: any) => step.run?.includes("publish-release-transaction.mjs"));
  const releaseIndex = steps.findIndex((step: any) => step.uses?.startsWith("softprops/action-gh-release@"));
  assert.equal(releaseIndex, publishIndex + 1);
  assert.equal(steps[publishIndex].env.TIANJIANG_RELEASE_SINGLE_WRITER.endsWith(":beta"), true);
  assert.equal(steps[releaseIndex].with.prerelease, true);
  assert.equal(steps[releaseIndex].with.files, "app/.local/release-publication/github-release/*");
});

test("Beta workflow 与 Stable 共用全局单写者并发门且保持五目标 prerelease", () => {
  assert.deepEqual(workflow.concurrency, {
    group: "tianjiang-desktop-release",
    "cancel-in-progress": false,
  });
  assert.equal(workflow.jobs.build.strategy.matrix.include.length, 5);
  const releaseStep = workflow.jobs.publish.steps.find(
    (step: any) => step.uses?.startsWith("softprops/action-gh-release@"),
  );
  assert.equal(releaseStep.with.prerelease, true);
});

test("Beta workflow 通过仓库 prepare/publish 入口推进每目标平台 Catalog", () => {
  const prepareStep = workflow.jobs.provenance.steps.find(
    (step: any) => step.run?.includes("prepare-release-publication.mjs"),
  );
  const publishStep = workflow.jobs.publish.steps.find(
    (step: any) => step.run?.includes("publish-release-transaction.mjs"),
  );
  assert.ok(prepareStep);
  assert.ok(publishStep);
  assert.equal(workflow.jobs.build.strategy.matrix.include.length, 5);
  assert.match(prepareStep.run, /prepare-release-publication\.mjs/);
  assert.match(publishStep.run, /publish-release-transaction\.mjs/);
});

test("产品保持未签名但微软 VC++ 运行库 Authenticode 门保留", () => {
  const builder = fs.readFileSync(path.join(appRoot, "electron-builder.yml"), "utf8");
  const runtimePreparation = fs.readFileSync(
    path.join(appRoot, "scripts", "prepare-vc-runtime.mjs"),
    "utf8",
  );
  assert.match(builder, /forceCodeSigning:\s*false/);
  assert.match(builder, /identity:\s*null/);
  assert.doesNotMatch(workflowSource, forbiddenCscPattern);
  assert.match(runtimePreparation, /Get-AuthenticodeSignature/);
  assert.match(runtimePreparation, /Microsoft Corporation/);
});
