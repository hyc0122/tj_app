import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SENTINEL = "RED_EXPECTED:WEB_CANVAS_AI_I18N";
const FILES = [
  "zh-CN.json",
  "zh-TW.json",
  "en.json",
  "ja_JP.json",
  "ru_RU.json",
  "th_TH.json",
  "vi-VN.json",
];
const REQUIRED = [
  "ai.greeting",
  "ai.newChat",
  "ai.history",
  "ai.collapse",
  "ai.fullscreen",
  "ai.restore",
  "ai.placeholder",
  "ai.send",
  "ai.voice",
  "ai.skill",
  "ai.model",
  "ai.applyPlan",
  "ai.waitingOrigin",
  "ai.cancelOnOrigin",
  "execution.desk",
  "execution.confirm",
  "execution.preview",
  "execution.fee",
  "execution.failure",
  "execution.waitingForOriginDevice",
  "execution.queued",
  "execution.running",
];

function flatten(value, prefix = "") {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return { [prefix]: value };
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => Object.entries(flatten(item, prefix ? `${prefix}.${key}` : key))),
  );
}

test("七语言必须包含 AI 面板与执行台 key 且文案非空一致", () => {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/locales/language");
  const packs = FILES.map((name) => {
    const json = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    if (!json.infiniteCanvas || typeof json.infiniteCanvas !== "object") {
      console.error(SENTINEL);
      assert.fail(SENTINEL);
    }
    return { name, map: flatten(json.infiniteCanvas) };
  });
  for (const pack of packs) {
    const missing = REQUIRED.filter((key) => typeof pack.map[key] !== "string" || pack.map[key].trim() === "");
    if (missing.length !== 0) {
      console.error(SENTINEL);
      assert.deepEqual(missing, [], SENTINEL);
    }
  }
  const baseline = Object.keys(packs[0].map).sort();
  for (const pack of packs) {
    const keys = Object.keys(pack.map).sort();
    if (keys.join(",") !== baseline.join(",")) {
      console.error(SENTINEL);
      assert.deepEqual(keys, baseline, SENTINEL);
    }
  }
});
