import assert from "node:assert/strict";
import test from "node:test";

import {
  configureSQLiteConnection,
  isRetryableSQLiteStartupError,
  runWithSQLiteStartupRetry,
} from "../../src/utils/sqlite-connection";

test("SQLite PRAGMA 失败时必须先关闭原生句柄再把错误交给 Knex", () => {
  const expected = Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
  let closeCalls = 0;
  let callbackError: Error | null = null;
  let callbackConnection: unknown;
  const connection = {
    pragma(statement: string) {
      if (statement.includes("journal_mode")) throw expected;
    },
    close() {
      closeCalls += 1;
    },
  };

  configureSQLiteConnection(connection, (error, returned) => {
    callbackError = error;
    callbackConnection = returned;
  });

  assert.equal(closeCalls, 1);
  assert.equal(callbackError, expected);
  assert.equal(callbackConnection, undefined);
});

test("SQLite PRAGMA 全部成功时返回同一连接且不关闭", () => {
  const statements: string[] = [];
  let closeCalls = 0;
  const connection = {
    pragma(statement: string) {
      statements.push(statement);
    },
    close() {
      closeCalls += 1;
    },
  };
  let returned: unknown;

  configureSQLiteConnection(connection, (error, value) => {
    assert.equal(error, null);
    returned = value;
  });

  assert.deepEqual(statements, [
    "foreign_keys = ON",
    "journal_mode = WAL",
    "busy_timeout = 5000",
  ]);
  assert.equal(returned, connection);
  assert.equal(closeCalls, 0);
});

test("启动迁移只重试明确的 SQLite 瞬时错误，并且每次创建全新尝试", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const result = await runWithSQLiteStartupRetry(
    async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_LOCKED" });
      }
      return "ready";
    },
    async (delayMs) => {
      delays.push(delayMs);
    },
  );

  assert.equal(result, "ready");
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [50]);
});

test("权限、损坏和普通 IOERR 不得被启动重试掩盖", async () => {
  for (const code of ["SQLITE_CORRUPT", "SQLITE_PERM", "SQLITE_IOERR"]) {
    let attempts = 0;
    const expected = Object.assign(new Error(code), { code });
    await assert.rejects(
      () => runWithSQLiteStartupRetry(async () => {
        attempts += 1;
        throw expected;
      }, async () => undefined),
      (error: unknown) => error === expected,
    );
    assert.equal(attempts, 1, `${code} 不得重试`);
  }
  assert.equal(isRetryableSQLiteStartupError({ code: "SQLITE_BUSY" }), true);
  assert.equal(isRetryableSQLiteStartupError({ code: "SQLITE_IOERR_TRUNCATE" }), true);
  assert.equal(isRetryableSQLiteStartupError({ code: "SQLITE_IOERR" }), false);
});
