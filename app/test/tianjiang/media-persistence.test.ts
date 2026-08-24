import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import {
  assertNoImageBase64,
  assertSQLiteHasNoImageBase64,
  sanitizeMediaLog,
} from "../../src/tianjiang/media/media-safety";
import {
  configureModelMediaResolver,
  prepareModelMediaReferences,
  resolveModelMediaURL,
  type PersistedMediaReference,
} from "../../src/tianjiang/media/model-media-reference";
import { ProjectStore } from "../../src/tianjiang/data/project-store";

const md5 = "0cc175b9c0f1b6a831c399e269772661";

test("SQLite 和同步记录禁止图片 Base64，只允许相对路径、对象键、md5、size", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tj-media-db-"));
  const databasePath = path.join(root, "project.sqlite");
  const database = new Database(databasePath);
  database.exec("CREATE TABLE media(id INTEGER PRIMARY KEY, filePath TEXT, payload TEXT)");
  database.prepare("INSERT INTO media(filePath, payload) VALUES (?, ?)").run(
    "files/images/a.png",
    null,
  );
  database.close();
  assert.doesNotThrow(() => assertSQLiteHasNoImageBase64(databasePath));

  const unsafe = new Database(databasePath);
  unsafe.prepare("UPDATE media SET payload = ? WHERE id = 1").run(
    "data:image/png;base64,aGVsbG8=",
  );
  unsafe.close();
  assert.throws(() => assertSQLiteHasNoImageBase64(databasePath), /禁止持久化.*Base64/);
  assert.throws(
    () => assertNoImageBase64({ records: [{ image: "data:image/jpeg;base64,aGVsbG8=" }] }),
    /禁止包含.*Base64/,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("模型媒体只在请求时解析短签 URL，本地路径必须经过 Task2 staging adapter", async () => {
  const objectReference: PersistedMediaReference = {
    objectKey: "projects/p1/images/a.png",
    md5,
    size: 5,
  };
  const signed = await resolveModelMediaURL(objectReference, {
    signObject: async (objectKey, expires) =>
      `https://media.invalid/${objectKey}?expires=${expires}&signature=test`,
  }, { providerSupportsURL: true, expiresSeconds: 120 });
  assert.match(signed, /^https:\/\/media\.invalid\//);
  assert.doesNotMatch(JSON.stringify(objectReference), /base64/i);
  configureModelMediaResolver({
    signObject: async (objectKey, expires) =>
      `https://media.invalid/${objectKey}?expires=${expires}&signature=runtime`,
  });
  const transient = await prepareModelMediaReferences([
    { type: "image" as const, media: objectReference },
  ], true);
  assert.match(transient[0].base64, /^https:\/\/media\.invalid\//);
  assert.equal("media" in transient[0], false, "供应商瞬时参数不得继续携带持久引用对象");
  configureModelMediaResolver(undefined);

  const localReference: PersistedMediaReference = {
    projectUuid: "11111111-1111-4111-a111-111111111111",
    relativePath: "files/images/local.png",
    md5,
    size: 5,
  };
  await assert.rejects(
    () => resolveModelMediaURL(localReference, {}, { providerSupportsURL: true }),
    /Task2 staging adapter/,
  );
  const staged = await resolveModelMediaURL(localReference, {
    stageLocalPath: async (_reference, expires) =>
      `https://staging.invalid/temporary/local.png?expires=${expires}`,
  }, { providerSupportsURL: true });
  assert.match(staged, /^https:\/\/staging\.invalid\//);
  await assert.rejects(
    () => resolveModelMediaURL(objectReference, {}, { providerSupportsURL: false }),
    /不支持 URL 媒体输入/,
  );
});

test("日志递归掩码图片 Base64，不影响普通 URL 和状态字段", () => {
  const sanitized = sanitizeMediaLog({
    status: "completed",
    output: "data:image/webp;base64,aGVsbG8=",
    url: "https://media.invalid/a.webp",
    signedURL: "https://media.invalid/private/a.webp?expires=120&signature=secret",
  });
  const serialized = JSON.stringify(sanitized);
  assert.doesNotMatch(serialized, /aGVsbG8=/);
  assert.doesNotMatch(serialized, /signature=secret/);
  assert.match(serialized, /REDACTED_MEDIA_DATA/);
  assert.match(serialized, /REDACTED_SIGNED_QUERY/);
  assert.match(serialized, /https:\/\/media\.invalid/);
});

test("真实项目 SQLite 含图片 Base64 时禁止创建同步快照", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tj-media-project-"));
  const store = new ProjectStore(
    root,
    "11111111-1111-4111-a111-111111111111",
    "readwrite",
  );
  try {
    assert.throws(
      () => store.setRecord("runtime", "unsafe-image", {
        image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
      }),
      /禁止.*媒体 Base64/,
    );
    assert.equal(
      store.getRecord("runtime", "unsafe-image"),
      undefined,
      "拒绝前不得先写入 SQLite",
    );
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("无 data URL 前缀的图片 Base64 也必须在持久化前拒绝", () => {
  const rawPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXQAAAAASUVORK5CYII=";
  assert.throws(
    () => assertNoImageBase64({ relatedObjects: rawPng }, "任务记录"),
    /媒体 Base64/,
  );
});

test("音视频 data URL 与无头 MP4 Base64 同样在持久化前拒绝", () => {
  assert.throws(
    () => assertNoImageBase64({ audio: "data:audio/mpeg;base64,SUQzBAAAAAA=" }),
    /Base64/,
  );
  const mp4Header = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    ...new Array(48).fill(0),
  ]).toString("base64");
  assert.throws(() => assertNoImageBase64({ video: mp4Header }), /Base64/);
});
