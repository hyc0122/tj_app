import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import { checksumBuffer, checksumFile } from "../../src/tianjiang/sync/checksum";
import { buildProjectManifest, diffManifest } from "../../src/tianjiang/sync/manifest";
import { createSQLiteSnapshot, validateSQLiteDatabase } from "../../src/tianjiang/sync/sqlite-snapshot";

test("SQLite Backup API 在并发写事务期间仍生成可一致打开的已提交快照", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tj-snapshot-"));
  const source = path.join(root, "project.sqlite");
  const target = path.join(root, "snapshot.sqlite");
  const writer = new Database(source);
  writer.exec("CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO records VALUES(1, 'committed'); PRAGMA user_version=1;");
  writer.exec("BEGIN IMMEDIATE; INSERT INTO records VALUES(2, 'uncommitted');");
  try {
    await createSQLiteSnapshot(source, target);
    const validation = validateSQLiteDatabase(target, 1);
    assert.equal(validation.integrity, "ok");
    const snapshot = new Database(target, { readonly: true });
    assert.equal((snapshot.prepare("SELECT COUNT(*) AS count FROM records").get() as { count: number }).count, 1);
    snapshot.close();
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("大文件摘要采用流式大小、MD5 和 CRC64，不依赖时间戳", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tj-checksum-"));
  const file = path.join(root, "large.bin");
  const content = Buffer.alloc(8 * 1024 * 1024, 0x5a);
  fs.writeFileSync(file, content);
  try {
    const result = await checksumFile(file, { crc64: true, highWaterMark: 64 * 1024 });
    assert.equal(result.size, content.length);
    assert.equal(result.md5, crypto.createHash("md5").update(content).digest("hex"));
    assert.match(result.crc64!, /^[0-9]+$/);
    const stat = fs.statSync(file);
    fs.writeFileSync(file, Buffer.alloc(content.length, 0x59));
    fs.utimesSync(file, stat.atime, stat.mtime);
    const changed = await checksumFile(file);
    assert.notEqual(changed.md5, result.md5);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("内存摘要使用阿里云 OSS CRC64-ECMA/XZ 标准向量", () => {
  const result = checksumBuffer(Buffer.from("123456789", "utf8"));
  assert.equal(result.crc64, "11051210869376104954");
});

test("流式文件摘要跨分块保持与 OSS CRC64-ECMA/XZ 一致", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tj-oss-crc64-"));
  const file = path.join(root, "vector.bin");
  fs.writeFileSync(file, "123456789", "utf8");
  try {
    const result = await checksumFile(file, { crc64: true, highWaterMark: 3 });
    assert.equal(result.crc64, "11051210869376104954");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("清单路径规范化、稳定排序并按内容跳过未变化对象", () => {
  const projectUUID = "018f3d6e-2d9e-7b6c-8a9b-1234567890aa";
  const manifest = buildProjectManifest({
    projectUUID, version: 2, baseVersion: 1, createdAt: "2026-07-29T12:00:00Z",
    database: { relativePath: "project.sqlite", size: 1, md5: "0cc175b9c0f1b6a831c399e269772661" },
    files: [
      { relativePath: "files/z.png", size: 2, md5: "92eb5ffee6ae2fec3ad71c777531578f", mediaType: "image" },
      { relativePath: "files/a.png", size: 3, md5: "4a8a08f09d37b73795649038408b5f33", mediaType: "image" },
    ],
  });
  assert.deepEqual(manifest.files.map((file) => file.relativePath), ["files/a.png", "files/z.png"]);
  assert.throws(() => buildProjectManifest({ ...manifest, files: [{ ...manifest.files[0], relativePath: "../escape" }] }), /清单路径无效/);
  assert.deepEqual(diffManifest(manifest, structuredClone(manifest)), []);
  const changed = structuredClone(manifest);
  changed.files[0].md5 = "8277e0910d750195b448797616e091ad";
  assert.deepEqual(diffManifest(manifest, changed), ["files/a.png"]);
});
