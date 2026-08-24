/**
 * R16 RED：资产详情音频必须把用户真实写入路径转成受保护 src；
 * 路径类型仅报告形态，不回传绝对路径、filePath 或本机目录。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const PROJECT = "c1616161-1616-4161-a161-161616161616";
const LEGACY_PROJECT_ID = 1616;

/** 中文注释：addAudioAssets / updateAudioAssets 真实写入形态，只描述类型。 */
const LEGACY_ASSET_AUDIO_PATH = `/${LEGACY_PROJECT_ID}/assets/audio/r16-voice.mp3`;
const EXPECTED_LOGICAL = `files/attachments/${LEGACY_PROJECT_ID}/assets/audio/r16-voice.mp3`;

test("用户真实写入路径类型下 DTO 必须给出受保护 src，且不得回传 filePath", async () => {
  const { buildRelatedAudioDtos } = await import("../../src/tianjiang/storyboard/related-audio-dto");
  const seen: string[] = [];
  const dtos = await buildRelatedAudioDtos(
    [
      { id: 33, name: "33", filePath: LEGACY_ASSET_AUDIO_PATH },
      { id: 2, name: "规范音频", filePath: "files/audios/linxia.mp3" },
      { id: 3, name: "短目录", filePath: "audios/short.mp3" },
      { id: 4, name: "旧项目段", filePath: `${LEGACY_PROJECT_ID}/audios/old.mp3` },
    ],
    {
      projectUuid: PROJECT,
      getFileUrl: async (logicalPath) => {
        seen.push(logicalPath);
        return `/api/tianjiang/runtime/projects/${PROJECT}/${logicalPath}`;
      },
    },
  );
  assert.equal(dtos.length, 4);
  assert.equal(
    dtos[0]!.src,
    `/api/tianjiang/runtime/projects/${PROJECT}/${EXPECTED_LOGICAL}`,
    "用户真实写入路径类型 /{legacyProjectId}/assets/audio 当前没有安全 src",
  );
  assert.equal(seen[0], EXPECTED_LOGICAL);
  assert.deepEqual(dtos[0], {
    id: 33,
    name: "33",
    src: `/api/tianjiang/runtime/projects/${PROJECT}/${EXPECTED_LOGICAL}`,
  });
  assert.equal(dtos[1]!.src, `/api/tianjiang/runtime/projects/${PROJECT}/files/audios/linxia.mp3`);
  assert.equal(dtos[2]!.src, `/api/tianjiang/runtime/projects/${PROJECT}/files/audios/short.mp3`);
  assert.equal(dtos[3]!.src, `/api/tianjiang/runtime/projects/${PROJECT}/files/audios/old.mp3`);
  const serialized = JSON.stringify(dtos);
  assert.equal(serialized.includes("filePath"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(dtos[0], "filePath"), false);
  assert.equal(serialized.includes("C:/Users"), false);
  assert.equal(serialized.includes("C:\\"), false);
});

test("绝对路径、遍历、协议和编码绕过不得生成 src", async () => {
  const { buildRelatedAudioDtos } = await import("../../src/tianjiang/storyboard/related-audio-dto");
  const dtos = await buildRelatedAudioDtos(
    [
      { id: 1, name: "盘符", filePath: "C:/Users/alice/secret.mp3" },
      { id: 2, name: "UNC", filePath: "\\\\server\\share\\secret.mp3" },
      { id: 3, name: "遍历", filePath: "../outside.mp3" },
      { id: 4, name: "编码绕过", filePath: "files/audios/%2e%2e/secret.mp3" },
      { id: 5, name: "协议", filePath: "file:///etc/passwd" },
      { id: 6, name: "files 内遍历", filePath: "files/audios/../../secret.mp3" },
    ],
    {
      projectUuid: PROJECT,
      getFileUrl: async (logicalPath) => `/leaked/${logicalPath}`,
    },
  );
  assert.equal(dtos.every((item) => item.src === undefined), true);
  const serialized = JSON.stringify(dtos);
  assert.equal(serialized.includes("filePath"), false);
  assert.equal(serialized.includes("C:/Users"), false);
  assert.equal(serialized.includes("secret.mp3"), false);
  assert.equal(serialized.includes("passwd"), false);
  assert.equal(serialized.includes("\\\\server"), false);
});

test("getAllAssets 必须继续把 o_image.filePath 交给 DTO，且旧路径类型能得到受保护 src", async () => {
  const routeSource = fs.readFileSync(
    path.resolve(process.cwd(), "src/routes/cornerScape/getAllAssets.ts"),
    "utf8",
  );
  assert.match(routeSource, /buildRelatedAudioDtos/);
  assert.match(routeSource, /loadBoundRoleAudioInputs/);
  assert.doesNotMatch(routeSource, /filePath:\s*item\.audioFilePath,\s*src/);
  const { buildRelatedAudioDtos } = await import("../../src/tianjiang/storyboard/related-audio-dto");
  const rows = [
    { id: 902, name: "33", filePath: LEGACY_ASSET_AUDIO_PATH },
    { id: 903, name: "脏路径", filePath: "C:/Users/alice/secret.mp3" },
  ];
  const dtos = await buildRelatedAudioDtos(rows, {
    projectUuid: PROJECT,
    getFileUrl: async (logicalPath) => `/api/tianjiang/runtime/projects/${PROJECT}/${logicalPath}`,
  });
  assert.equal(dtos.length, 2);
  assert.equal(
    dtos[0]!.src,
    `/api/tianjiang/runtime/projects/${PROJECT}/${EXPECTED_LOGICAL}`,
    "getAllAssets 同源 DTO 必须给旧 assets/audio 路径受保护 src",
  );
  assert.equal(dtos[1]!.src, undefined);
  const serialized = JSON.stringify(dtos);
  assert.equal(serialized.includes("filePath"), false);
  assert.equal(serialized.includes("C:/Users"), false);
  assert.equal(serialized.includes("alice"), false);
});
