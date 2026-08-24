import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

import { resolveReleaseContext } from "../../scripts/resolve-release-context.mjs";
// @ts-expect-error 平台发布准备入口保持原生 ESM，由工作流和测试共用。
import { createCosignKeylessSigner, preparePlatformReleasePublication } from "../../scripts/prepare-platform-release-publication.mjs";
// @ts-expect-error 平台发布 CLI 保持原生 ESM，由工作流和测试共用。
import { runPlatformReleaseCli } from "../../scripts/publish-platform-release-cli.mjs";

const require = createRequire(__filename);
const { load: parseYaml } = require("js-yaml") as {
  load: (source: string) => Record<string, any>;
};
const { minimatch } = require("minimatch") as {
  minimatch: (value: string, pattern: string) => boolean;
};

const appRoot = path.resolve(__dirname, "../..");
const repositoryRoot = path.resolve(appRoot, "..");
const workflowPath = path.join(repositoryRoot, ".github", "workflows", "app-stable-release.yml");
const fixtureParent = path.resolve(process.cwd(), "..", ".tmp", "stable-workflow-contract");

function readWorkflow() {
  return parseYaml(fs.readFileSync(workflowPath, "utf8"));
}

function allSteps(workflow: Record<string, any>) {
  return Object.values(workflow.jobs ?? {}).flatMap((job: any) => job.steps ?? []);
}

function matchesTagFilters(tag: string, filters: string[]) {
  let included = false;
  for (const filter of filters) {
    if (filter.startsWith("!")) {
      if (minimatch(tag, filter.slice(1))) included = false;
    } else if (minimatch(tag, filter)) {
      included = true;
    }
  }
  return included;
}

test("共享 resolver 区分正式版与 beta.N，并拒绝其他连字符版本", () => {
  assert.deepEqual(resolveReleaseContext("tag", "v1.1.11", "1.1.11"), {
    version: "1.1.11",
    tag: "v1.1.11",
    channel: "stable",
    prerelease: false,
  });
  assert.deepEqual(resolveReleaseContext("tag", "v1.1.11-beta.1", "1.1.11-beta.1"), {
    version: "1.1.11-beta.1",
    tag: "v1.1.11-beta.1",
    channel: "beta",
    prerelease: true,
  });
  for (const value of ["1.1.11-rc.1", "1.1.11-hotfix"]) {
    assert.throws(
      () => resolveReleaseContext("tag", `v${value}`, value),
      /正式|Stable|Tag|版本/,
      value,
    );
  }
});

test("Stable workflow 解析后只含 Windows x64、固定工具链与全局单写者并发门", () => {
  const workflow = readWorkflow();
  assert.deepEqual(workflow.on, { push: { tags: ["v*.*.*", "!v*-*"] } });
  const tagFilters = workflow.on.push.tags;
  assert.equal(matchesTagFilters("v1.1.11", tagFilters), true);
  for (const tag of ["v1.1.11-beta.1", "v1-rc.1.11", "v1.1-rc.11"]) {
    assert.equal(matchesTagFilters(tag, tagFilters), false, tag);
  }
  // GitHub glob 会匹配额外点段，最终仍由共享 resolver 的严格 X.Y.Z 规则失败关闭。
  assert.equal(matchesTagFilters("v1.1.11.1", tagFilters), true);
  assert.throws(
    () => resolveReleaseContext("tag", "v1.1.11.1", "1.1.11.1"),
    /只允许正式版或 beta\.N Tag/,
  );
  assert.deepEqual(workflow.env, { NODE_VERSION: "24.13.1", YARN_VERSION: "1.22.22" });
  assert.deepEqual(workflow.concurrency, {
    group: "tianjiang-desktop-release",
    "cancel-in-progress": false,
  });
  assert.deepEqual(Object.keys(workflow.jobs).sort(), ["build", "provenance", "publish"]);

  const source = fs.readFileSync(workflowPath, "utf8");
  assert.match(source, /windows-x64/);
  assert.doesNotMatch(source, /macos|linux/);
  assert.match(source, /https:\/\/api\.j11\.com\.cn\/desktop\/stable\/windows\/x64/);
  assert.match(source, /yarn install --frozen-lockfile --non-interactive/);

  for (const step of allSteps(workflow).filter((entry: any) => entry.uses)) {
    assert.match(step.uses, /^[^@]+@[0-9a-f]{40}$/);
  }
});

test("Stable workflow 在打包内置联合测试完成前必须保持 Node ABI", () => {
  const workflow = readWorkflow();
  const steps = workflow.jobs.build.steps;
  const packageIndex = steps.findIndex(
    (step: any) => step.name === "构建未签名 Windows x64",
  );
  assert.ok(packageIndex > 0, "缺少 Windows x64 正式打包步骤");

  // 打包入口会先运行 Web 到 App 的 Node 联合测试，因此此处必须保持 ABI 137。
  const beforePackage = steps
    .slice(0, packageIndex)
    .map((step: any) => String(step.run ?? ""))
    .join("\n");
  assert.match(beforePackage, /yarn native:node/);
  assert.match(beforePackage, /yarn native:verify:node/);
  assert.doesNotMatch(beforePackage, /native:electron/);
  assert.equal(steps[packageIndex].run, "yarn dist:win:x64");
});

test("Stable workflow 复用真实 Sigstore keyless signer 后才准备兼容树并验证 Beta 证明", () => {
  const workflow = readWorkflow();
  const steps = workflow.jobs.provenance.steps;
  const stableSign = steps.findIndex((step: any) => step.name === "签署 Stable ReleaseManifest 来源证明");
  const stableVerify = steps.findIndex((step: any) => step.name === "验证 Stable ReleaseManifest 来源证明");
  const prepare = steps.findIndex((step: any) => step.name === "准备 Stable 与 Beta 兼容 publication root");
  const betaVerify = steps.findIndex((step: any) => step.name === "验证 Beta 兼容 ReleaseManifest 来源证明");

  assert.ok(stableSign >= 0 && stableSign < stableVerify && stableVerify < prepare && prepare < betaVerify);
  assert.match(steps[stableSign].run, /cosign sign-blob --yes/);
  assert.match(steps[stableVerify].run, /cosign verify-blob/);
  assert.match(steps[prepare].run, /preparePlatformReleasePublication/);
  assert.match(steps[prepare].run, /createCosignKeylessSigner/);
  const signerSource = fs.readFileSync(
    path.join(appRoot, "scripts", "prepare-platform-release-publication.mjs"),
    "utf8",
  );
  assert.match(signerSource, /execFileSync\(cosignExecutable/);
  assert.match(signerSource, /"sign-blob"[\s\S]*"--yes"[\s\S]*"--bundle"/);
  assert.match(steps[betaVerify].run, /cosign verify-blob/);
  assert.match(steps[betaVerify].run, /app-stable-release\.yml@refs\/tags\/\$\{GITHUB_REF_NAME\}/);
});

test("Stable 发布入口只运行 Task 2 平台 CLI，成功后紧邻创建 non-prerelease Release", () => {
  const workflow = readWorkflow();
  const steps = workflow.jobs.publish.steps;
  const publishIndex = steps.findIndex((step: any) => step.run?.includes("publish-platform-release-cli.mjs"));
  const releaseIndex = steps.findIndex((step: any) => step.uses?.startsWith("softprops/action-gh-release@"));
  assert.equal(releaseIndex, publishIndex + 1);
  assert.equal(steps[publishIndex].env.TIANJIANG_RELEASE_SINGLE_WRITER, "github-actions:${{ github.repository }}:${{ github.run_id }}:stable:windows-x64");
  assert.equal(steps[releaseIndex].with.prerelease, false);
  assert.equal(steps[releaseIndex].with.draft, false);
  assert.doesNotMatch(JSON.stringify(workflow), /desktop\/beta\/catalog\/latest\.json/);
});

test("离线无真实 signer 时 prepare 失败关闭，publish CLI 对空受控 fixture 不触碰远端", async () => {
  fs.mkdirSync(fixtureParent, { recursive: true });
  const root = fs.mkdtempSync(path.join(fixtureParent, "fail-closed-"));
  const targetRoot = path.join(root, "target");
  const destinationRoot = path.join(root, "publication");
  fs.mkdirSync(targetRoot);
  try {
    assert.throws(() => preparePlatformReleasePublication({
      targetRoot,
      manifestPath: path.join(root, "missing-manifest.json"),
      sha256SumsPath: path.join(root, "missing-SHA256SUMS"),
      sigstoreBundlePath: path.join(root, "missing.sigstore.json"),
      destinationRoot,
      channel: "stable",
      sourceChannel: "stable",
      version: "1.1.11",
    }), /缺失|signer|来源证明/);
    assert.equal(fs.existsSync(destinationRoot), false);

    const signerRoot = path.join(root, "signer");
    const signer = createCosignKeylessSigner({
      cosignExecutable: path.join(root, "missing-cosign.exe"),
      temporaryRoot: signerRoot,
    });
    assert.throws(
      () => signer(Buffer.from("controlled-beta-manifest\n", "utf8")),
      /Cosign signer|来源证明/,
    );
    assert.deepEqual(fs.readdirSync(signerRoot), []);

    const remoteEvents: string[] = [];
    const recordRemoteCall = async (name: string) => { remoteEvents.push(name); };
    await assert.rejects(() => runPlatformReleaseCli({
      argv: [targetRoot, "1.1.11"],
      environment: {},
      // 显式列出远端能力，避免 Proxy 意外伪造 then 导致 Promise 被误判为 thenable。
      createRemote: async () => ({
        assertImmutableUploadMode: () => recordRemoteCall("assertImmutableUploadMode"),
        readObject: () => recordRemoteCall("readObject"),
        readMutable: () => recordRemoteCall("readMutable"),
        putImmutable: () => recordRemoteCall("putImmutable"),
        putAtomic: () => recordRemoteCall("putAtomic"),
        readPublicObject: () => recordRemoteCall("readPublicObject"),
        readPublicRange: () => recordRemoteCall("readPublicRange"),
      }),
    }), /发布|目录|对象|缺失/);
    assert.deepEqual(remoteEvents, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
