import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import knex, { type Knex } from "knex";

import {
  loadVendorPrivateInputs,
  sanitizeVendorSourceSecrets,
} from "../../src/utils/vendor-private-config";

test("当前账号供应商密钥允许在本机 db2 明文保存并由模型执行链读取", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tj-vendor-local-db-"));
  const database = await createVendorDatabase(path.join(root, "db2.sqlite"));
  const secret = "current-user-local-plaintext";
  try {
    await database("o_vendorConfig").insert({
      id: "synthetic",
      inputValues: JSON.stringify({
        apiKey: secret,
        baseUrl: "https://provider.invalid/v1",
      }),
    });
    const row = await database("o_vendorConfig").where("id", "synthetic").first();
    assert.equal(String(row.inputValues).includes(secret), true);
    assert.deepEqual(await loadVendorPrivateInputs("synthetic", database), {
      apiKey: secret,
      baseUrl: "https://provider.invalid/v1",
    });
  } finally {
    await database.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("同机两个账号各读自己的 db2，切换读取句柄不会复用上一账号密钥", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tj-vendor-user-isolation-"));
  const alice = await createVendorDatabase(path.join(root, "alice", "db2.sqlite"));
  const bob = await createVendorDatabase(path.join(root, "bob", "db2.sqlite"));
  try {
    await alice("o_vendorConfig").insert({
      id: "synthetic",
      inputValues: JSON.stringify({ apiKey: "alice-local-key" }),
    });
    await bob("o_vendorConfig").insert({
      id: "synthetic",
      inputValues: JSON.stringify({ apiKey: "bob-local-key" }),
    });
    assert.deepEqual(await loadVendorPrivateInputs("synthetic", alice), {
      apiKey: "alice-local-key",
    });
    assert.deepEqual(await loadVendorPrivateInputs("synthetic", bob), {
      apiKey: "bob-local-key",
    });
    assert.notDeepEqual(
      await loadVendorPrivateInputs("synthetic", alice),
      await loadVendorPrivateInputs("synthetic", bob),
    );
  } finally {
    await Promise.all([alice.destroy(), bob.destroy()]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("动态供应商源码仍剥离密码型密钥但保留公开默认 URL", () => {
  const secret = "source-must-not-persist";
  const source = `
    const vendor = {
      inputValues: {
        apiKey: ${JSON.stringify(secret)},
        baseUrl: "https://provider.example/v1",
      },
    };
  `;
  const sanitized = sanitizeVendorSourceSecrets(
    source,
    [
      { key: "apiKey", type: "password" },
      { key: "baseUrl", type: "url" },
    ],
    { apiKey: secret, baseUrl: "https://provider.example/v1" },
  );
  assert.equal(sanitized.includes(secret), false);
  assert.equal(sanitized.includes("https://provider.example/v1"), true);
  assert.match(sanitized, /apiKey:\s*""/);
});

async function createVendorDatabase(filename: string): Promise<Knex> {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const database = knex({
    client: "better-sqlite3",
    connection: { filename },
    useNullAsDefault: true,
  });
  await database.schema.createTable("o_vendorConfig", (table) => {
    table.text("id").primary();
    table.text("inputValues");
  });
  return database;
}
