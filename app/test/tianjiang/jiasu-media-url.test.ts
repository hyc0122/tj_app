import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  configureModelMediaResolver,
  prepareModelMediaReferences,
  preflightModelMediaReferences,
} from "../../src/tianjiang/media/model-media-reference";
import { runWithProjectStorage, runWithUserStorage, currentUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import { resolveProjectFilePath } from "../../src/tianjiang/media/project-file-store";
import getPath from "../../src/utils/getPath";
import { MINIMAL_PNG } from "./helpers/minimal-png";

const urlCapability = { supportsUrl: true, supportsInline: false, requireUrl: true };
const projectUuid = "12121212-1212-4212-a121-121212121212";
const png = `data:image/png;base64,${MINIMAL_PNG.toString("base64")}`;

test("佳速旧内联素材在项目暂存后才变成 URL，预检不落盘或调用网络", async () => {
  const originalDirectory = process.cwd();
  const temporaryRoot = path.resolve(originalDirectory, "..", ".tmp");
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(temporaryRoot, "jiasu-url-"));
  let staged = 0;
  try {
    process.chdir(root);
    await runWithUserStorage({ issuer: "https://central.example", userId: 19 }, () => runWithProjectStorage(projectUuid, async () => {
      configureModelMediaResolver({ stageLocalPath: async (reference) => {
        staged++;
        assert.equal(reference.projectUuid, projectUuid);
        const file = resolveProjectFilePath(getPath(), projectUuid, currentUserStorage()!.segment, reference.relativePath!);
        assert.deepEqual(fs.readFileSync(file), MINIMAL_PNG);
        assert.equal(reference.size, MINIMAL_PNG.length);
        return "https://media.example/signed-reference.png";
      } });
      const references = [{ type: "image" as const, base64: png, name: "项目角色甲" }];
      preflightModelMediaReferences(references, urlCapability);
      assert.equal(staged, 0);
      assert.equal(fs.existsSync(path.join(root, "data")), false);
      const result = await prepareModelMediaReferences(references, urlCapability);
      assert.equal(result[0].base64, "https://media.example/signed-reference.png");
      assert.equal(result[0].name, "项目角色甲");
      assert.equal(staged, 1);
      assert.equal(references[0].base64, png);
    }));
  } finally {
    configureModelMediaResolver(undefined);
    process.chdir(originalDirectory);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("佳速 URL 素材无需转存，坏 URL 或缺项目身份的内联素材在预检拒绝", async () => {
  assert.deepEqual(await prepareModelMediaReferences([{ type: "video", base64: "https://media.example/ref.mp4" }], urlCapability), [
    { type: "video", base64: "https://media.example/ref.mp4" },
  ]);
  for (const base64 of ["http://private.example/a.png", "https://user:secret@media.example/a.png", "invalid"]) {
    assert.throws(() => preflightModelMediaReferences([{ type: "image", base64 }], urlCapability), /HTTPS/);
  }
  assert.throws(() => preflightModelMediaReferences([{ type: "image", base64: png }], urlCapability), /项目身份/);
  // 中文注释：本次只给佳速启用严格 URL 合同，其他供应商内联路径保持不变。
  assert.equal((await prepareModelMediaReferences([{ type: "image", base64: png }], { supportsUrl: false, supportsInline: true }))[0].base64, png);
});
