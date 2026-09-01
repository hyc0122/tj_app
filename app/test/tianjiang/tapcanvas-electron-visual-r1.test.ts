import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const SENTINEL = "RED_EXPECTED:TAPCANVAS_ELECTRON_VISUAL";
const ROOT = path.resolve(process.cwd(), "..");

test("Electron 视觉验收必须调用真实产品交互，禁止脚本伪造确认框", () => {
  const mainScript = fs.readFileSync(
    path.join(ROOT, "app/test/tianjiang/helpers/tapcanvas-electron-visual-main.cjs"),
    "utf8",
  );
  const visualHooks = fs.readFileSync(
    path.join(ROOT, "web/tapcanvas/src/tianjiang/visualHooks.ts"),
    "utf8",
  );
  const brandMark = fs.readFileSync(
    path.join(ROOT, "web/tapcanvas/src/ui/brand/TapCanvasMark.tsx"),
    "utf8",
  );

  assert.match(mainScript, /tianjiangVisualAcceptance=1/);
  assert.match(mainScript, /window\.__tjVisual\?\.openConfirm/);
  assert.match(mainScript, /window\.__tcExpandChat\?\.\(\)/);
  assert.match(mainScript, /tc-ai-chat--expanded/);
  assert.match(mainScript, /feature-tour-skip/);
  assert.doesNotMatch(mainScript, /createElement\(['"]div['"]\)/);
  assert.match(visualHooks, /tianjiangVisualAcceptance/);
  assert.match(visualHooks, /127\.0\.0\.1|localhost/);
  assert.match(visualHooks, /__tcExpandChat/);
  assert.match(brandMark, /import\.meta\.env\.BASE_URL/);
  assert.doesNotMatch(brandMark, /src=["']\/tapcanvas-mark\.svg/);
});

test("真实 Electron BrowserWindow 必须截取首页、空画布、节点、右侧 AI 与确认执行", { skip: process.env.TAPCANVAS_VISUAL !== "1" }, () => {
  const dist = path.join(ROOT, "web/dist/tapcanvas/index.html");
  if (!fs.existsSync(dist)) {
    console.error(SENTINEL);
    assert.fail(`${SENTINEL}: missing ${dist}`);
  }
  const script = path.join(ROOT, "app/scripts/tapcanvas-electron-visual.mjs");
  const result = spawnSync(process.execPath, [script], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status !== 0) {
    console.error(SENTINEL);
    console.error(result.stdout);
    console.error(result.stderr);
  }
  assert.equal(result.status, 0, SENTINEL);
  const outDir = path.join(ROOT, ".local/tapcanvas-visual");
  for (const name of ["01-home.png", "02-empty-canvas.png", "03-nodes-canvas.png", "04-right-ai.png", "05-paid-confirm.png"]) {
    const file = path.join(outDir, name);
    assert.equal(fs.existsSync(file), true, `${SENTINEL}:${name}`);
    assert.ok(fs.statSync(file).size > 1000, `${SENTINEL}:${name} empty`);
  }
});
