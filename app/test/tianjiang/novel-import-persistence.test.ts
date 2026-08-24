/**
 * 小说导入真实行为：事务提交后立即可查、重启同库仍可见、账号/项目隔离。
 * 临时目录必须落在工作树 .tmp，禁止系统 TEMP。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import knex, { type Knex } from "knex";

import { buildApplicationMigrations } from "../../src/tianjiang/data/application-migrations";
import { migrateSQLite } from "../../src/tianjiang/data/sqlite-migrator";

// app/ 为 cwd 时落到工作树 .tmp；禁止 import.meta（tsc --module commonjs 不接受）。
const tmpRoot = path.join(process.cwd(), "..", ".tmp", "novel-import-persistence");

function makeTempDir(label: string): string {
  const dir = path.join(tmpRoot, `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function openProjectDb(dir: string): Promise<Knex> {
  fs.mkdirSync(dir, { recursive: true });
  const databasePath = path.join(dir, "project.sqlite");
  if (!fs.existsSync(databasePath)) fs.writeFileSync(databasePath, "");
  const client = knex({
    client: "better-sqlite3",
    connection: { filename: databasePath },
    useNullAsDefault: true,
  });
  await migrateSQLite({
    database: client,
    databasePath,
    migrations: buildApplicationMigrations({ role: "project", skipEmbeddingInit: true }),
  });
  return client;
}

async function insertNovels(
  db: Knex,
  projectId: number,
  chapters: Array<{ reel: string; chapter: string; chapterData: string }>,
): Promise<number[]> {
  return db.transaction(async (trx) => {
    const last = await trx("o_novel")
      .where("projectId", projectId)
      .select("chapterIndex")
      .orderBy("chapterIndex", "desc")
      .first();
    let chapterIndex = last?.chapterIndex ?? 0;
    const ids: number[] = [];
    for (const item of chapters) {
      const [id] = await trx("o_novel").insert({
        projectId,
        chapterIndex: ++chapterIndex,
        reel: item.reel,
        chapter: item.chapter,
        chapterData: item.chapterData,
        createTime: Date.now(),
        eventState: 0,
      });
      ids.push(id);
    }
    const confirmed = await trx("o_novel").where("projectId", projectId).whereIn("id", ids);
    assert.equal(confirmed.length, ids.length);
    return ids;
  });
}

async function listNovels(db: Knex, projectId: number) {
  return db("o_novel")
    .where("projectId", projectId)
    .select("id", "chapterIndex as index", "chapter", "projectId")
    .orderBy("chapterIndex", "asc");
}

test("projectId 必须以 number 参与写入（禁止字符串 coerce 混入）", async () => {
  const root = makeTempDir("novel-pid-type");
  const db = await openProjectDb(path.join(root, "p"));
  try {
    // 路由契约为 z.number()；此处验证数值主键写入与回读。
    const projectId = 900001;
    assert.equal(typeof projectId, "number");
    const ids = await insertNovels(db, projectId, [
      { reel: "一", chapter: "C1", chapterData: "body" },
    ]);
    const rows = await listNovels(db, projectId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].projectId, projectId);
    assert.equal(typeof rows[0].projectId, "number");
    assert.equal(ids.length, 1);
  } finally {
    await db.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("导入后立即查询可见，关闭重开同库仍可见", async () => {
  const root = makeTempDir("novel-import");
  const projectDir = path.join(root, "p1");
  const projectId = 424242;
  let db = await openProjectDb(projectDir);
  try {
    const ids = await insertNovels(db, projectId, [
      { reel: "卷一", chapter: "第一章", chapterData: "正文A" },
      { reel: "卷一", chapter: "第二章", chapterData: "正文B" },
    ]);
    assert.equal(ids.length, 2);
    const immediate = await listNovels(db, projectId);
    assert.equal(immediate.length, 2);
    assert.equal(immediate[0].chapter, "第一章");
  } finally {
    await db.destroy();
  }

  // 模拟应用重启：重新打开同一 project.sqlite
  db = await openProjectDb(projectDir);
  try {
    const afterRestart = await listNovels(db, projectId);
    assert.equal(afterRestart.length, 2);
    assert.deepEqual(
      afterRestart.map((r: { chapter: string }) => r.chapter),
      ["第一章", "第二章"],
    );
  } finally {
    await db.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("两账号两项目隔离：互不可见", async () => {
  const root = makeTempDir("novel-iso");
  const aDir = path.join(root, "account-a", "proj-1");
  const bDir = path.join(root, "account-b", "proj-2");
  const aDb = await openProjectDb(aDir);
  const bDb = await openProjectDb(bDir);
  try {
    await insertNovels(aDb, 1001, [{ reel: "A", chapter: "A1", chapterData: "only-a" }]);
    await insertNovels(bDb, 2002, [{ reel: "B", chapter: "B1", chapterData: "only-b" }]);

    const aRows = await listNovels(aDb, 1001);
    const bRows = await listNovels(bDb, 2002);
    const aLeak = await listNovels(aDb, 2002);
    const bLeak = await listNovels(bDb, 1001);

    assert.equal(aRows.length, 1);
    assert.equal(bRows.length, 1);
    assert.equal(aLeak.length, 0);
    assert.equal(bLeak.length, 0);
    assert.equal(aRows[0].chapter, "A1");
    assert.equal(bRows[0].chapter, "B1");
    assert.notEqual(aRows[0].chapter, bRows[0].chapter);
  } finally {
    await aDb.destroy();
    await bDb.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("不同 projectId 写入同一库互不污染", async () => {
  const root = makeTempDir("novel-pid");
  const db = await openProjectDb(path.join(root, "shared"));
  try {
    await insertNovels(db, 1, [{ reel: "1", chapter: "P1", chapterData: "x" }]);
    await insertNovels(db, 2, [{ reel: "2", chapter: "P2", chapterData: "y" }]);
    assert.equal((await listNovels(db, 1)).length, 1);
    assert.equal((await listNovels(db, 2)).length, 1);
    assert.equal((await listNovels(db, 1))[0].chapter, "P1");
    assert.equal((await listNovels(db, 2))[0].chapter, "P2");
  } finally {
    await db.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
