import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import { ProfileCrypto } from "../../src/tianjiang/crypto/profile-crypto";
import { LegacyMigrator } from "../../src/tianjiang/migration/legacy-migrator";

function createTestRoot(label: string): string {
  // 中文注释：SQLite/WAL 夹具固定放在工作树短路径，避免系统 TEMP、杀毒软件和长路径造成非业务失败。
  const base = path.resolve(process.cwd(), "..", ".tmp", "legacy-migrator");
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, `${label}-`));
}

function createLegacyFixture(root: string): { databasePath: string; filesRoot: string } {
  const databasePath = path.join(root, "db2.sqlite");
  const db = new Database(databasePath);
  db.exec(`
    CREATE TABLE o_user(id INTEGER PRIMARY KEY, username TEXT, password TEXT);
    CREATE TABLE o_project(id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE o_setting(id INTEGER PRIMARY KEY, setting_key TEXT, setting_value TEXT);
    CREATE TABLE o_script(id INTEGER PRIMARY KEY, project_id INTEGER, title TEXT);
    CREATE TABLE unknown_table(id INTEGER PRIMARY KEY, payload TEXT);
    INSERT INTO o_user VALUES (1, 'legacy-author', 'legacy-password-must-not-migrate');
    INSERT INTO o_project VALUES (10, '旧项目');
    INSERT INTO o_setting VALUES (1, 'theme.mode', 'dark');
    INSERT INTO o_script VALUES (100, 10, '第一场');
    INSERT INTO unknown_table VALUES (1, '原样保留');
  `);
  db.close();
  const filesRoot = path.join(root, "files");
  fs.mkdirSync(path.join(filesRoot, "10", "images"), { recursive: true });
  fs.writeFileSync(path.join(filesRoot, "10", "images", "cover.png"), "image-content");
  fs.writeFileSync(path.join(filesRoot, "unassigned.bin"), "unknown-content");
  return { databasePath, filesRoot };
}

test("旧库迁移覆盖每表每行每文件并保留未知内容与只读备份", async () => {
  const root = createTestRoot("success");
  const source = createLegacyFixture(root);
  const target = path.join(root, "target");
  const userUUID = "018f3d6e-2d9e-7b6c-8a9b-1234567890ab";
  const migrator = new LegacyMigrator({
    ...source,
    targetDataRoot: target,
    userUUID,
    userSegment: "a".repeat(32),
    profileCrypto: new ProfileCrypto(userUUID, Buffer.alloc(32, 5)),
  });
  try {
    const before = fs.readFileSync(source.databasePath);
    const report = await migrator.migrate();
    assert.equal(report.sourceIntegrity, "ok");
    assert.equal(report.totalSourceRows, 5);
    assert.equal(report.totalAccountPasswordsMigrated, 0);
    assert.equal(report.tables.every((table) => table.sourceRows === table.migratedRows + table.recoveryRows + table.excludedRows), true);
    assert.equal(report.files.sourceCount, 2);
    assert.equal(report.files.migratedCount + report.files.recoveryCount, 2);
    assert.equal(fs.existsSync(report.backupPath), true);
    assert.deepEqual(fs.readFileSync(source.databasePath), before);
    assert.equal(fs.existsSync(path.join(target, "recovery", report.migrationId, "tables", "unknown_table.json")), true);
    assert.equal(fs.existsSync(path.join(target, "recovery", report.migrationId, "files", "unassigned.bin")), true);
    assert.equal(fs.existsSync(report.reportPath), true);
    assert.doesNotMatch(fs.readFileSync(report.reportPath, "utf8"), /legacy-password-must-not-migrate/);

    await migrator.rollback(report);
    for (const created of report.createdPaths) assert.equal(fs.existsSync(created), false);
    assert.deepEqual(fs.readFileSync(source.databasePath), before);
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows 偶发目录锁，不掩盖主断言。
    }
  }
});

test("中断、磁盘不足和损坏数据库不覆盖旧数据且不留下正式半迁移", async () => {
  for (const mode of ["interrupt", "disk", "corrupt"] as const) {
    const root = createTestRoot(mode);
    const source = createLegacyFixture(root);
    if (mode === "corrupt") fs.writeFileSync(source.databasePath, "not-a-sqlite-database");
    const before = fs.readFileSync(source.databasePath);
    const target = path.join(root, "target");
    const userUUID = "018f3d6e-2d9e-7b6c-8a9b-1234567890ab";
    const migrator = new LegacyMigrator({
      ...source, targetDataRoot: target, userUUID,
      userSegment: "a".repeat(32),
      profileCrypto: new ProfileCrypto(userUUID, Buffer.alloc(32, 6)),
      failAfterRows: mode === "interrupt" ? 2 : undefined,
      availableBytes: mode === "disk" ? 1 : undefined,
    });
    await assert.rejects(() => migrator.migrate(), /迁移失败|磁盘空间不足|SQLite/);
    assert.deepEqual(fs.readFileSync(source.databasePath), before);
    assert.equal(fs.existsSync(path.join(target, "users")), false);
    assert.equal(fs.existsSync(path.join(target, "projects")), false);
    try {
      // Windows 上 SQLite 关闭后目录删除仍可能短暂 EPERM，不影响断言结果。
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup race
    }
  }
});
