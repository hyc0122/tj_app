import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import { ProjectStore } from "../../src/tianjiang/data/project-store";
import { projectDirectory, resolveProjectFile } from "../../src/tianjiang/data/paths";

const projectA = "018f3d6e-2d9e-7b6c-8a9b-1234567890aa";
const projectB = "018f3d6e-2d9e-7b6c-8a9b-1234567890bb";
const userSegment = "a".repeat(32);

test("每项目 SQLite、事务和文件目录互不污染", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tj-project-"));
  const a = new ProjectStore(root, projectA, "readwrite");
  const b = new ProjectStore(root, projectB, "readwrite");
  try {
    a.setRecord("script", "scene-1", { title: "甲项目" });
    b.setRecord("script", "scene-1", { title: "乙项目" });
    assert.deepEqual(a.getRecord("script", "scene-1"), { title: "甲项目" });
    assert.deepEqual(b.getRecord("script", "scene-1"), { title: "乙项目" });
    assert.notEqual(a.databasePath, b.databasePath);

    const fileA = a.resolveFile("images/cover.png");
    fs.mkdirSync(path.dirname(fileA), { recursive: true });
    fs.writeFileSync(fileA, "A");
    assert.equal(fs.existsSync(b.resolveFile("images/cover.png")), false);
  } finally {
    a.close();
    b.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("项目路径只接受规范相对路径并拒绝路径穿越", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tj-project-path-"));
  try {
    assert.equal(
      resolveProjectFile(root, projectA, "images/a.png", userSegment),
      path.join(projectDirectory(root, projectA, userSegment), "files", "images", "a.png"),
    );
    for (const bad of ["../escape", "/absolute", "C:\\outside", "a/../b", "a\\b"]) {
      assert.throws(
        () => resolveProjectFile(root, projectA, bad, userSegment),
        /项目文件相对路径无效/,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("项目可复制到另一设备且连接可在可写与只读模式安全切换", () => {
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), "tj-device-a-"));
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "tj-device-b-"));
  const store = new ProjectStore(rootA, projectA, "readwrite");
  store.setRecord("story", "root", { value: 1 });
  store.close();
  fs.cpSync(
    path.join(rootA, "projects", projectA),
    path.join(rootB, "projects", projectA),
    { recursive: true },
  );

  const copied = new ProjectStore(rootB, projectA, "readonly");
  try {
    assert.deepEqual(copied.getRecord("story", "root"), { value: 1 });
    assert.throws(() => copied.setRecord("story", "root", { value: 2 }), /项目当前为只读模式/);
    copied.switchMode("readwrite");
    copied.setRecord("story", "root", { value: 2 });
    assert.deepEqual(copied.getRecord("story", "root"), { value: 2 });
  } finally {
    copied.close();
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  }
});

test("项目存储只在本项目数据库中解析旧业务子资源", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tj-project-resource-"));
  const a = new ProjectStore(root, projectA, "readwrite");
  const b = new ProjectStore(root, projectB, "readwrite");
  try {
    const database = new Database(a.databasePath);
    database.exec("CREATE TABLE o_script (id INTEGER PRIMARY KEY, projectId INTEGER)");
    database.prepare("INSERT INTO o_script(id, projectId) VALUES (?, ?)").run(91, 1);
    database.close();

    assert.equal(a.hasLegacyResource("o_script", 91), true);
    assert.equal(b.hasLegacyResource("o_script", 91), false);
    assert.throws(
      () => a.hasLegacyResource("o_vendorConfig" as "o_script", 91),
      /资源表/,
    );
  } finally {
    a.close();
    b.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
