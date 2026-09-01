import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SENTINEL = "RED_EXPECTED:WEB_CANVAS_I18N";
const FILES = [
  "zh-CN.json",
  "zh-TW.json",
  "en.json",
  "ja_JP.json",
  "ru_RU.json",
  "th_TH.json",
  "vi-VN.json",
];

function flatten(value, prefix = "") {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return { [prefix]: value };
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => Object.entries(flatten(item, prefix ? `${prefix}.${key}` : key))),
  );
}

test("七语言 infiniteCanvas key 集必须完全一致且非空", () => {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/locales/language");
  const packs = FILES.map((name) => {
    const json = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    if (!json.infiniteCanvas || typeof json.infiniteCanvas !== "object") {
      console.error(SENTINEL);
      assert.fail(SENTINEL);
    }
    return { name, map: flatten(json.infiniteCanvas) };
  });
  const baseline = Object.keys(packs[0].map).sort();
  if (baseline.length === 0) {
    console.error(SENTINEL);
    assert.fail(SENTINEL);
  }
  for (const pack of packs) {
    const keys = Object.keys(pack.map).sort();
    const empty = Object.entries(pack.map).filter(([, text]) => typeof text !== "string" || text.trim() === "");
    if (keys.join(",") !== baseline.join(",") || empty.length !== 0) {
      console.error(SENTINEL);
      assert.deepEqual(keys, baseline, SENTINEL);
      assert.equal(empty.length, 0, SENTINEL);
    }
  }
});
