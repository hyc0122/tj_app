/**
 * Round27 能力目录 RED：模型、模式、help 退出状态和测试替身必须与真实 CLI 合同一致。
 * 全部命令只调用仓库 fake CLI，不接触真实即梦或收费接口。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  DREAMINA_MODES,
  DREAMINA_VIDEO_MODELS,
  type DreaminaCapabilitySnapshot,
} from "../../src/tianjiang/model-providers/dreamina-cli/contracts";
import {
  invalidateDreaminaCapabilityCache,
  writeDreaminaCapabilityCache,
} from "../../src/tianjiang/model-providers/dreamina-cli/capability-cache";
import { probeDreaminaCapabilities } from "../../src/tianjiang/model-providers/dreamina-cli/capability-probe";
import { listNativeDreaminaModels } from "../../src/tianjiang/model-providers/native-provider-registry";
import { createDreaminaCliProvider } from "../../src/tianjiang/model-providers/dreamina-cli/provider";
import { parseDreaminaVideoModel } from "../../src/tianjiang/storyboard/storyboard-generation-service";

const FAKE_CLI = path.resolve(__dirname, "fixtures", "fake-dreamina-cli.cjs");
const VIDEO_VALUES = [
  "dreamina-cli:seedance2.0",
  "dreamina-cli:seedance2.0fast",
  "dreamina-cli:seedance2.0mini",
  "dreamina-cli:seedance2.0_vip",
  "dreamina-cli:seedance2.0fast_vip",
] as const;

function readyCapability(): DreaminaCapabilitySnapshot {
  const fields = ["--prompt", "--duration", "--ratio", "--video_resolution", "--model_version"];
  return {
    installed: true,
    version: "1.4.15",
    probedAt: Date.now(),
    loggedIn: true,
    modes: Object.fromEntries(
      DREAMINA_MODES.map((mode) => [mode, { enabled: true, fields }]),
    ) as unknown as DreaminaCapabilitySnapshot["modes"],
    capabilities: DREAMINA_MODES,
    videoModels: DREAMINA_VIDEO_MODELS,
  };
}

async function withFakeScenario<T>(scenario: string, work: () => Promise<T>): Promise<T> {
  const previousScenario = process.env.DREAMINA_FAKE_SCENARIO;
  const previousTimeout = process.env.DREAMINA_CLI_TIMEOUT_MS;
  try {
    process.env.DREAMINA_FAKE_SCENARIO = scenario;
    process.env.DREAMINA_CLI_TIMEOUT_MS = "250";
    return await work();
  } finally {
    if (previousScenario === undefined) delete process.env.DREAMINA_FAKE_SCENARIO;
    else process.env.DREAMINA_FAKE_SCENARIO = previousScenario;
    if (previousTimeout === undefined) delete process.env.DREAMINA_CLI_TIMEOUT_MS;
    else process.env.DREAMINA_CLI_TIMEOUT_MS = previousTimeout;
  }
}

test("视频目录只公布五个 Seedance 模型，且每项都能被正式生成解析器接受", () => {
  invalidateDreaminaCapabilityCache();
  writeDreaminaCapabilityCache({ state: "ready", snapshot: readyCapability(), checkedAt: Date.now() });
  try {
    const items = listNativeDreaminaModels("video");
    assert.deepEqual(items.map((item) => item.value), VIDEO_VALUES);
    assert.equal(items.some((item) => /:(?:text2video|image2video|frames2video|multiframe2video|multimodal2video)$/.test(item.value)), false);
    assert.deepEqual(items.map((item) => parseDreaminaVideoModel(item.value)), [...DREAMINA_VIDEO_MODELS]);
    assert.ok(items.every((item) => item.modes.includes("text2video")), "模式必须是模型能力，不得再伪装成模型值");
  } finally {
    invalidateDreaminaCapabilityCache();
  }
});

test("视频目录只公布同时 enabled 且声明 model_version 的可执行模式", async () => {
  const snapshot = await withFakeScenario("model_version_text_only", () => probeDreaminaCapabilities(FAKE_CLI));
  assert.equal(snapshot.modes.text2video.enabled, true);
  assert.ok(snapshot.modes.text2video.fields.includes("--model_version"));
  for (const mode of DREAMINA_MODES.filter((item) => item.endsWith("video") && item !== "text2video")) {
    assert.equal(snapshot.modes[mode].enabled, true, `${mode} 必须复现 enabled 与字段不一致的真实快照`);
    assert.equal(snapshot.modes[mode].fields.includes("--model_version"), false);
  }

  writeDreaminaCapabilityCache({ state: "ready", snapshot, checkedAt: Date.now() });
  try {
    const items = listNativeDreaminaModels("video");
    assert.deepEqual(items.map((item) => item.value), VIDEO_VALUES);
    assert.ok(items.every((item) => item.disabled !== true));
    assert.deepEqual(items.map((item) => item.modes), VIDEO_VALUES.map(() => ["text2video"]));
  } finally {
    invalidateDreaminaCapabilityCache();
  }
});

test("真实探测虽将缺 model_version 的视频模式标为 enabled，目录仍必须保持五模型并整体禁用", async () => {
  const snapshot = await withFakeScenario("missing_video_model_version", () => probeDreaminaCapabilities(FAKE_CLI));
  const probedVideoModes = DREAMINA_MODES.filter((mode) => mode.endsWith("video"));
  for (const mode of probedVideoModes) {
    assert.equal(snapshot.modes[mode].enabled, true, `${mode} 必须复现 enabled 与字段不一致的真实快照`);
    assert.equal(snapshot.modes[mode].fields.includes("--model_version"), false);
  }

  writeDreaminaCapabilityCache({ state: "ready", snapshot, checkedAt: Date.now() });
  try {
    const items = listNativeDreaminaModels("video");
    assert.deepEqual(items.map((item) => item.value), VIDEO_VALUES, "模型 allowlist 不得退回生成模式名");
    assert.ok(items.every((item) => item.disabled !== true), "目录在新建项目中必须仍可选择");
    assert.ok(items.every((item) => item.modes.length > 0));
  } finally {
    invalidateDreaminaCapabilityCache();
  }
});

test("failed 缓存即使携带旧的完整快照也不得重新开放视频目录", () => {
  invalidateDreaminaCapabilityCache();
  writeDreaminaCapabilityCache({
    state: "failed",
    snapshot: readyCapability(),
    checkedAt: Date.now(),
    failureReason: "测试探测失败",
  });
  try {
    const items = listNativeDreaminaModels("video");
    assert.deepEqual(items.map((item) => item.value), VIDEO_VALUES);
    assert.ok(items.every((item) => item.disabled !== true));
    assert.ok(items.every((item) => item.modes.length > 0));
  } finally {
    invalidateDreaminaCapabilityCache();
  }
});

for (const scenario of [
  "top_help_nonzero_partial",
  "top_help_timeout_partial",
  "nonzero_with_partial_stdout",
  "timeout_with_partial_stdout",
] as const) {
  test(`${scenario} 的 partial stdout 不得启用任何不完整帮助能力`, async () => {
    const snapshot = await withFakeScenario(scenario, () => probeDreaminaCapabilities(FAKE_CLI));
    const affected = scenario.startsWith("top_help") ? DREAMINA_MODES : ["text2video"] as const;
    for (const mode of affected) {
      assert.equal(snapshot.modes[mode].enabled, false, `${scenario} 错误启用了 ${mode}`);
      assert.deepEqual(snapshot.modes[mode].fields, [], `${scenario} 必须丢弃 partial stdout 字段`);
    }
    if (scenario.startsWith("top_help")) assert.deepEqual(snapshot.capabilities, []);
  });
}

test("mode help 缺少 provider 无条件发送的 prompt 时必须 fail-closed", async () => {
  const snapshot = await withFakeScenario("missing_prompt_help", () => probeDreaminaCapabilities(FAKE_CLI));
  for (const mode of DREAMINA_MODES) {
    assert.equal(snapshot.modes[mode].enabled, false, `${mode} 缺少 --prompt 仍被启用`);
  }
  assert.deepEqual(snapshot.capabilities, []);
});

test("fake 默认严格接受多模态重复单数参数，并拒绝复数、未知和缺失参数", () => {
  const root = path.resolve(process.cwd(), "..", ".local", "t", `dreamina-fake-contract-${process.pid}`);
  fs.mkdirSync(root, { recursive: true });
  const run = (scenario: string, args: string[]) => spawnSync(process.execPath, [FAKE_CLI, ...args], {
    cwd: root,
    env: { ...process.env, DREAMINA_FAKE_SCENARIO: scenario },
    encoding: "utf8",
  });
  try {
    const valid = run("default", [
      "multimodal2video",
      "--prompt=电影感短片",
      "--image=a.png",
      "--image=b.png",
      "--video=c.mp4",
      "--audio=d.mp3",
      "--duration=5",
      "--model_version=seedance2.0fast",
    ]);
    assert.equal(valid.status, 0, valid.stderr || valid.stdout);

    const plural = run("default", [
      "multimodal2video",
      "--prompt=错误复数",
      "--images=a.png,b.png",
      "--duration=5",
      "--model_version=seedance2.0fast",
    ]);
    assert.equal(plural.status, 2);

    const unknown = run("default", [
      "multimodal2video",
      "--prompt=未知字段",
      "--image=a.png",
      "--duration=5",
      "--model_version=seedance2.0fast",
      "--unknown=1",
    ]);
    assert.equal(unknown.status, 2);

    const missing = run("default", [
      "multimodal2video",
      "--image=a.png",
      "--duration=5",
      "--model_version=seedance2.0fast",
    ]);
    assert.equal(missing.status, 2);

    const legacy = run("legacy_multimodal_plural", [
      "multimodal2video",
      "--prompt=旧版兼容夹具",
      "--images=a.png,b.png",
      "--duration=5",
      "--model_version=seedance2.0fast",
    ]);
    assert.equal(legacy.status, 0, legacy.stderr || legacy.stdout);

    for (const strictScenario of ["default", "submit_id"]) {
      const framesMissingPrompt = run(strictScenario, [
        "frames2video",
        "--first=a.png",
        "--last=b.png",
        "--duration=5",
      ]);
      assert.equal(framesMissingPrompt.status, 2, `${strictScenario} 必须拒绝 frames2video 缺 --prompt`);

      const framesMissingLast = run(strictScenario, [
        "frames2video",
        "--prompt=首尾过渡",
        "--first=a.png",
        "--duration=5",
      ]);
      assert.equal(framesMissingLast.status, 2, `${strictScenario} 必须拒绝 frames2video 缺 --last`);

      const multiframeMissingPrompt = run(strictScenario, [
        "multiframe2video",
        "--images=a.png,b.png",
        "--duration=3",
      ]);
      assert.equal(multiframeMissingPrompt.status, 2, `${strictScenario} 必须拒绝 multiframe2video 缺 --prompt`);

      const multiframeMissingImages = run(strictScenario, [
        "multiframe2video",
        "--prompt=多帧过渡",
        "--duration=3",
      ]);
      assert.equal(multiframeMissingImages.status, 2, `${strictScenario} 必须拒绝 multiframe2video 缺 --images`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fake 必须精确接受 text2image 的比例或成对宽高合同", () => {
  const root = path.resolve(process.cwd(), "..", ".local", "t", `dreamina-fake-dimensions-${process.pid}`);
  fs.mkdirSync(root, { recursive: true });
  const run = (scenario: string, args: string[]) => spawnSync(process.execPath, [FAKE_CLI, ...args], {
    cwd: root,
    env: { ...process.env, DREAMINA_FAKE_SCENARIO: scenario },
    encoding: "utf8",
  });
  try {
    for (const strictScenario of ["default", "submit_id"]) {
      const common = ["text2image", "--prompt=自定义尺寸", "--resolution_type=2K"];
      const actual = {
        pairedDimensions: run(strictScenario, [...common, "--width=1024", "--height=768"]).status,
        widthOnly: run(strictScenario, [...common, "--width=1024"]).status,
        heightOnly: run(strictScenario, [...common, "--height=768"]).status,
        ratioAndDimensions: run(strictScenario, [...common, "--ratio=4:3", "--width=1024", "--height=768"]).status,
      };
      assert.deepEqual(actual, {
        pairedDimensions: 0,
        widthOnly: 2,
        heightOnly: 2,
        ratioAndDimensions: 2,
      }, `${strictScenario} 必须接受 ratio 或成对 width/height，并拒绝不完整或互斥冲突`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("生产 provider 必须把多模态素材展开为真实 CLI 的重复单数参数", async () => {
  const root = path.resolve(process.cwd(), "..", ".local", "t", `dreamina-provider-flags-${process.pid}`);
  const projectRoot = path.join(root, "project");
  const stagingDirectory = path.join(root, "staging");
  const logFile = path.join(root, "calls.log");
  const previousScenario = process.env.DREAMINA_FAKE_SCENARIO;
  const previousLog = process.env.DREAMINA_FAKE_LOG;
  fs.mkdirSync(path.join(projectRoot, "files"), { recursive: true });
  fs.mkdirSync(stagingDirectory, { recursive: true });
  const paths = ["a.png", "b.png", "c.mp4", "d.mp3"].map((name) => path.join(projectRoot, "files", name));
  paths.forEach((filePath) => fs.writeFileSync(filePath, "fixture"));
  try {
    process.env.DREAMINA_FAKE_SCENARIO = "default";
    process.env.DREAMINA_FAKE_LOG = logFile;
    const provider = await createDreaminaCliProvider({ executablePath: FAKE_CLI, projectRoot, stagingDirectory });
    const result = await provider.submit({
      mode: "multimodal2video",
      prompt: "电影感短片",
      images: paths.slice(0, 2),
      videos: [paths[2]!],
      audios: [paths[3]!],
      duration: 5,
      modelVersion: "seedance2.0fast",
    });
    assert.equal(result.kind, "completed", JSON.stringify(result));
    const calls = fs.readFileSync(logFile, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line) as { args: string[] });
    const args = calls.find((call) => call.args[0] === "multimodal2video")?.args ?? [];
    assert.equal(args.filter((item) => item.startsWith("--image=")).length, 2);
    assert.equal(args.filter((item) => item.startsWith("--video=")).length, 1);
    assert.equal(args.filter((item) => item.startsWith("--audio=")).length, 1);
    assert.equal(args.some((item) => item.startsWith("--images=")), false);
  } finally {
    if (previousScenario === undefined) delete process.env.DREAMINA_FAKE_SCENARIO;
    else process.env.DREAMINA_FAKE_SCENARIO = previousScenario;
    if (previousLog === undefined) delete process.env.DREAMINA_FAKE_LOG;
    else process.env.DREAMINA_FAKE_LOG = previousLog;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
