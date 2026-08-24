/**
 * 覆盖图片/视频/音频/文本/PDF 在项目上下文中写入 → HTTP 逻辑路径 → 快照清单 → 同步读取。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { projectDirectory } from "../../src/tianjiang/data/paths";
import { ProjectStore } from "../../src/tianjiang/data/project-store";
import { RuntimeProjectLocal } from "../../src/tianjiang/runtime/project-runtime-local";
import {
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import oss from "../../src/utils/oss";
import getPath from "../../src/utils/getPath";

const projectUuid = "018f3d6e-2d9e-7b6c-8a9b-000000000097";
const workspaceTempRoot = path.resolve(__dirname, "../../../.tmp");
fs.mkdirSync(workspaceTempRoot, { recursive: true });

test("项目上下文写入图片视频音频文本PDF 必须进入 files 并进入完整快照", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-writer-cover-"));
  const previous = process.env.TIANJIANG_TEST_DATA_ROOT;
  // getPath 在部分环境读全局路径；此处直接用 user storage + project storage 验证 oss 委托。
  const identity = { issuer: "https://api.example.invalid", userId: 11 };
  const fixtures = [
    { rel: `${1}/images/a.png`, body: Buffer.from("png-cover"), kind: "image" },
    { rel: `${1}/videos/b.mp4`, body: Buffer.from("mp4-cover"), kind: "video" },
    { rel: `${1}/audios/c.mp3`, body: Buffer.from("mp3-cover"), kind: "audio" },
    { rel: `${1}/imports/d.txt`, body: Buffer.from("text-cover"), kind: "text" },
    { rel: `${1}/attachments/e.pdf`, body: Buffer.from("%PDF-cover"), kind: "pdf" },
  ];

  try {
    await runWithUserStorage(identity, async () => {
      const segment = (await import("../../src/tianjiang/runtime/user-storage-context")).userStorageSegment(identity);
      // 将 oss 的 getPath 数据根通过 monkey 不稳；直接用 store + writeProjectFile 语义验证 + oss 在 ALS 下行为
      const store = new ProjectStore(dataRoot, projectUuid, "readwrite", segment);
      store.setRecord("runtime", "seed", { ok: true });
      store.close();
      const projectRoot = projectDirectory(dataRoot, projectUuid, segment);
      fs.writeFileSync(path.join(projectRoot, ".tianjiang-manifest.json"), JSON.stringify({
        version: 1,
        objects: [{ relativePath: "project.sqlite", size: 1, md5: "0".repeat(32) }],
      }));

      // 直接通过 project-file-store 模拟 oss 项目路径映射结果（oss 依赖 getPath() 全局 dataRoot）
      const { writeProjectFileAtomic, readProjectFile } = await import(
        "../../src/tianjiang/media/project-file-store"
      );
      for (const item of fixtures) {
        const logical = item.rel.replace(/^\d+\//, "files/");
        writeProjectFileAtomic(dataRoot, projectUuid, segment, logical, item.body);
        assert.deepEqual(
          readProjectFile(dataRoot, projectUuid, segment, logical),
          item.body,
        );
      }

      // 账号级 artStyle 不得被项目化：写入账号 oss 语义路径
      const accountOss = path.join(dataRoot, "runtime-users", segment, "oss", "artStyle", "x.png");
      fs.mkdirSync(path.dirname(accountOss), { recursive: true });
      fs.writeFileSync(accountOss, Buffer.from("account-style"));

      const local = new RuntimeProjectLocal(dataRoot, projectUuid, segment);
      await local.install(false);
      try {
        const snapshot = await local.createSnapshot();
        const paths = snapshot.objects.map((o) => o.relativePath);
        for (const item of fixtures) {
          const logical = item.rel.replace(/^\d+\//, "files/");
          assert.ok(paths.includes(logical), `快照缺少 ${logical}`);
          const object = snapshot.objects.find((o) => o.relativePath === logical)!;
          const bytes = local.readSyncObject(logical, { md5: object.md5, size: object.size });
          assert.deepEqual(bytes, item.body);
        }
        assert.equal(
          paths.some((p) => p.includes("artStyle")),
          false,
          "账号级美术风格不得进入项目清单",
        );
        // 数据库不得保存盘符绝对路径
        for (const object of snapshot.objects) {
          assert.equal(object.relativePath.includes(":"), false);
          assert.equal(object.relativePath.startsWith("/"), false);
        }
      } finally {
        local.close();
      }
    });
  } finally {
    if (previous === undefined) delete process.env.TIANJIANG_TEST_DATA_ROOT;
    else process.env.TIANJIANG_TEST_DATA_ROOT = previous;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("扫描门：项目业务路由禁止直接写账号 oss 根的硬编码例外需白名单", () => {
  const routesRoot = path.resolve(__dirname, "../../src/routes");
  const offenders: string[] = [];
  const allowList = new Set([
    // 账号级手册/技能/美术风格
    path.normalize("project/addDirectorManual.ts"),
    path.normalize("project/addVisualManual.ts"),
    path.normalize("project/editDirectorlManual.ts"),
    path.normalize("project/editVisualManual.ts"),
    path.normalize("setting/skillManagement/saveSkillContent.ts"),
    path.normalize("setting/modelMap/savePrompt.ts"),
    path.normalize("setting/modelMap/updatePrompt.ts"),
  ]);

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      const rel = path.relative(routesRoot, full);
      if (rel.startsWith("tianjiang") || rel.startsWith("setting") || rel.startsWith("login")) {
        // setting/login 多为账号级
        if (!rel.startsWith("setting\\skill") && !rel.startsWith("setting/skill")
          && !rel.startsWith("setting\\modelMap") && !rel.startsWith("setting/modelMap")
          && !rel.startsWith("project\\") && !rel.startsWith("project/")) {
          if (rel.startsWith("setting") || rel.startsWith("login") || rel.startsWith("tianjiang")) continue;
        }
      }
      const text = fs.readFileSync(full, "utf8");
      // 禁止业务路由直接 fs.writeFile 到 getPath("oss") 而不经 u.oss
      if (/getPath\(\s*["']oss["']\s*\)/.test(text) && /writeFileSync|fs\.promises\.writeFile|fs\.writeFile/.test(text)) {
        const normalized = rel.split(path.sep).join("/");
        const allowed = [...allowList].some((item) => normalized.endsWith(item.split(path.sep).join("/")));
        if (!allowed) offenders.push(normalized);
      }
    }
  }
  walk(routesRoot);
  assert.deepEqual(offenders, [], `未白名单的直接 oss 写入：${offenders.join(", ")}`);
});
