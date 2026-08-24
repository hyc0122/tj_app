import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { projectDirectory } from "../../src/tianjiang/data/paths";
import { ProjectStore } from "../../src/tianjiang/data/project-store";
import { writeProjectFileAtomic } from "../../src/tianjiang/media/project-file-store";
import { RuntimeProjectLocal } from "../../src/tianjiang/runtime/project-runtime-local";
import {
  PersonalProjectSync,
  type PersonalManifest,
  type PersonalRemote,
} from "../../src/tianjiang/sync/personal-project-sync";

const projectUuid = "018f3d6e-2d9e-7b6c-8a9b-000000000098";
const userSegment = "d".repeat(32);
const workspaceTempRoot = path.resolve(__dirname, "../../../.tmp");
fs.mkdirSync(workspaceTempRoot, { recursive: true });

test("Personal idle/checkpoint 发布完整对象集合而非仅数据库", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-personal-complete-"));
  const store = new ProjectStore(dataRoot, projectUuid, "readwrite", userSegment);
  store.setRecord("runtime", "seed", { ok: true });
  store.close();
  const projectRoot = projectDirectory(dataRoot, projectUuid, userSegment);
  fs.writeFileSync(path.join(projectRoot, ".tianjiang-manifest.json"), JSON.stringify({
    version: 1,
    objects: [{ relativePath: "project.sqlite", size: 1, md5: "0".repeat(32) }],
  }));
  writeProjectFileAtomic(
    dataRoot,
    projectUuid,
    userSegment,
    "files/images/hero.png",
    Buffer.from("hero-png"),
  );

  const local = new RuntimeProjectLocal(dataRoot, projectUuid, userSegment);
  await local.install(false);
  local.dirty = true;

  const published: PersonalManifest[] = [];
  const remote: PersonalRemote = {
    latest: async () => ({ version: 1, objects: local.current?.objects ?? [] }),
    publish: async (_base, next) => {
      published.push(structuredClone(next));
      return { ...next, version: 2 };
    },
  };
  const sync = new PersonalProjectSync(local, remote, () => true);
  sync.open();
  try {
    const result = await sync.sync("idle");
    assert.equal(result.state, "synced");
    assert.equal(published.length, 1);
    const paths = published[0]!.objects.map((o) => o.relativePath);
    assert.ok(paths.includes("project.sqlite"));
    assert.ok(paths.includes("files/images/hero.png"), `完整清单缺失媒体：${paths.join(",")}`);
  } finally {
    local.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("Personal 定时器 close 时 cancel，不把入队当作中央成功", async () => {
  const delays: number[] = [];
  const handles: Array<{ cancel: () => void }> = [];
  const local = {
    current: { version: 1, objects: [{ relativePath: "project.sqlite", md5: "a".repeat(32), size: 1 }] },
    dirty: true,
    install: async () => undefined,
    createSnapshot: async () => ({
      version: 1,
      objects: [
        { relativePath: "project.sqlite", md5: "a".repeat(32), size: 1 },
        { relativePath: "files/videos/v.mp4", md5: "b".repeat(32), size: 2, mediaType: "video" as const },
      ],
    }),
    createRecovery: async () => undefined,
  };
  const remote: PersonalRemote = {
    latest: async () => local.current!,
    publish: async () => {
      throw new Error("中央失败");
    },
  };
  const sync = new PersonalProjectSync(local as never, remote, () => true, (run, delay) => {
    delays.push(delay);
    const handle = { cancel: () => undefined, run };
    handles.push(handle);
    return handle;
  });
  sync.open();
  sync.markEdited();
  assert.ok(delays.includes(30_000));
  assert.ok(delays.includes(120_000));
  await assert.rejects(() => sync.sync("manual"), /中央失败/);
  // 失败后 dirty 仍在，不得显示成功
  assert.equal(local.dirty, true);
  await sync.close().catch(() => undefined);
  // close 后不应再调度
  const before = delays.length;
  sync.markEdited();
  assert.equal(delays.length, before);
  void crypto;
  void path;
  void fs;
});
