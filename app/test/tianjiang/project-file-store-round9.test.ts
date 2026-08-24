import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { projectFilesDirectory } from "../../src/tianjiang/data/paths";
import { buildProjectFileInventory } from "../../src/tianjiang/media/project-file-inventory";
import {
  projectFileExists,
  readProjectFile,
  resolveProjectFilePath,
  writeProjectFileAtomic,
} from "../../src/tianjiang/media/project-file-store";

const projectUuid = "018f3d6e-2d9e-7b6c-8a9b-000000000093";
const userSegment = "b".repeat(32);
const workspaceTempRoot = path.resolve(__dirname, "../../../.tmp");
fs.mkdirSync(workspaceTempRoot, { recursive: true });

test("项目文件写入位于 files 根，拒绝 .. 绝对路径 盘符 UNC 与 NUL", () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-file-store-"));
  try {
    const written = writeProjectFileAtomic(
      dataRoot,
      projectUuid,
      userSegment,
      "files/images/character.png",
      Buffer.from("png-bytes"),
    );
    assert.equal(written.relativePath, "files/images/character.png");
    assert.equal(written.size, 9);
    assert.equal(written.md5, crypto.createHash("md5").update("png-bytes").digest("hex"));
    assert.equal(written.mediaType, "image");
    assert.ok(written.absolutePath.startsWith(projectFilesDirectory(dataRoot, projectUuid, userSegment)));
    assert.deepEqual(
      readProjectFile(dataRoot, projectUuid, userSegment, "files/images/character.png"),
      Buffer.from("png-bytes"),
    );
    assert.equal(projectFileExists(dataRoot, projectUuid, userSegment, "files/images/character.png"), true);

    assert.throws(() => resolveProjectFilePath(dataRoot, projectUuid, userSegment, "../escape.png"), /无效|越界/);
    assert.throws(() => resolveProjectFilePath(dataRoot, projectUuid, userSegment, "C:/windows/a.png"), /无效/);
    assert.throws(() => resolveProjectFilePath(dataRoot, projectUuid, userSegment, "//server/share/a.png"), /无效/);
    assert.throws(() => resolveProjectFilePath(dataRoot, projectUuid, userSegment, "files/images/NUL"), /无效/);
    assert.throws(() => resolveProjectFilePath(dataRoot, projectUuid, userSegment, "/abs/a.png"), /无效/);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("清单只收集普通文件，软链接 fail-closed", () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-file-inventory-"));
  try {
    writeProjectFileAtomic(
      dataRoot,
      projectUuid,
      userSegment,
      "files/videos/shot.mp4",
      Buffer.from("video"),
    );
    const projectRoot = path.dirname(projectFilesDirectory(dataRoot, projectUuid, userSegment));
    const inventory = buildProjectFileInventory(projectRoot);
    assert.equal(inventory.length, 1);
    assert.equal(inventory[0]!.relativePath, "files/videos/shot.mp4");
    assert.equal(inventory[0]!.mediaType, "video");

    const outside = path.join(dataRoot, "secret.bin");
    fs.writeFileSync(outside, "secret");
    const linkPath = path.join(projectFilesDirectory(dataRoot, projectUuid, userSegment), "images", "link.png");
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    try {
      fs.symlinkSync(outside, linkPath, "file");
    } catch {
      // 无创建符号链接权限时跳过该子场景
      return;
    }
    assert.throws(() => buildProjectFileInventory(projectRoot), /符号链接|重解析/);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("files 根自身为 junction 时必须在 realpath 前拒绝", () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-file-root-link-"));
  const outside = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-file-root-outside-"));
  const filesRoot = projectFilesDirectory(dataRoot, projectUuid, userSegment);
  try {
    fs.mkdirSync(path.dirname(filesRoot), { recursive: true });
    fs.mkdirSync(path.join(outside, "images"), { recursive: true });
    fs.writeFileSync(path.join(outside, "images", "secret.png"), "outside-secret");
    // 中文注释：根 junction 会被 realpath 抹去，必须在 canonicalize 前逐段 lstat。
    fs.symlinkSync(outside, filesRoot, "junction");
    assert.throws(
      () => resolveProjectFilePath(dataRoot, projectUuid, userSegment, "files/images/secret.png"),
      /符号链接|Junction|重解析/,
    );
  } finally {
    if (fs.existsSync(filesRoot) && fs.lstatSync(filesRoot).isSymbolicLink()) fs.unlinkSync(filesRoot);
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
