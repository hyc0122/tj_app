/**
 * 第 5 轮集成契约：UI 弹层/悬浮、一键配置与模型路由部署键同源。
 * 行为级断言，禁止仅用源码正则冒充。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  ADVANCED_DEPLOYMENT_KEYS,
  FROZEN_DEPLOYMENT_KEYS,
  RUNTIME_DEPLOYMENT_CONSUMERS,
  SIMPLE_DEPLOYMENT_KEYS,
  isFrozenDeploymentKey,
} from "../../src/tianjiang/model/deployment-keys";
import {
  EXCLUDED_BULK_KEYS,
  SIMPLE_AGENT_KEYS,
  resolveBulkTargetKeys,
  type AgentDeployRow,
} from "../../src/tianjiang/agent/bulk-agent-config";

function rowsFromKeys(keys: string[], disabled: string[] = []): AgentDeployRow[] {
  return keys.map((key, i) => ({
    id: i + 1,
    key,
    disabled: disabled.includes(key) ? 1 : 0,
  }));
}

test("一键配置简易键与冻结 SIMPLE 注册表同源（除 ttsDubbing）", () => {
  const expected = SIMPLE_DEPLOYMENT_KEYS.filter((k) => k !== "ttsDubbing");
  assert.deepEqual([...SIMPLE_AGENT_KEYS], [...expected]);
  assert.ok(SIMPLE_AGENT_KEYS.includes("universalAi"));
  assert.ok(!SIMPLE_AGENT_KEYS.includes("ttsDubbing"));
  assert.ok(EXCLUDED_BULK_KEYS.has("ttsDubbing"));
});

test("简易一键配置只写 scriptAgent/productionAgent/universalAi 且跳过禁用", () => {
  const rows = rowsFromKeys(
    ["scriptAgent", "productionAgent", "universalAi", "ttsDubbing", "scriptAgent:decisionAgent"],
    ["productionAgent"],
  );
  const keys = resolveBulkTargetKeys("simple", rows);
  assert.deepEqual(keys, ["scriptAgent", "universalAi"]);
  assert.ok(!keys.includes("ttsDubbing"));
  assert.ok(!keys.includes("scriptAgent:decisionAgent"));
});

test("高级一键配置覆盖 universalAi + 全部启用 ADVANCED 键，顺序稳定", () => {
  const all = ["universalAi", ...ADVANCED_DEPLOYMENT_KEYS, "ttsDubbing", "orphan:key"];
  const rows = rowsFromKeys(all, ["scriptAgent:supervisionAgent"]);
  const keys = resolveBulkTargetKeys("advanced", rows);
  assert.equal(keys[0], "universalAi");
  assert.ok(!keys.includes("ttsDubbing"));
  assert.ok(!keys.includes("orphan:key"));
  assert.ok(!keys.includes("scriptAgent:supervisionAgent"));
  for (const key of ADVANCED_DEPLOYMENT_KEYS) {
    if (key === "scriptAgent:supervisionAgent") continue;
    assert.ok(keys.includes(key), `missing advanced key ${key}`);
  }
  // 顺序：注册表顺序
  const withoutUniversal = keys.filter((k) => k !== "universalAi");
  const expectedAdv = ADVANCED_DEPLOYMENT_KEYS.filter(
    (k) => k !== "scriptAgent:supervisionAgent",
  );
  assert.deepEqual(withoutUniversal, [...expectedAdv]);
});

test("universalAi 运行时消费链登记完整且均为冻结键", () => {
  const entry = RUNTIME_DEPLOYMENT_CONSUMERS.find((c) => c.key === "universalAi");
  assert.ok(entry);
  assert.ok(entry!.consumers.some((c) => c.includes("cleanNovel")));
  assert.ok(entry!.consumers.some((c) => c.includes("extractAssets")));
  assert.ok(entry!.consumers.some((c) => c.includes("getAiRegex") || c.includes("script/getAiRegex")));
  for (const c of RUNTIME_DEPLOYMENT_CONSUMERS) {
    assert.equal(isFrozenDeploymentKey(c.key), true);
  }
});

test("Ai.Text 与 cleanNovel 经统一解析路径消费 universalAi", () => {
  const aiSrc = fs.readFileSync(path.join(process.cwd(), "src/utils/ai.ts"), "utf8");
  assert.match(aiSrc, /account-model-resolver/);
  assert.match(aiSrc, /FROZEN_DEPLOYMENT_KEYS/);
  const cleanSrc = fs.readFileSync(path.join(process.cwd(), "src/utils/cleanNovel.ts"), "utf8");
  assert.match(cleanSrc, /Ai\.Text\(["']universalAi["']\)/);
  assert.match(cleanSrc, /account-model-resolver|resolveAccountPromptText/);
});

test("冻结注册表长度与简易+高级并集一致", () => {
  assert.equal(
    FROZEN_DEPLOYMENT_KEYS.length,
    SIMPLE_DEPLOYMENT_KEYS.length + ADVANCED_DEPLOYMENT_KEYS.length,
  );
});
