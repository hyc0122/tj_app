const assert = require("node:assert/strict");

const expectedRuntime = process.argv[2];
const requestedPackage = process.argv[3];
const actualRuntime = process.versions.electron ? "electron" : "node";
const expectedVersions = {
  "better-sqlite3": "12.9.0",
  sqlite3: "6.0.1",
};

if (!["node", "electron"].includes(expectedRuntime)) {
  throw new Error("用法：verify-native-sqlite.cjs <node|electron>");
}
if (requestedPackage && !Object.hasOwn(expectedVersions, requestedPackage)) {
  throw new Error(`不支持的原生模块验证目标：${requestedPackage}`);
}
const packageNames = requestedPackage
  ? [requestedPackage]
  : Object.keys(expectedVersions);

assert.equal(
  actualRuntime,
  expectedRuntime,
  `原生模块验证运行时不匹配：期望 ${expectedRuntime}，实际 ${actualRuntime}`,
);
if (expectedRuntime === "node") {
  assert.equal(process.versions.node, "24.13.1", "Node 版本不符合锁定值");
  assert.equal(process.versions.modules, "137", "Node ABI 不符合锁定值");
} else {
  assert.equal(process.versions.electron, "40.0.0", "Electron 版本不符合锁定值");
}

for (const packageName of packageNames) {
  const expectedVersion = expectedVersions[packageName];
  assert.equal(
    require(`${packageName}/package.json`).version,
    expectedVersion,
    `${packageName} 版本不符合锁定值`,
  );
}

function verifyBetterSqlite3() {
  const BetterSqlite3 = require("better-sqlite3");
  const betterDb = new BetterSqlite3(":memory:");
  betterDb.exec("CREATE TABLE abi_check (value TEXT NOT NULL)");
  betterDb.prepare("INSERT INTO abi_check(value) VALUES (?)").run(actualRuntime);
  assert.equal(
    betterDb.prepare("SELECT value FROM abi_check").get().value,
    actualRuntime,
  );
  betterDb.close();
}

async function verifySqlite3() {
  const sqlite3 = require("sqlite3");
  const db = await new Promise((resolve, reject) => {
    const instance = new sqlite3.Database(":memory:", (error) => {
      if (error) reject(error);
      else resolve(instance);
    });
  });

  await new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run("CREATE TABLE abi_check (value TEXT NOT NULL)");
      db.run("INSERT INTO abi_check(value) VALUES (?)", [actualRuntime]);
      db.get("SELECT value FROM abi_check", (error, row) => {
        if (error) reject(error);
        else {
          assert.equal(row.value, actualRuntime);
          resolve();
        }
      });
    });
  });

  await new Promise((resolve, reject) => {
    db.close((error) => (error ? reject(error) : resolve()));
  });
}

async function verifyPackages() {
  // 每个目标都执行内存库读写，避免只验证 require 成功却遗漏 ABI 调用失败。
  for (const packageName of packageNames) {
    if (packageName === "better-sqlite3") verifyBetterSqlite3();
    else await verifySqlite3();
  }
}

verifyPackages()
  .then(() => {
    console.log(
      JSON.stringify({
        runtime: actualRuntime,
        modulesAbi: process.versions.modules,
        electron: process.versions.electron ?? null,
        node: process.versions.node,
        betterSqlite3: expectedVersions["better-sqlite3"],
        sqlite3: expectedVersions.sqlite3,
        verifiedPackages: packageNames,
      }),
    );
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
