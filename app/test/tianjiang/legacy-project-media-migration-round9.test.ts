import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import {
  cleanupMigratedLegacyMediaAfterCentralSuccess,
  markLegacyCleanupReadyAfterCentralSuccess,
  migrateLegacyProjectMedia,
  SUPPORTED_MEDIA_COLUMNS,
} from "../../src/tianjiang/media/legacy-project-media-migration";
import { readLegacyMediaCleanupReceipt } from "../../src/tianjiang/media/legacy-media-cleanup-receipt";
import { projectDirectory } from "../../src/tianjiang/data/paths";

const projectUuid = "018f3d6e-2d9e-7b6c-8a9b-000000000096";
const userSegment = "c".repeat(32);
const legacyProjectId = 42;
const workspaceTempRoot = path.resolve(__dirname, "../../../.tmp");
fs.mkdirSync(workspaceTempRoot, { recursive: true });

function seedProject(dataRoot: string): {
  databasePath: string;
  accountOssRoot: string;
  imageRelative: string;
  videoRelative: string;
  audioRelative: string;
} {
  const projectRoot = projectDirectory(dataRoot, projectUuid, userSegment);
  fs.mkdirSync(path.join(projectRoot, "files"), { recursive: true });
  const databasePath = path.join(projectRoot, "project.sqlite");
  const accountOssRoot = path.join(dataRoot, "runtime-users", userSegment, "oss");
  fs.mkdirSync(path.join(accountOssRoot, String(legacyProjectId), "images"), { recursive: true });
  fs.mkdirSync(path.join(accountOssRoot, String(legacyProjectId), "videos"), { recursive: true });
  fs.mkdirSync(path.join(accountOssRoot, String(legacyProjectId), "audios"), { recursive: true });

  const imageRelative = `${legacyProjectId}/images/hero.png`;
  const videoRelative = `${legacyProjectId}/videos/shot.mp4`;
  const audioRelative = `${legacyProjectId}/audios/line.mp3`;
  fs.writeFileSync(path.join(accountOssRoot, ...imageRelative.split("/")), Buffer.from("img-bytes"));
  fs.writeFileSync(path.join(accountOssRoot, ...videoRelative.split("/")), Buffer.from("vid-bytes"));
  fs.writeFileSync(path.join(accountOssRoot, ...audioRelative.split("/")), Buffer.from("aud-bytes"));

  const db = new Database(databasePath);
  db.exec(`
    CREATE TABLE o_image (id INTEGER PRIMARY KEY, filePath TEXT);
    CREATE TABLE o_storyboard (id INTEGER PRIMARY KEY, filePath TEXT);
    CREATE TABLE o_video (id INTEGER PRIMARY KEY, filePath TEXT);
    CREATE TABLE o_assets (id INTEGER PRIMARY KEY, filePath TEXT);
    INSERT INTO o_image(id, filePath) VALUES (1, '${imageRelative}');
    INSERT INTO o_video(id, filePath) VALUES (1, '${videoRelative}');
    INSERT INTO o_assets(id, filePath) VALUES (1, '${audioRelative}');
  `);
  db.close();
  return { databasePath, accountOssRoot, imageRelative, videoRelative, audioRelative };
}

test("可写打开时复制校验并事务切换引用，中央成功前保留旧文件", () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-legacy-migrate-"));
  const seeded = seedProject(dataRoot);
  try {
    const result = migrateLegacyProjectMedia({
      dataRoot,
      userSegment,
      projectUuid,
      legacyProjectId,
      databasePath: seeded.databasePath,
      accountOssRoot: seeded.accountOssRoot,
      writable: true,
    });
    assert.equal(result.migrated, 3);
    const db = new Database(seeded.databasePath, { readonly: true });
    try {
      const image = db.prepare("SELECT filePath FROM o_image WHERE id = 1").get() as { filePath: string };
      assert.match(image.filePath, /^files\/legacy\//);
      assert.ok(fs.existsSync(path.join(projectDirectory(dataRoot, projectUuid, userSegment), ...image.filePath.split("/"))));
    } finally {
      db.close();
    }
    // 中央成功前旧文件仍在
    assert.ok(fs.existsSync(path.join(seeded.accountOssRoot, ...seeded.imageRelative.split("/"))));
    const receipt = readLegacyMediaCleanupReceipt(dataRoot, userSegment, projectUuid);
    assert.equal(receipt?.phase, "pending_central_success");
    assert.equal(receipt?.entries.length, 3);

    // 幂等
    const second = migrateLegacyProjectMedia({
      dataRoot,
      userSegment,
      projectUuid,
      legacyProjectId,
      databasePath: seeded.databasePath,
      accountOssRoot: seeded.accountOssRoot,
      writable: true,
    });
    assert.equal(second.alreadyMigrated, true);
    assert.equal(second.migrated, 0);

    markLegacyCleanupReadyAfterCentralSuccess({ dataRoot, userSegment, projectUuid });
    const cleaned = cleanupMigratedLegacyMediaAfterCentralSuccess({ dataRoot, userSegment, projectUuid });
    assert.equal(cleaned, 3);
    assert.equal(fs.existsSync(path.join(seeded.accountOssRoot, ...seeded.imageRelative.split("/"))), false);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("缺失源文件跳过该项，存在的媒体仍可迁移且不破坏原引用", () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-legacy-fail-"));
  const seeded = seedProject(dataRoot);
  try {
    // 删除视频源：该项跳过；图片/音频仍迁移
    fs.rmSync(path.join(seeded.accountOssRoot, ...seeded.videoRelative.split("/")), { force: true });
    const result = migrateLegacyProjectMedia({
      dataRoot,
      userSegment,
      projectUuid,
      legacyProjectId,
      databasePath: seeded.databasePath,
      accountOssRoot: seeded.accountOssRoot,
      writable: true,
    });
    assert.equal(result.migrated, 2);
    assert.ok(result.skipped >= 1);
    const db = new Database(seeded.databasePath, { readonly: true });
    try {
      const image = db.prepare("SELECT filePath FROM o_image WHERE id = 1").get() as { filePath: string };
      const video = db.prepare("SELECT filePath FROM o_video WHERE id = 1").get() as { filePath: string };
      assert.match(image.filePath, /^files\/legacy\//);
      assert.equal(video.filePath, seeded.videoRelative, "缺失源文件必须保留原引用");
    } finally {
      db.close();
    }
    assert.ok(fs.existsSync(path.join(seeded.accountOssRoot, ...seeded.imageRelative.split("/"))));
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("viewer/只读不得执行迁移", () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-legacy-ro-"));
  const seeded = seedProject(dataRoot);
  try {
    const result = migrateLegacyProjectMedia({
      dataRoot,
      userSegment,
      projectUuid,
      legacyProjectId,
      databasePath: seeded.databasePath,
      accountOssRoot: seeded.accountOssRoot,
      writable: false,
    });
    assert.equal(result.migrated, 0);
    const db = new Database(seeded.databasePath, { readonly: true });
    try {
      const image = db.prepare("SELECT filePath FROM o_image WHERE id = 1").get() as { filePath: string };
      assert.equal(image.filePath, seeded.imageRelative);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("SUPPORTED_MEDIA_COLUMNS 必须覆盖 schema 中全部媒体路径列", () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-legacy-schema-"));
  const seeded = seedProject(dataRoot);
  try {
    const db = new Database(seeded.databasePath);
    try {
      // 加入未登记列应使迁移失败
      db.exec("ALTER TABLE o_image ADD COLUMN coverPath TEXT");
      db.prepare("UPDATE o_image SET coverPath = ? WHERE id = 1").run(`${legacyProjectId}/images/cover.png`);
    } finally {
      db.close();
    }
    fs.writeFileSync(
      path.join(seeded.accountOssRoot, String(legacyProjectId), "images", "cover.png"),
      Buffer.from("cover"),
    );
    assert.throws(
      () => migrateLegacyProjectMedia({
        dataRoot,
        userSegment,
        projectUuid,
        legacyProjectId,
        databasePath: seeded.databasePath,
        accountOssRoot: seeded.accountOssRoot,
        writable: true,
      }),
      /未登记的媒体列/,
    );
    assert.ok(SUPPORTED_MEDIA_COLUMNS.some((item) => item.table === "o_image" && item.column === "filePath"));
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
