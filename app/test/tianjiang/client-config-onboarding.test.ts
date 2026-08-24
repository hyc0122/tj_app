import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { ClientConfigCache } from "../../src/tianjiang/client-config/cache";
import { PublicClientConfigClient } from "../../src/tianjiang/client-config/client";
import {
  PACKAGED_PUBLIC_CLIENT_CONFIG,
  parsePublicClientConfig,
  type PublicClientConfig,
} from "../../src/tianjiang/client-config/contracts";
import { CENTRAL_API_URL } from "../../src/tianjiang/auth/central-session";
import { OnboardingStore } from "../../src/tianjiang/client-state/onboarding-store";

function tempRoot(name: string): string {
  const root = path.join(process.cwd(), "..", ".tmp", `ops-${name}-${Date.now()}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

test("公开配置固定主机、ETag 缓存与降级", async () => {
  const root = tempRoot("cfg");
  try {
    const cache = new ClientConfigCache(root);
    const calls: string[] = [];
    let mode: "200" | "304" | "network" = "200";
    const config: PublicClientConfig = {
      ...PACKAGED_PUBLIC_CLIENT_CONFIG,
      configVersion: 2,
      onboarding: { guideRevision: 3, supportQrCodeUrl: "" },
      featureFlags: { ...PACKAGED_PUBLIC_CLIENT_CONFIG.featureFlags, developerOptions: true },
      updatePolicy: { ...PACKAGED_PUBLIC_CLIENT_CONFIG.updatePolicy, channel: "beta" },
    };
    const fetcher: typeof fetch = async (input, init) => {
      calls.push(String(input));
      if (mode === "network") throw new TypeError("offline");
      if (mode === "304") return new Response(null, { status: 304, headers: { etag: '"e1"' } });
      const headers = new Headers(init?.headers);
      if (mode === "200" && headers.get("if-none-match") === '"e1"') {
        return new Response(null, { status: 304, headers: { etag: '"e1"' } });
      }
      return new Response(JSON.stringify({ code: 0, data: config }), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"e1"' },
      });
    };
    const client = new PublicClientConfigClient(cache, fetcher);

    mode = "network";
    const packaged = await client.getLatest();
    assert.equal(packaged.source, "packaged");
    assert.equal(packaged.stale, true);

    mode = "200";
    const online = await client.getLatest();
    assert.equal(online.source, "network");
    assert.equal(online.config.configVersion, 2);
    assert.equal(online.config.onboarding.supportQrCodeUrl, "");
    assert.equal(online.config.featureFlags.developerOptions, true);
    assert.equal(online.config.updatePolicy.channel, "beta");
    assert.equal(calls.at(-1), `${CENTRAL_API_URL}/api/tianjiang/v1/public/client-config`);

    mode = "304";
    const cached = await client.getLatest();
    assert.equal(cached.source, "cache");
    assert.equal(cached.stale, false);

    mode = "network";
    const stale = await client.getLatest();
    assert.equal(stale.source, "cache");
    assert.equal(stale.stale, true);
    assert.equal(stale.config.onboarding.supportQrCodeUrl, "");
    assert.equal(stale.config.featureFlags.developerOptions, true);
    assert.equal(stale.config.updatePolicy.channel, "beta");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("引导状态按账号与设备隔离，提高 revision 后需重新完成", () => {
  const root = tempRoot("onb");
  try {
    const store = new OnboardingStore(root);
    const deviceA = "device-a-uuid-001";
    const deviceB = "device-b-uuid-002";
    store.put(12, deviceA, 3);
    assert.equal(store.get(12, deviceA)?.completedRevision, 3);
    assert.equal(store.get(12, deviceB), null);
    assert.equal(store.get(99, deviceA), null);
    // 后台提高 guideRevision 后 completedRevision 小于新值 → 重新显示
    const state = store.get(12, deviceA)!;
    assert.equal(state.completedRevision < 4, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("二维码地址只允许空值或 HTTPS URL", () => {
  assert.doesNotThrow(() => parsePublicClientConfig({
    ...PACKAGED_PUBLIC_CLIENT_CONFIG,
    onboarding: { ...PACKAGED_PUBLIC_CLIENT_CONFIG.onboarding, supportQrCodeUrl: "" },
  }));
  assert.throws(() => parsePublicClientConfig({
    ...PACKAGED_PUBLIC_CLIENT_CONFIG,
    onboarding: {
      ...PACKAGED_PUBLIC_CLIENT_CONFIG.onboarding,
      supportQrCodeUrl: "http://cdn.example.com/support.png",
    },
  }));
});

test("旧响应缺少 support 时整份配置仍可用并降级 feedbackUrl", () => {
  const { support: _omit, ...legacy } = PACKAGED_PUBLIC_CLIENT_CONFIG as PublicClientConfig & {
    support?: { feedbackUrl: string };
  };
  // 模拟旧服务器：无 support 字段
  const parsed = parsePublicClientConfig(legacy);
  assert.equal(parsed.configVersion, PACKAGED_PUBLIC_CLIENT_CONFIG.configVersion);
  assert.equal(parsed.featureFlags.checkUpdates, true);
  assert.equal(
    parsed.support.feedbackUrl,
    PACKAGED_PUBLIC_CLIENT_CONFIG.support.feedbackUrl,
  );
});

test("网络响应含 support.feedbackUrl、304 与缓存、网络失败降级", async () => {
  const root = tempRoot("cfg-support");
  try {
    const cache = new ClientConfigCache(root);
    let mode: "200" | "304" | "network" | "legacy" = "legacy";
    const networkConfig: PublicClientConfig = {
      ...PACKAGED_PUBLIC_CLIENT_CONFIG,
      configVersion: 8,
      support: {
        feedbackUrl: "https://docs.qq.com/form/from-network?tab=1",
      },
    };
    // 旧响应：其余字段完整，仅缺 support
    const { support: _s, ...legacyBody } = networkConfig;
    const fetcher: typeof fetch = async () => {
      if (mode === "network") throw new TypeError("offline");
      if (mode === "304") return new Response(null, { status: 304, headers: { etag: '"s1"' } });
      if (mode === "legacy") {
        return new Response(JSON.stringify({ code: 0, data: legacyBody }), {
          status: 200,
          headers: { "content-type": "application/json", etag: '"legacy"' },
        });
      }
      return new Response(JSON.stringify({ code: 0, data: networkConfig }), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"s1"' },
      });
    };
    const client = new PublicClientConfigClient(cache, fetcher);

    const legacy = await client.getLatest();
    assert.equal(legacy.source, "network");
    assert.equal(legacy.config.support.feedbackUrl, PACKAGED_PUBLIC_CLIENT_CONFIG.support.feedbackUrl);
    assert.equal(legacy.config.configVersion, 8);

    mode = "200";
    const online = await client.getLatest();
    assert.equal(online.source, "network");
    assert.equal(online.config.support.feedbackUrl, "https://docs.qq.com/form/from-network?tab=1");

    mode = "304";
    const cached = await client.getLatest();
    assert.equal(cached.source, "cache");
    assert.equal(cached.stale, false);
    assert.equal(cached.config.support.feedbackUrl, "https://docs.qq.com/form/from-network?tab=1");

    mode = "network";
    const stale = await client.getLatest();
    assert.equal(stale.source, "cache");
    assert.equal(stale.stale, true);
    assert.equal(stale.config.support.feedbackUrl, "https://docs.qq.com/form/from-network?tab=1");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
