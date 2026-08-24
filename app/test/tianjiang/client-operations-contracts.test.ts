import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

import {
  PACKAGED_PUBLIC_CLIENT_CONFIG,
  parsePublicClientConfig,
} from "../../src/tianjiang/client-config/contracts";
import {
  parseOnboardingState,
  parsePutOnboardingBody,
} from "../../src/tianjiang/client-state/contracts";
import {
  MANUAL_UPDATE_ACTIONS,
  parseManualUpdateActionBody,
  parseManualUpdateSnapshot,
} from "../../src/tianjiang/update/manual-update-contracts";

const valid = PACKAGED_PUBLIC_CLIENT_CONFIG;

test("公开客户端配置严格解析 featureFlags 与 channel", () => {
  assert.equal(parsePublicClientConfig(valid).featureFlags.checkUpdates, true);
  assert.throws(
    () => parsePublicClientConfig({
      ...valid,
      updatePolicy: { enabled: true, channel: "evil", manualDownloadOnly: true },
    }),
  );
  assert.throws(
    () => parsePublicClientConfig({ ...valid, extra: true }),
  );
});

test("引导状态与 PUT body 校验", () => {
  const state = parseOnboardingState({
    businessUserId: 12,
    deviceUuid: "018f3d6e-2d9e-7b6c-8a9b-1234567890ab",
    completedRevision: 2,
    completedAt: "2026-08-01T12:00:00+08:00",
  });
  assert.equal(state.completedRevision, 2);
  assert.equal(parsePutOnboardingBody({ completedRevision: 3 }).completedRevision, 3);
  assert.throws(() => parsePutOnboardingBody({ completedRevision: -1 }));
});

test("手动更新动作冻结且拒绝 URL 字段", () => {
  assert.deepEqual(MANUAL_UPDATE_ACTIONS, [
    "check",
    "check-login-stable",
    "download-differential",
    "download-full",
    "install",
    "show-file",
  ]);
  assert.equal(parseManualUpdateActionBody({ action: "check" }).action, "check");
  assert.deepEqual(
    parseManualUpdateActionBody({ action: "download-full", channel: "stable" }),
    { action: "download-full", channel: "stable" },
  );
  assert.throws(() => parseManualUpdateActionBody({ action: "download-full" }));
  assert.throws(() => parseManualUpdateActionBody({ action: "check", url: "https://evil" }));
  assert.throws(() => parseManualUpdateActionBody({ action: "check", feedBaseUrl: "x" }));
  const snap = parseManualUpdateSnapshot({
    state: "idle",
    currentVersion: "1.1.9",
    stable: { status: "idle", source: "none", required: false, downloadAllowed: false },
    beta: { status: "idle", source: "none", required: false, downloadAllowed: false },
    stableRequired: false,
    loginAllowed: true,
    selectedChannel: null,
  });
  assert.equal(snap.state, "idle");
});

test("服务 bundle 导出 updater 绑定函数且主进程不再加载 src 路由", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "app.ts"), "utf8");
  const mainSource = fs.readFileSync(path.join(process.cwd(), "scripts", "main.ts"), "utf8");
  assert.match(appSource, /export function bindManualUpdateService/);
  assert.match(mainSource, /mod\.bindManualUpdateService\?\.\(service\)/);
  assert.doesNotMatch(mainSource, /src["'],\s*["']routes["'],\s*["']setting["'],\s*["']about/);
});

test("支持平台 updater 在创建 Renderer 窗口前完成绑定，失败态也显式绑定", () => {
  const mainSource = fs.readFileSync(path.join(process.cwd(), "scripts", "main.ts"), "utf8");
  const createWindowIndex = mainSource.indexOf("await createMainWindow();");
  const bindIndex = mainSource.indexOf("mod.bindManualUpdateService?.(service)");
  assert.ok(bindIndex >= 0 && bindIndex < createWindowIndex, "updater 必须先绑定，再让 Renderer 可登录");
  assert.match(mainSource, /bindManualUpdateServiceFailed|failManualUpdateService|state:\s*["']failed["']/);
});

test("主进程安装接线等待 shell.openPath 成功后才受控调度退出", () => {
  const mainSource = fs.readFileSync(path.join(process.cwd(), "scripts", "main.ts"), "utf8");
  assert.match(mainSource, /launchVerifiedInstaller/);
  assert.match(mainSource, /shell\.openPath/);
  assert.match(mainSource, /scheduleApplicationQuit/);
  assert.match(mainSource, /setImmediate\(\(\)\s*=>\s*app\.quit\(\)\)/);
  assert.doesNotMatch(mainSource, /quitAndInstall/);
});
