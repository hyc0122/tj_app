/**
 * Embedding 账号绑定生命周期：segment + 配置摘要变化时必须 dispose 重建。
 * A 登录初始化 → 切换 B → B 不得复用 A 的 binding。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  computeEmbeddingBindingKey,
  disposeEmbedding,
  getEmbeddingBindingKeyForTest,
} from "../../src/utils/agent/embedding";

test("binding key 随 segment 与配置摘要变化", () => {
  const cfgA = JSON.stringify(["all-MiniLM-L6-v2", "onnx", "model_fp16.onnx"]);
  const cfgB = JSON.stringify(["other-model", "onnx", "model.onnx"]);
  const a1 = computeEmbeddingBindingKey("seg-a", cfgA, "fp16");
  const a2 = computeEmbeddingBindingKey("seg-a", cfgA, "fp16");
  const b1 = computeEmbeddingBindingKey("seg-b", cfgA, "fp16");
  const aCfg = computeEmbeddingBindingKey("seg-a", cfgB, "fp16");
  assert.equal(a1, a2);
  assert.notEqual(a1, b1);
  assert.notEqual(a1, aCfg);
});

test("disposeEmbedding 清空 binding key", async () => {
  await disposeEmbedding();
  assert.equal(getEmbeddingBindingKeyForTest(), null);
});

test("A→B 账号切换：binding 不同且 activate/destroy 路径显式 dispose", () => {
  const cfg = JSON.stringify(["all-MiniLM-L6-v2", "onnx", "model_fp16.onnx"]);
  const bindingA = computeEmbeddingBindingKey("account-a-segment", cfg, "fp16");
  const bindingB = computeEmbeddingBindingKey("account-b-segment", cfg, "fp16");
  assert.notEqual(bindingA, bindingB, "B 不得复用 A 的 segment binding");

  // 同 segment 配置变化也必须换 key
  const bindingA2 = computeEmbeddingBindingKey(
    "account-a-segment",
    JSON.stringify(["other", "onnx", "x.onnx"]),
    "fp32",
  );
  assert.notEqual(bindingA, bindingA2);

  const dbSource = fs.readFileSync(
    path.join(process.cwd(), "src/utils/db.ts"),
    "utf8",
  );
  // 账号切换 activate 与全局关闭均须 disposeEmbedding
  assert.match(dbSource, /activateUserDatabase[\s\S]*disposeEmbedding/);
  assert.match(dbSource, /destroyAllDatabaseHandles[\s\S]*disposeEmbedding/);

  const embSource = fs.readFileSync(
    path.join(process.cwd(), "src/utils/agent/embedding.ts"),
    "utf8",
  );
  // dispose 不得触发 transformers/db 重型加载
  assert.match(embSource, /不触发 transformers\/db 加载|模块顶层禁止导入 db \/ transformers/);
  assert.doesNotMatch(
    embSource.split("export async function disposeEmbedding")[0] ?? "",
    /from "@huggingface\/transformers"/,
  );
});

test("vendor-status-adapters 失败关闭且 activate 注入 accountConfigDatabase", () => {
  const adapters = fs.readFileSync(
    path.join(process.cwd(), "src/tianjiang/tasks/vendor-status-adapters.ts"),
    "utf8",
  );
  assert.match(adapters, /accountConfigDatabase/);
  assert.match(adapters, /禁止账号库解析失败后回退项目/);
  assert.doesNotMatch(adapters, /configDb\s*=\s*database\b/);

  const dbSource = fs.readFileSync(
    path.join(process.cwd(), "src/utils/db.ts"),
    "utf8",
  );
  assert.match(dbSource, /accountConfigDatabase:\s*activeHandle\.client/);
  assert.match(dbSource, /accountConfigDatabase:\s*userDb|accountConfigDatabase:\s*userHandle\.client/);

  const appSource = fs.readFileSync(
    path.join(process.cwd(), "src/app.ts"),
    "utf8",
  );
  // 离线路径也必须 prepareUserDatabase，避免 open 时 accountDatabase 尚未初始化
  assert.match(appSource, /runOffline:[\s\S]*prepareUserDatabase/);
});
