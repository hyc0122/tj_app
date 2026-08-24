/**
 * Round27 RED：模型版本是视频模型列表，不能与生成模式 capabilities 混用。
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { probeDreaminaCapabilities } from "../../src/tianjiang/model-providers/dreamina-cli/capability-probe";

const FAKE_CLI = path.resolve(__dirname, "fixtures", "fake-dreamina-cli.cjs");
const EXPECTED_MODELS = [
  "seedance2.0",
  "seedance2.0fast",
  "seedance2.0mini",
  "seedance2.0_vip",
  "seedance2.0fast_vip",
];

async function probeWithScenario(scenario: string, timeoutMs?: number) {
  const previousTestContext = process.env.NODE_TEST_CONTEXT;
  const previousTimeout = process.env.DREAMINA_CLI_TIMEOUT_MS;
  process.env.DREAMINA_FAKE_SCENARIO = scenario;
  if (timeoutMs !== undefined) {
    process.env.NODE_TEST_CONTEXT = previousTestContext || "dreamina-video-model-capabilities-round27";
    process.env.DREAMINA_CLI_TIMEOUT_MS = String(timeoutMs);
  }
  try {
    return await probeDreaminaCapabilities(FAKE_CLI);
  } finally {
    delete process.env.DREAMINA_FAKE_SCENARIO;
    if (previousTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousTestContext;
    if (previousTimeout === undefined) delete process.env.DREAMINA_CLI_TIMEOUT_MS;
    else process.env.DREAMINA_CLI_TIMEOUT_MS = previousTimeout;
  }
}

test("视频模型从 text2video help 的枚举值读取且排序稳定", async () => {
  const snapshot = await probeWithScenario("default");

  assert.deepEqual(snapshot.videoModels, EXPECTED_MODELS);
  assert.ok(snapshot.capabilities.includes("text2video"));
  assert.equal(snapshot.videoModels.includes("text2video"), false);
});

test("模型 help 未声明枚举值时 videoModels 回退内置五模型", async () => {
  const snapshot = await probeWithScenario("missing_model_values");

  assert.deepEqual(snapshot.videoModels, EXPECTED_MODELS);
});

for (const scenario of [
  "partial_model_values",
  "nonzero_with_partial_stdout",
  "similar_invalid_suffix",
]) {
  test(`${scenario} 不得采纳部分或相似模型枚举`, async () => {
    const snapshot = await probeWithScenario(scenario);

    assert.deepEqual(snapshot.videoModels, EXPECTED_MODELS);
  });
}

test("text2video help 超时且已有部分 stdout 时必须整体回退", async () => {
  const snapshot = await probeWithScenario("timeout_with_partial_stdout", 1_000);

  assert.deepEqual(snapshot.videoModels, EXPECTED_MODELS);
});
