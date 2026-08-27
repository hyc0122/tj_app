import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

import { resolveReleaseContext } from "../../scripts/resolve-release-context.mjs";

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
const workflowSource = fs.readFileSync(workflowPath, "utf8");
const workflow = parseYaml(workflowSource);

function stepText(job: Record<string, any>): string {
  return JSON.stringify(job.steps ?? []);
}

function matchesTagFilters(tag: string, filters: string[]): boolean {
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

test("根 package.json 是版本唯一来源且 App 镜像版本必须一致", () => {
  const rootPackage = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
  ) as { version: string; scripts: Record<string, string> };
  const appPackage = JSON.parse(
    fs.readFileSync(path.join(appRoot, "package.json"), "utf8"),
  ) as { version: string; scripts: Record<string, string> };

  assert.equal(appPackage.version, rootPackage.version);
  assert.match(
    rootPackage.version,
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/,
  );
  assert.equal(
    rootPackage.scripts["release:relay:oss"],
    "node --use-env-proxy app/scripts/release-relay-cli.mjs",
  );
  assert.equal(appPackage.scripts["installer:verify"], "node scripts/verify-installer-structure.mjs");
});

test("共享 resolver 区分 Stable 与 beta.N，并拒绝其他连字符版本", () => {
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

test("Stable 入口只接受无预发布后缀 Tag，并支持从根版本手动创建 Tag", () => {
  assert.deepEqual(workflow.on.push.tags, ["v*.*.*", "!v*-*"]);
  assert.equal(workflow.on.workflow_dispatch, null);
  const filters = workflow.on.push.tags as string[];
  assert.equal(matchesTagFilters("v1.1.11", filters), true);
  assert.equal(matchesTagFilters("v1.1.11-beta.1", filters), false);

  const jobs = workflow.jobs ?? {};
  assert.deepEqual(Object.keys(jobs).sort(), ["create-tag", "release-pipeline"]);
  const createTag = jobs["create-tag"];
  assert.equal(createTag["runs-on"], "ubuntu-latest");
  assert.deepEqual(createTag.permissions, { contents: "write" });
  assert.equal(createTag.outputs.tag, "${{ steps.release.outputs.tag }}");

  const text = stepText(createTag);
  assert.match(text, /require\('\.\/package\.json'\)\.version/);
  assert.match(text, /require\('\.\/app\/package\.json'\)\.version/);
  assert.match(text, /git rev-parse origin\/main/);
  assert.match(text, /git ls-remote --tags origin/);
  assert.match(text, /git tag -a/);
  assert.match(text, /git push origin/);
});

test("Stable 入口复用三平台云端流水线并创建 non-prerelease Release", () => {
  const pipeline = workflow.jobs["release-pipeline"];
  assert.deepEqual(pipeline.needs, ["create-tag"]);
  assert.equal(pipeline.uses, "./.github/workflows/app-cloud-release.yml");
  assert.equal(pipeline.with.channel, "stable");
  assert.equal(pipeline.with.prerelease, false);
  assert.match(pipeline.with.tag, /github\.ref_name/);
  assert.match(pipeline.with.tag, /needs\.create-tag\.outputs\.tag/);
  assert.equal(pipeline.secrets, "inherit");
  assert.match(pipeline.if, /github\.repository == 'hyc0122\/tj_app'/);
  assert.match(pipeline.if, /needs\.create-tag\.result == 'success'/);
});

test("Stable 入口没有旧 Windows-only、恢复工作流或 Actions 直传 OSS 通道", () => {
  assert.equal(
    fs.existsSync(path.join(repositoryRoot, ".github", "workflows", "app-stable-release-recovery.yml")),
    false,
  );
  assert.doesNotMatch(
    workflowSource,
    /publish-platform-release|publish-release-transaction|OSS_ACCESS_KEY|OSS_BUCKET|OSS_ENDPOINT|ossutil|ali-oss/i,
  );
  assert.doesNotMatch(workflowSource, /windows-x64|dist:win:x64/);

  // 入口使用的第三方 Action 必须固定到不可移动的提交 SHA。
  for (const job of Object.values(workflow.jobs ?? {}) as Array<Record<string, any>>) {
    for (const step of job.steps ?? []) {
      if (step.uses) assert.match(step.uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    }
  }
});

test("本地 OSS relay 保留禁止构建、重新签名与重新打包的硬性防线", () => {
  const relayContract = fs.readFileSync(
    path.join(appRoot, "scripts", "release-relay-contract.mjs"),
    "utf8",
  );
  assert.match(relayContract, /electron-builder/);
  assert.match(relayContract, /yarn\(\?:\\\.cmd\)\?\\s\+\(\?:build\|dist\|pack\)/);
  assert.match(relayContract, /重新签名|重新打包|本地构建/);
});
