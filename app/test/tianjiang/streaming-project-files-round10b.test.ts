/**
 * Round10b RED：inventory / needsInstall / 安装校验对 files/** 禁止 readFileSync。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { projectDirectory } from "../../src/tianjiang/data/paths";
import { ProjectStore } from "../../src/tianjiang/data/project-store";
import { buildProjectFileInventory } from "../../src/tianjiang/media/project-file-inventory";
import { writeProjectFileAtomic } from "../../src/tianjiang/media/project-file-store";
import { RuntimeProjectLocal } from "../../src/tianjiang/runtime/project-runtime-local";

const projectUuid = "018f3d6e-2d9e-7b6c-8a9b-0000000001d1";
const userSegment = "d1".repeat(16);
const workspaceTempRoot = path.resolve(__dirname, "../../../.tmp");
fs.mkdirSync(workspaceTempRoot, { recursive: true });

function md5Of(bytes: Buffer): string {
  return crypto.createHash("md5").update(bytes).digest("hex");
}

test("files/** 清单构建不得对媒体使用 readFileSync；大文件仍可 inventory", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-r10b-stream-inv-"));
  const big = Buffer.alloc(256 * 1024, 3);
  writeProjectFileAtomic(dataRoot, projectUuid, userSegment, "files/videos/big.mp4", big);
  const root = projectDirectory(dataRoot, projectUuid, userSegment);

  const mediaReads: string[] = [];
  const original = fs.readFileSync;
  (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = ((
    target: fs.PathOrFileDescriptor,
    ...args: unknown[]
  ) => {
    const p = String(target);
    if (p.includes(`${path.sep}files${path.sep}`) || p.includes("/files/")) {
      mediaReads.push(p);
    }
    return (original as Function).apply(fs, [target, ...args]);
  }) as typeof fs.readFileSync;

  try {
    const inventory = buildProjectFileInventory(root);
    assert.ok(inventory.some((o) => o.relativePath === "files/videos/big.mp4"));
    assert.equal(
      inventory.find((o) => o.relativePath === "files/videos/big.mp4")!.md5,
      md5Of(big),
    );
    assert.equal(
      mediaReads.length,
      0,
      `files/** 不得 readFileSync，实际=${mediaReads.join(";")}`,
    );
  } finally {
    (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = original;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("needsInstall 流式校验 MD5；篡改后 true 且不得破坏旧项目", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-r10b-stream-ni-"));
  const store = new ProjectStore(dataRoot, projectUuid, "readwrite", userSegment);
  store.setRecord("runtime", "seed", { ok: true });
  store.close();
  const good = Buffer.from("stable-media");
  writeProjectFileAtomic(dataRoot, projectUuid, userSegment, "files/images/a.png", good);
  const root = projectDirectory(dataRoot, projectUuid, userSegment);
  const goodMd5 = md5Of(good);
  fs.writeFileSync(path.join(root, ".tianjiang-manifest.json"), JSON.stringify({
    version: 4,
    objects: [
      { relativePath: "project.sqlite", size: 1, md5: "a".repeat(32) },
      { relativePath: "files/images/a.png", size: good.length, md5: goodMd5 },
    ],
    installedDatabaseMD5: "a".repeat(32),
  }));

  const mediaReads: string[] = [];
  const original = fs.readFileSync;
  (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = ((
    target: fs.PathOrFileDescriptor,
    ...args: unknown[]
  ) => {
    const p = String(target);
    if (p.includes(`${path.sep}files${path.sep}`) || p.includes("/files/")) {
      mediaReads.push(p);
    }
    return (original as Function).apply(fs, [target, ...args]);
  }) as typeof fs.readFileSync;

  const local = new RuntimeProjectLocal(dataRoot, projectUuid, userSegment);
  try {
    fs.writeFileSync(path.join(root, "files", "images", "a.png"), Buffer.from("tampered!!"));
    const needs = local.needsInstall({
      version: 4,
      objects: [
        { relativePath: "project.sqlite", size: 1, md5: "a".repeat(32) },
        { relativePath: "files/images/a.png", size: good.length, md5: goodMd5 },
      ],
    });
    assert.equal(needs, true);
    assert.equal(mediaReads.length, 0, `needsInstall 不得 readFileSync 媒体: ${mediaReads}`);
    // 旧 sqlite 仍在
    assert.ok(fs.existsSync(path.join(root, "project.sqlite")));
  } finally {
    (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = original;
    local.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
