/**
 * Round27 RED：桌面协议必须使用小写主机，并等待受信任外链真正交给默认浏览器。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  DREAMINA_EXTERNAL_PROTOCOL_HOST,
  normalizeDesktopProtocolHost,
  openDreaminaDesktopExternal,
  settleDesktopProtocolAction,
} from "../../src/tianjiang/model-providers/dreamina-cli/desktop-external-opener";

const appRoot = path.resolve(__dirname, "../..");
const repositoryRoot = path.resolve(appRoot, "..");
const protocolPreload = path.join(
  __dirname,
  "fixtures",
  "dreamina-main-protocol-preload.cjs",
);
let probeSequence = 0;

interface ProtocolProbeEvent {
  name: string;
  key?: string;
  status?: number;
  body?: string;
  elapsedMs?: number;
  origin?: string;
  scheme?: string;
}

function runMainProtocolProbe(scenario: string): ProtocolProbeEvent[] {
  const evidenceRoot = path.join(repositoryRoot, ".tmp", "dreamina-protocol-round27");
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const eventFile = path.join(
    evidenceRoot,
    `${process.pid}-${probeSequence += 1}-${scenario}.jsonl`,
  );
  fs.rmSync(eventFile, { force: true });
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--require",
      protocolPreload,
      path.join(appRoot, "scripts", "main.ts"),
    ],
    {
      cwd: appRoot,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        NODE_ENV: "prod",
        TIANJIANG_PROTOCOL_PROBE_EVENT_FILE: eventFile,
        TIANJIANG_PROTOCOL_PROBE_SCENARIO: scenario,
      },
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return fs.readFileSync(eventFile, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ProtocolProbeEvent);
}

function protocolResponse(
  events: ProtocolProbeEvent[],
  key: string,
): ProtocolProbeEvent & { body: string } {
  const event = events.find((candidate) =>
    candidate.name === "protocol.response" && candidate.key === key);
  assert.ok(event?.body, `缺少 ${key} 的真实协议响应`);
  return event as ProtocolProbeEvent & { body: string };
}

test("桌面协议主机必须统一为小写 handler key", () => {
  assert.equal(DREAMINA_EXTERNAL_PROTOCOL_HOST, "opendreaminaexternal");
  assert.equal(
    normalizeDesktopProtocolHost("openDreaminaExternal"),
    DREAMINA_EXTERNAL_PROTOCOL_HOST,
  );
});

test("官方文档和官方授权地址必须交给默认浏览器并等待完成", async () => {
  const opened: string[] = [];
  const openExternal = async (url: string): Promise<void> => {
    await Promise.resolve();
    opened.push(url);
  };

  await assert.doesNotReject(() => openDreaminaDesktopExternal(
    { kind: "official_docs" },
    openExternal,
  ));
  await assert.doesNotReject(() => openDreaminaDesktopExternal(
    { kind: "authorization", url: "https://jimeng.jianying.com/auth?x=1" },
    openExternal,
  ));

  assert.deepEqual(opened, [
    "https://bytedance.larkoffice.com/wiki/FVTwwm0bGiishxkKOoScdHR2nsg",
    "https://jimeng.jianying.com/auth?x=1",
  ]);
});

test("不可信授权地址必须在调用浏览器前被拒绝", async () => {
  let openCalls = 0;
  await assert.rejects(
    () => openDreaminaDesktopExternal(
      { kind: "authorization", url: "https://jimeng.jianying.com.evil/auth" },
      async () => {
        openCalls += 1;
      },
    ),
    /白名单/,
  );
  assert.equal(openCalls, 0);
});

test("默认浏览器异步拒绝必须被等待并映射为明确且脱敏的失败", async () => {
  const authorizationUrl = "https://jimeng.jianying.com/auth?user_code=ABCD-1234";
  await assert.rejects(
    () => openDreaminaDesktopExternal(
      { kind: "authorization", url: authorizationUrl },
      async () => {
        await Promise.resolve();
        throw new Error("no browser");
      },
    ),
    /无法调用默认浏览器/,
  );

  const response = await settleDesktopProtocolAction(() => openDreaminaDesktopExternal(
    { kind: "authorization", url: authorizationUrl },
    async () => {
      throw new Error("no browser");
    },
  ));
  assert.equal(response.status, 502);
  assert.deepEqual(response.body, { ok: false, error: "无法调用默认浏览器" });
  assert.doesNotMatch(JSON.stringify(response), /ABCD-1234|jimeng\.jianying\.com/);
});

test("真实 Electron 协议 callback 必须命中驼峰 URL 并保持同步 handler 成功体", () => {
  const events = runMainProtocolProbe("success");
  assert.ok(events.some((event) =>
    event.name === "protocol.handle" && event.scheme === "tianjiang"));

  assert.deepEqual(
    JSON.parse(protocolResponse(events, "official_docs").body),
    { ok: true },
  );
  assert.deepEqual(
    JSON.parse(protocolResponse(events, "authorization").body),
    { ok: true },
  );
  assert.deepEqual(
    JSON.parse(protocolResponse(events, "windowismaximized").body),
    { maximized: false },
  );
  assert.deepEqual(
    JSON.parse(protocolResponse(events, "getlocallanguage").body),
    { ok: true, local: "zh-CN" },
  );
  assert.deepEqual(
    events.filter((event) => event.name === "openExternal").map((event) => event.origin),
    ["https://bytedance.larkoffice.com", "https://jimeng.jianying.com"],
  );
});

test("真实 Electron 协议 callback 必须等待默认浏览器 rejection 并安全返回 502", () => {
  const events = runMainProtocolProbe("external_reject");
  const response = protocolResponse(events, "external_reject");
  assert.equal(response.status, 502);
  assert.ok((response.elapsedMs ?? 0) >= 50, "必须等待 delayed openExternal rejection");
  assert.deepEqual(JSON.parse(response.body), {
    ok: false,
    error: "无法调用默认浏览器",
  });
  assert.doesNotMatch(
    JSON.stringify(events),
    /ABCD-1234|C:\\Users\\secret|底层浏览器失败/,
  );
});

test("普通同步 handler 异常必须固定脱敏，不能回显路径、URL 或 user_code", () => {
  const events = runMainProtocolProbe("sync_error");
  const response = protocolResponse(events, "sync_error");
  assert.equal(response.status, 502);
  assert.deepEqual(JSON.parse(response.body), {
    ok: false,
    error: "桌面操作失败",
  });
  assert.doesNotMatch(
    JSON.stringify(events),
    /C:\\Users\\secret|user_code=ABCD|evil\.example/,
  );
});
