import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  resolvePackagedRuntimeResources,
} from "../../scripts/runtime-resources";

const appRoot = path.resolve(process.cwd());
const testTempRoot = path.join(appRoot, "..", ".tmp", "runtime-resources-tests");

interface WebFixtureFile {
  readonly relativePath: string;
  readonly content: string;
}

function sha256(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function createFixture(files: readonly WebFixtureFile[] = [
  {
    relativePath: "index.html",
    content: "<!doctype html><html><body>天将漫创<script src=\"./assets/app.js\"></script></body></html>",
  },
  {
    relativePath: "assets/app.js",
    content: "globalThis.__TIANJIANG_RUNTIME__ = 'fresh';",
  },
]) {
  fs.mkdirSync(testTempRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(testTempRoot, "case-"));
  const resourcesRoot = path.join(root, "resources");
  const packagedDataRoot = path.join(resourcesRoot, "data");
  const webRoot = path.join(packagedDataRoot, "web");
  const serveRoot = path.join(packagedDataRoot, "serve");
  const userDataRoot = path.join(root, "user-data", "data");
  fs.mkdirSync(webRoot, { recursive: true });
  fs.mkdirSync(serveRoot, { recursive: true });
  fs.mkdirSync(userDataRoot, { recursive: true });

  const sourceFiles = files.map((file) => {
    const target = path.join(webRoot, ...file.relativePath.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content, "utf8");
    return {
      path: file.relativePath,
      size: Buffer.byteLength(file.content),
      sha256: sha256(file.content),
    };
  });
  fs.writeFileSync(
    path.join(webRoot, ".tianjiang-web-package.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-07-31T00:00:00.000Z",
      generatedAtMs: 1785456000000,
      sourceRootName: "dist",
      sourceMaxMtimeMs: 1785455999000,
      sourceTreeSha256: "fixture-tree-hash",
      sourceFiles,
    }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(serveRoot, "app.js"), "module.exports = { default: async () => 10588 };", "utf8");

  return { root, resourcesRoot, packagedDataRoot, webRoot, userDataRoot };
}

function snapshotDirectory(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      if (entry.isDirectory()) visit(absolutePath);
      else snapshot[relativePath] = sha256(fs.readFileSync(absolutePath));
    }
  };
  visit(root);
  return snapshot;
}

test("同版本遗留 web 不得覆盖或替代包内已校验资源", () => {
  const fixture = createFixture();
  try {
    const staleWeb = path.join(fixture.userDataRoot, "web");
    fs.mkdirSync(staleWeb, { recursive: true });
    fs.writeFileSync(
      path.join(staleWeb, "index.html"),
      "<p>请以管理员运行，并手工安装 VC++，选择32位下载或64位下载</p>",
      "utf8",
    );
    fs.writeFileSync(path.join(fixture.userDataRoot, "version.txt"), "1.1.9\n", "utf8");

    const resolved = resolvePackagedRuntimeResources(fixture.resourcesRoot);

    assert.equal(resolved.webRoot, fixture.webRoot);
    assert.equal(resolved.webEntry, path.join(fixture.webRoot, "index.html"));
    assert.equal(resolved.serveEntry, path.join(fixture.packagedDataRoot, "serve", "app.js"));
    assert.match(fs.readFileSync(resolved.webEntry, "utf8"), /天将漫创/);
    assert.doesNotMatch(fs.readFileSync(resolved.webEntry, "utf8"), /管理员|VC\+\+|32位|64位/);
    assert.match(fs.readFileSync(path.join(staleWeb, "index.html"), "utf8"), /管理员运行/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("解析包内资源前后所有用户数据哨兵必须逐字节保持不变", () => {
  const fixture = createFixture();
  try {
    const sentinels = [
      "assets/character.png",
      "models/custom.json",
      "skills/private.md",
      "oss/project/video.mp4",
      "db2.sqlite",
      "projects/project-1/story.json",
      "settings/preferences.json",
      "keys/provider-secret.txt",
    ];
    for (const relativePath of sentinels) {
      const target = path.join(fixture.userDataRoot, ...relativePath.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `用户数据哨兵:${relativePath}`, "utf8");
    }
    const before = snapshotDirectory(fixture.userDataRoot);

    resolvePackagedRuntimeResources(fixture.resourcesRoot);

    assert.deepEqual(snapshotDirectory(fixture.userDataRoot), before);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("资源校验中断必须失败关闭且不产生 staging、backup 或半成品", () => {
  const fixture = createFixture();
  try {
    const userSentinel = path.join(fixture.userDataRoot, "projects", "must-stay.txt");
    fs.mkdirSync(path.dirname(userSentinel), { recursive: true });
    fs.writeFileSync(userSentinel, "must-stay", "utf8");
    const beforeUser = snapshotDirectory(fixture.userDataRoot);
    const beforeResources = snapshotDirectory(fixture.resourcesRoot);
    fs.writeFileSync(path.join(fixture.webRoot, "assets", "app.js"), "interrupted-update", "utf8");

    assert.throws(
      () => resolvePackagedRuntimeResources(fixture.resourcesRoot),
      /SHA-256|摘要|资源/,
    );
    assert.deepEqual(snapshotDirectory(fixture.userDataRoot), beforeUser);
    assert.equal(fs.existsSync(path.join(fixture.userDataRoot, ".staging")), false);
    assert.equal(fs.existsSync(path.join(fixture.userDataRoot, ".backup")), false);
    assert.equal(
      Object.keys(snapshotDirectory(fixture.resourcesRoot)).length,
      Object.keys(beforeResources).length,
      "只读校验不得增删包内文件",
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("包内最终 web 即使摘要匹配也不得包含旧运行指引", () => {
  const fixture = createFixture([
    {
      relativePath: "index.html",
      content: "<!doctype html><html><body>天将漫创<script src=\"./assets/app.js\"></script></body></html>",
    },
    {
      relativePath: "assets/app.js",
      content: "const help = '请手工安装 VC++，然后选择64位下载';",
    },
  ]);
  try {
    assert.throws(
      () => resolvePackagedRuntimeResources(fixture.resourcesRoot),
      /误导|运行指引/,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
