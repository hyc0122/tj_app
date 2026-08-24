import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tianjiang-i18n-gate-"));
const localesDir = path.join(fixtureRoot, "locales");
const srcDir = path.join(fixtureRoot, "src");

before(() => {
  fs.mkdirSync(localesDir, { recursive: true });
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(
    path.join(localesDir, "zh-CN.json"),
    JSON.stringify({ login: { title: "登录" } }),
  );
  fs.writeFileSync(
    path.join(srcDir, "page.ts"),
    "export const label = t('login.missingAction')\n",
  );
});

after(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

test("i18n 严格门禁在使用缺失 key 时返回非零", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/findUnusedI18n.ts"],
    {
      cwd: webRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        I18N_CHECK_LOCALES_DIR: localesDir,
        I18N_CHECK_SRC_DIR: srcDir,
      },
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /login\.missingAction/);
});

test("i18n 严格门禁在所有 key 完整时返回零", () => {
  fs.writeFileSync(
    path.join(localesDir, "zh-CN.json"),
    JSON.stringify({ login: { missingAction: "继续" } }),
  );
  execFileSync(process.execPath, ["scripts/findUnusedI18n.ts"], {
    cwd: webRoot,
    stdio: "pipe",
    env: {
      ...process.env,
      I18N_CHECK_LOCALES_DIR: localesDir,
      I18N_CHECK_SRC_DIR: srcDir,
    },
  });
});

test("任一语言包缺少基准 key 时严格门禁返回非零", () => {
  fs.writeFileSync(
    path.join(localesDir, "zh-CN.json"),
    JSON.stringify({ login: { title: "登录", action: "继续" } }),
  );
  fs.writeFileSync(
    path.join(localesDir, "en.json"),
    JSON.stringify({ login: { title: "Login" } }),
  );
  fs.writeFileSync(path.join(srcDir, "page.ts"), "export const label = t('login.title')\n");
  const result = spawnSync(process.execPath, ["scripts/findUnusedI18n.ts"], {
    cwd: webRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      I18N_CHECK_LOCALES_DIR: localesDir,
      I18N_CHECK_SRC_DIR: srcDir,
      I18N_CHECK_BASELINE_LOCALE: "zh-CN",
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /en\.json.*login\.action/s);
});
