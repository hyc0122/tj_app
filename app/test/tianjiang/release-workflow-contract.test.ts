import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

// 以当前测试文件为锚点，避免测试结果依赖调用命令时的当前目录。
const require = createRequire(__filename);
const { load: parseYaml } = require("js-yaml") as {
  load: (source: string) => Record<string, any>;
};

const appRoot = path.resolve(__dirname, "../..");
const repositoryRoot = path.resolve(appRoot, "..");

function readWorkflow(fileName: string) {
  const filePath = path.join(repositoryRoot, ".github", "workflows", fileName);
  const source = fs.readFileSync(filePath, "utf8");
  return { source, workflow: parseYaml(source) };
}

function stepText(job: Record<string, any>): string {
  return JSON.stringify(job.steps ?? []);
}

function assertPinnedActions(jobs: Record<string, any>): void {
  for (const [jobName, job] of Object.entries(jobs)) {
    for (const step of job.steps ?? []) {
      if (!step.uses) continue;
      assert.match(
        step.uses,
        /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/,
        `${jobName}/${step.name ?? step.uses} 必须固定到 40 位 Commit SHA`,
      );
    }
  }
}

const betaEntry = readWorkflow("app-release.yml");
const cloudPipeline = readWorkflow("app-cloud-release.yml");

test("Beta 入口只负责从根 package.json 创建不可移动 Tag 并调用统一云端发布", () => {
  const jobs = betaEntry.workflow.jobs ?? {};
  assert.deepEqual(Object.keys(jobs).sort(), ["create-tag", "release-pipeline"]);

  const createTag = jobs["create-tag"];
  assert.equal(createTag["runs-on"], "ubuntu-latest");
  assert.deepEqual(createTag.permissions, { contents: "write" });
  assert.equal(createTag.outputs.tag, "${{ steps.release.outputs.tag }}");

  const createTagText = stepText(createTag);
  assert.match(createTagText, /require\('\.\/package\.json'\)\.version/);
  assert.match(createTagText, /require\('\.\/app\/package\.json'\)\.version/);
  assert.match(createTagText, /-beta/);
  assert.match(createTagText, /git rev-parse origin\/main/);
  assert.match(createTagText, /git ls-remote --tags origin/);
  assert.match(createTagText, /git tag -a/);
  assert.match(createTagText, /git push origin/);

  const pipeline = jobs["release-pipeline"];
  assert.deepEqual(pipeline.needs, ["create-tag"]);
  assert.equal(pipeline.uses, "./.github/workflows/app-cloud-release.yml");
  assert.equal(pipeline.with.channel, "beta");
  assert.equal(pipeline.with.prerelease, true);
  assert.match(pipeline.with.tag, /github\.ref_name/);
  assert.match(pipeline.with.tag, /needs\.create-tag\.outputs\.tag/);
  assert.equal(pipeline.secrets, "inherit");
});

test("统一云端工作流只包含质量门、三平台构建、来源证明和 GitHub Release", () => {
  const jobs = cloudPipeline.workflow.jobs ?? {};
  assert.deepEqual(
    Object.keys(jobs).sort(),
    ["build-linux", "build-macos", "build-windows", "provenance", "quality", "release"],
  );

  // App 全量包含 Windows 路径、Junction 与 cmd.exe 验收，质量门必须运行在官方 Windows Runner。
  assert.equal(jobs.quality["runs-on"], "windows-latest");
  assert.equal(jobs["build-windows"]["runs-on"], "windows-latest");
  assert.equal(jobs["build-linux"]["runs-on"], "ubuntu-latest");
  assert.equal(jobs["build-macos"]["runs-on"], "macos-latest");
  assert.deepEqual(jobs.provenance.needs, ["build-windows", "build-linux", "build-macos"]);
  assert.deepEqual(jobs.release.needs, ["provenance"]);

  assert.deepEqual(jobs.quality.permissions, { contents: "read" });
  assert.deepEqual(jobs["build-windows"].permissions, { contents: "read" });
  assert.deepEqual(jobs["build-linux"].permissions, { contents: "read" });
  assert.deepEqual(jobs["build-macos"].permissions, { contents: "read" });
  assert.deepEqual(jobs.provenance.permissions, { contents: "read", "id-token": "write" });
  assert.deepEqual(jobs.release.permissions, { contents: "write" });
  assertPinnedActions(jobs);
});

test("质量门使用冻结依赖和项目标准测试、检查与构建命令", () => {
  const qualityText = stepText(cloudPipeline.workflow.jobs.quality);
  assert.match(qualityText, /yarn install --frozen-lockfile --non-interactive/);
  assert.match(qualityText, /yarn native:node && yarn native:verify:node/);
  // 干净 Runner 没有被 Git 忽略的 build/main.js，必须先用标准 build 生成再运行全量测试。
  assert.match(qualityText, /yarn build && yarn test:tianjiang && yarn lint/);
  assert.match(qualityText, /yarn test:tianjiang-ui && yarn type-check && yarn build/);
  assert.match(qualityText, /require\('\.\.\/package\.json'\)\.version/);
  assert.match(qualityText, /git rev-list -n 1/);
});

test("三个正式构建 Job 各自冻结安装并上传原样 Actions Artifact", () => {
  const jobs = cloudPipeline.workflow.jobs;
  const expected = [
    ["build-windows", "yarn dist:win:x64", "/desktop/${{ inputs.channel }}/windows/x64"],
    ["build-linux", "yarn dist:linux:x64", "/desktop/${{ inputs.channel }}/linux/x64"],
    ["build-macos", "yarn dist:mac:${{ steps.platform.outputs.arch }}", "/desktop/${{ inputs.channel }}/macos/"],
  ] as const;

  for (const [jobId, buildCommand, feedPath] of expected) {
    const text = stepText(jobs[jobId]);
    assert.match(text, /yarn install --frozen-lockfile --non-interactive/);
    assert.ok(text.includes(buildCommand));
    assert.ok(text.includes(feedPath));
    assert.match(text, /actions\/upload-artifact/);
    assert.match(text, /prepareReleaseTarget/);
  }
});

test("Windows 与 macOS 签名只在云端凭据齐全时启用并执行平台验证", () => {
  const windowsText = stepText(cloudPipeline.workflow.jobs["build-windows"]);
  const macosText = stepText(cloudPipeline.workflow.jobs["build-macos"]);

  assert.match(windowsText, /WINDOWS_CSC_LINK/);
  assert.match(windowsText, /WINDOWS_CSC_KEY_PASSWORD/);
  assert.match(windowsText, /Get-AuthenticodeSignature/);
  assert.match(windowsText, /Status.*Valid/);

  assert.match(macosText, /MACOS_CSC_LINK/);
  assert.match(macosText, /APPLE_APP_SPECIFIC_PASSWORD/);
  assert.match(macosText, /codesign --verify --deep --strict/);
  assert.match(macosText, /xcrun stapler validate/);
});

test("Actions 只创建 GitHub Release，OSS 发布明确留给本地 relay", () => {
  const combinedSource = `${betaEntry.source}\n${cloudPipeline.source}`;
  assert.doesNotMatch(
    combinedSource,
    /OSS_ACCESS_KEY|OSS_BUCKET|OSS_ENDPOINT|publish-platform-release|ali-oss|ossutil|\bscp\b/i,
  );

  const provenanceText = stepText(cloudPipeline.workflow.jobs.provenance);
  const releaseText = stepText(cloudPipeline.workflow.jobs.release);
  assert.match(provenanceText, /cosign sign-blob/);
  assert.match(provenanceText, /cosign verify-blob/);
  assert.match(provenanceText, /release-manifest\.json\.sigstore\.json/);
  assert.match(releaseText, /softprops\/action-gh-release/);
  assert.match(releaseText, /release-assets\/\*/);
  assert.match(releaseText, /OSS 发布由本地 release:relay:oss/);
});

test("Sigstore 只信任实际执行签名的复用工作流身份", () => {
  const provenanceText = stepText(cloudPipeline.workflow.jobs.provenance);
  assert.match(
    provenanceText,
    /https:\/\/github\.com\/\$\{GITHUB_REPOSITORY\}\/\.github\/workflows\/app-cloud-release\.yml@\$\{GITHUB_REF\}/,
  );
  assert.doesNotMatch(provenanceText, /https:\/\/github\.com\/\$\{GITHUB_WORKFLOW_REF\}/);
});

test("微软 VC++ 运行库仍保留 Authenticode 校验门", () => {
  const runtimePreparation = fs.readFileSync(
    path.join(appRoot, "scripts", "prepare-vc-runtime.mjs"),
    "utf8",
  );
  assert.match(runtimePreparation, /Get-AuthenticodeSignature/);
  assert.match(runtimePreparation, /Microsoft Corporation/);
});
