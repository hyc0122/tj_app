/**
 * Round9 RED/GREEN：完整项目对象集合契约。
 * 必须覆盖 project.sqlite + files 下全部普通文件，排除 WAL/SHM/临时/日志/recovery。
 * 禁止以源码 contains 冒充行为测试。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { projectDirectory } from "../../src/tianjiang/data/paths";
import { ProjectStore } from "../../src/tianjiang/data/project-store";
import { RuntimeProjectLocal } from "../../src/tianjiang/runtime/project-runtime-local";

const projectUuid = "018f3d6e-2d9e-7b6c-8a9b-000000000091";
const userSegment = "9".repeat(32);
const workspaceTempRoot = path.resolve(__dirname, "../../../.tmp");
fs.mkdirSync(workspaceTempRoot, { recursive: true });

const MEDIA_FIXTURES: Array<{ relativePath: string; body: Buffer; mediaTypeHint: string }> = [
  { relativePath: "files/images/character.png", body: Buffer.from("png-character-bytes"), mediaTypeHint: "image" },
  { relativePath: "files/videos/shot.mp4", body: Buffer.from("mp4-shot-bytes"), mediaTypeHint: "video" },
  { relativePath: "files/audios/dialogue.mp3", body: Buffer.from("mp3-dialogue-bytes"), mediaTypeHint: "audio" },
  { relativePath: "files/thumbnails/character.webp", body: Buffer.from("webp-thumb-bytes"), mediaTypeHint: "image" },
  { relativePath: "files/references/style.jpg", body: Buffer.from("jpg-style-bytes"), mediaTypeHint: "image" },
  { relativePath: "files/imports/source.txt", body: Buffer.from("import-source-text"), mediaTypeHint: "text" },
  { relativePath: "files/attachments/notes.pdf", body: Buffer.from("%PDF-1.4 notes"), mediaTypeHint: "binary" },
  { relativePath: "files/legacy/legacy-id-1/old-image.jpg", body: Buffer.from("legacy-jpg-bytes"), mediaTypeHint: "image" },
];

function md5Of(bytes: Buffer): string {
  return crypto.createHash("md5").update(bytes).digest("hex");
}

function writeProjectMedia(projectRoot: string): void {
  for (const fixture of MEDIA_FIXTURES) {
    const absolute = path.join(projectRoot, ...fixture.relativePath.split("/"));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, fixture.body);
  }
}

async function openWritableLocal(dataRoot: string): Promise<RuntimeProjectLocal> {
  const store = new ProjectStore(dataRoot, projectUuid, "readwrite", userSegment);
  store.setRecord("runtime", "seed", { ok: true });
  store.close();
  const projectRoot = projectDirectory(dataRoot, projectUuid, userSegment);
  writeProjectMedia(projectRoot);
  fs.writeFileSync(path.join(projectRoot, ".tianjiang-manifest.json"), JSON.stringify({
    version: 3,
    objects: [{ relativePath: "project.sqlite", size: 1, md5: "0".repeat(32) }],
  }, null, 2));
  const local = new RuntimeProjectLocal(dataRoot, projectUuid, userSegment);
  // 中文注释：boolean false = 可写打开；与 PersonalLocal 接口的 manifest 重载并存。
  await local.install(false);
  return local;
}

test("createSnapshot 必须返回 project.sqlite 与 files 全部普通文件，稳定排序并含 size/MD5/mediaType", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-complete-object-set-"));
  const local = await openWritableLocal(dataRoot);
  try {
    const snapshot = await local.createSnapshot();
    const paths = snapshot.objects.map((item) => item.relativePath);
    assert.ok(paths.includes("project.sqlite"), "清单必须包含 project.sqlite");
    for (const fixture of MEDIA_FIXTURES) {
      assert.ok(
        paths.includes(fixture.relativePath),
        `清单必须包含 ${fixture.relativePath}（当前仅有：${paths.join(", ")}）`,
      );
    }
    // 稳定排序：按 / 路径字典序
    const sorted = [...paths].sort((a, b) => a.localeCompare(b));
    assert.deepEqual(paths, sorted, "对象路径必须稳定排序");

    for (const object of snapshot.objects) {
      assert.ok(typeof object.md5 === "string" && /^[a-f0-9]{32}$/.test(object.md5), "每项必须有 MD5");
      assert.ok(typeof object.size === "number" && Number.isSafeInteger(object.size) && object.size >= 0, "每项必须有 size");
      if (object.relativePath !== "project.sqlite") {
        const mediaType = (object as { mediaType?: string }).mediaType;
        assert.ok(
          mediaType === "image" || mediaType === "video" || mediaType === "audio"
            || mediaType === "text" || mediaType === "binary",
          `${object.relativePath} 必须带可判定 mediaType，实际=${String(mediaType)}`,
        );
      }
    }

    for (const fixture of MEDIA_FIXTURES) {
      const object = snapshot.objects.find((item) => item.relativePath === fixture.relativePath)!;
      assert.equal(object.size, fixture.body.length);
      assert.equal(object.md5, md5Of(fixture.body));
    }
  } finally {
    local.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("快照必须排除 WAL、SHM、临时目录、日志、缓存与 recovery 文件", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-complete-object-exclude-"));
  const local = await openWritableLocal(dataRoot);
  const projectRoot = projectDirectory(dataRoot, projectUuid, userSegment);
  try {
    // 中文注释：先关闭 live 库再写 -wal/-shm 替身，避免 Windows 锁导致夹具本身失败。
    local.close();
    fs.writeFileSync(path.join(projectRoot, "project.sqlite-wal"), Buffer.from("wal-junk"));
    fs.writeFileSync(path.join(projectRoot, "project.sqlite-shm"), Buffer.from("shm-junk"));
    fs.mkdirSync(path.join(projectRoot, ".tmp"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, ".tmp", "partial.bin"), Buffer.from("tmp"));
    fs.mkdirSync(path.join(projectRoot, ".incoming"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, ".incoming", "staging.bin"), Buffer.from("incoming"));
    fs.writeFileSync(path.join(projectRoot, "app.log"), Buffer.from("log-line\n"));
    fs.mkdirSync(path.join(projectRoot, "cache"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "cache", "x.bin"), Buffer.from("cache"));
    fs.mkdirSync(path.join(projectRoot, "recovery"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "recovery", "old.sqlite"), Buffer.from("recovery"));

    const reopened = new RuntimeProjectLocal(dataRoot, projectUuid, userSegment);
    await reopened.install(false);
    try {
      const snapshot = await reopened.createSnapshot();
      const paths = snapshot.objects.map((item) => item.relativePath);
      const forbidden = [
        "project.sqlite-wal",
        "project.sqlite-shm",
        ".tmp/partial.bin",
        ".incoming/staging.bin",
        "app.log",
        "cache/x.bin",
        "recovery/old.sqlite",
      ];
      for (const item of forbidden) {
        assert.equal(paths.includes(item), false, `不得同步排除项 ${item}`);
      }
      // 合法媒体仍应存在（完整集合契约）；当前生产仅 project.sqlite 时此处 RED。
      for (const fixture of MEDIA_FIXTURES) {
        assert.ok(paths.includes(fixture.relativePath), `合法对象仍需同步：${fixture.relativePath}`);
      }
    } finally {
      reopened.close();
    }
  } finally {
    try { local.close(); } catch { /* already closed */ }
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("清单构建对软链接必须 fail-closed，且完整对象集合不得遗漏普通文件", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-complete-object-security-"));
  const local = await openWritableLocal(dataRoot);
  const projectRoot = projectDirectory(dataRoot, projectUuid, userSegment);
  const filesRoot = path.join(projectRoot, "files");
  try {
    // 先验证无危险路径时完整对象集合包含媒体
    const healthy = await local.createSnapshot();
    assert.ok(
      healthy.objects.some((item) => item.relativePath === "files/images/character.png"),
      "完整对象集合必须包含普通媒体文件",
    );

    const outside = path.join(dataRoot, "outside-secret.bin");
    fs.writeFileSync(outside, Buffer.from("secret-outside"));
    const linkPath = path.join(filesRoot, "images", "escape-link.png");
    let symlinkCreated = false;
    try {
      fs.symlinkSync(outside, linkPath, "file");
      symlinkCreated = fs.lstatSync(linkPath).isSymbolicLink();
    } catch {
      symlinkCreated = false;
    }

    if (symlinkCreated) {
      // fail-closed：枚举到软链接必须拒绝构建清单，禁止把越界内容当普通对象同步。
      await assert.rejects(
        () => local.createSnapshot(),
        /符号链接|软链接|重解析|越界|路径/,
      );
      const { buildProjectFileInventory } = await import(
        "../../src/tianjiang/media/project-file-inventory"
      );
      assert.throws(
        () => buildProjectFileInventory(projectRoot),
        /符号链接|软链接|重解析|越界|路径/,
      );
    }
  } finally {
    local.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("readSyncObject 可读取清单中任意普通对象，但禁止越界与未列入清单文件", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-complete-read-object-"));
  const local = await openWritableLocal(dataRoot);
  try {
    const snapshot = await local.createSnapshot();
    const media = MEDIA_FIXTURES[0];
    const object = snapshot.objects.find((item) => item.relativePath === media.relativePath);
    assert.ok(object, `快照必须包含 ${media.relativePath} 才能验证 readSyncObject`);

    const bytes = local.readSyncObject(media.relativePath, {
      md5: object!.md5,
      size: object!.size,
    });
    assert.deepEqual(bytes, media.body);

    assert.throws(
      () => local.readSyncObject("../outside.bin", { md5: "0".repeat(32), size: 1 }),
      /路径|无效|越界/,
    );
    assert.throws(
      () => local.readSyncObject("files/images/not-in-manifest.bin", {
        md5: md5Of(Buffer.from("x")),
        size: 1,
      }),
      /未列入|清单|无效|不存在/,
    );
  } finally {
    local.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
