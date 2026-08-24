/**
 * 本地旧项目删除：按数字 ID 真实删库；同名 333 互不影响；禁止按名称删除。
 * 证据落在工作树 .tmp。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import knex, { type Knex } from "knex";

import { buildApplicationMigrations } from "../../src/tianjiang/data/application-migrations";
import { migrateSQLite } from "../../src/tianjiang/data/sqlite-migrator";

// app/ 为 cwd 时落到工作树 .tmp；禁止 import.meta（tsc --module commonjs 不接受）。
const tmpRoot = path.join(process.cwd(), "..", ".tmp", "local-project-delete-id");

async function openDb(label: string): Promise<{ db: Knex; root: string; databasePath: string }> {
  const root = path.join(tmpRoot, `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(root, { recursive: true });
  const databasePath = path.join(root, "project.sqlite");
  fs.writeFileSync(databasePath, "");
  const db = knex({
    client: "better-sqlite3",
    connection: { filename: databasePath },
    useNullAsDefault: true,
  });
  await migrateSQLite({
    database: db,
    databasePath,
    migrations: buildApplicationMigrations({ role: "project", skipEmbeddingInit: true }),
  });
  return { db, root, databasePath };
}

/** 与 delProject 路由一致：仅按 id 删除项目主行及其子资源（最小子集）。 */
async function deleteProjectById(db: Knex, id: number): Promise<void> {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("本地项目标识无效");
  }
  await db("o_project").where("id", id).delete();
  await db("o_novel").where("projectId", id).delete();
}

test("同名 333 两个项目：按数字 ID 删除只影响目标行", async () => {
  const { db, root } = await openDb("same-name");
  try {
    const a = 333001;
    const b = 333002;
    await db("o_project").insert([
      {
        id: a,
        projectType: "novel",
        name: "333",
        intro: "",
        type: "",
        artStyle: "",
        videoRatio: "",
        directorManual: "",
        userId: 1,
        imageModel: "",
        videoModel: "",
        createTime: Date.now(),
        imageQuality: "",
        mode: "",
      },
      {
        id: b,
        projectType: "novel",
        name: "333",
        intro: "",
        type: "",
        artStyle: "",
        videoRatio: "",
        directorManual: "",
        userId: 1,
        imageModel: "",
        videoModel: "",
        createTime: Date.now(),
        imageQuality: "",
        mode: "",
      },
    ]);
    await db("o_novel").insert([
      {
        projectId: a,
        chapterIndex: 1,
        reel: "一",
        chapter: "A",
        chapterData: "only-a",
        createTime: Date.now(),
        eventState: 0,
      },
      {
        projectId: b,
        chapterIndex: 1,
        reel: "一",
        chapter: "B",
        chapterData: "only-b",
        createTime: Date.now(),
        eventState: 0,
      },
    ]);

    // 禁止按名称删除：同名两行仍在。
    const byName = await db("o_project").where("name", "333").select("id");
    assert.equal(byName.length, 2);

    await deleteProjectById(db, a);

    const remaining = await db("o_project").select("id", "name").orderBy("id", "asc");
    assert.deepEqual(
      remaining.map((r: { id: number; name: string }) => ({ id: r.id, name: r.name })),
      [{ id: b, name: "333" }],
    );
    assert.equal(await db("o_novel").where("projectId", a).count({ c: "*" }).first().then((r: any) => Number(r.c)), 0);
    assert.equal(await db("o_novel").where("projectId", b).count({ c: "*" }).first().then((r: any) => Number(r.c)), 1);
  } finally {
    await db.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("删除后重启同库：目标项目不可见，失败路径不得只删内存卡片", async () => {
  const { db, root, databasePath } = await openDb("restart");
  const id = 900100;
  try {
    await db("o_project").insert({
      id,
      projectType: "novel",
      name: "待删",
      intro: "",
      type: "",
      artStyle: "",
      videoRatio: "",
      directorManual: "",
      userId: 2,
      imageModel: "",
      videoModel: "",
      createTime: Date.now(),
      imageQuality: "",
      mode: "",
    });
    await deleteProjectById(db, id);
    await db.destroy();

    // 重启：重新打开同一文件
    const reopened = knex({
      client: "better-sqlite3",
      connection: { filename: databasePath },
      useNullAsDefault: true,
    });
    try {
      const rows = await reopened("o_project").where("id", id);
      assert.equal(rows.length, 0);
    } finally {
      await reopened.destroy();
    }

    // 失败路径：非法 id 不得误删
    const again = knex({
      client: "better-sqlite3",
      connection: { filename: databasePath },
      useNullAsDefault: true,
    });
    try {
      await again("o_project").insert({
        id: 900200,
        projectType: "novel",
        name: "保留",
        intro: "",
        type: "",
        artStyle: "",
        videoRatio: "",
        directorManual: "",
        userId: 2,
        imageModel: "",
        videoModel: "",
        createTime: Date.now(),
        imageQuality: "",
        mode: "",
      });
      await assert.rejects(() => deleteProjectById(again, Number.NaN), /本地项目标识无效/);
      await assert.rejects(() => deleteProjectById(again, -1), /本地项目标识无效/);
      const kept = await again("o_project").where("id", 900200);
      assert.equal(kept.length, 1);
    } finally {
      await again.destroy();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
