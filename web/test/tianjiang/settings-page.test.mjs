import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const router = fs.readFileSync("src/router/index.ts", "utf8");
const workbench = fs.readFileSync("src/pages/workbench/index.vue", "utf8");
const settings = fs.readFileSync("src/views/settings/index.vue", "utf8");
const panel = fs.readFileSync("src/components/setting/index.vue", "utf8");

test("设置使用可深链独立路由且主入口只导航", () => {
  assert.match(router, /path:\s*"\/settings"/);
  assert.match(workbench, /router\.push\("\/settings"\)/);
  assert.doesNotMatch(workbench, /<setting\s*\/>/);
  assert.doesNotMatch(panel, /<t-dialog/);
});

test("设置页展示同步版本、状态、最后成功、失败原因和重试入口", () => {
  for (const label of ["配置版本", "同步状态", "最后成功", "失败原因", "重试同步"]) {
    assert.match(settings, new RegExp(label));
  }
  assert.match(settings, /retryProfileSync/);
});
