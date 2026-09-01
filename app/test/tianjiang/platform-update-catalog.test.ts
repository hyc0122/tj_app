import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  PLATFORM_CATALOG_ENDPOINTS,
  PlatformReleaseCatalogClient,
  parsePlatformReleaseEntry,
} from "../../src/tianjiang/update/platform-release-catalog";
import {
  parsePlatformLatest,
  parsePlatformRelease,
} from "../../scripts/platform-release-contract.mjs";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function documents(channel: "stable" | "beta", version = channel === "stable" ? "1.1.11" : "1.1.12-beta.1") {
  const prefix = `desktop/${channel}/windows/x64`;
  const sourceChannel = channel === "stable" ? "stable" : "beta";
  const installerName = `tianjiang-${version}-win-x64-setup.exe`;
  const latest = {
    schemaVersion: 2,
    channel,
    platform: "windows",
    arch: "x64",
    version,
    release: `${prefix}/catalog/releases/${version}/release.json`,
  };
  const release = {
    schemaVersion: 2,
    channel,
    sourceChannel,
    platform: "windows",
    arch: "x64",
    version,
    tag: `v${version}`,
    commitSha: "a".repeat(40),
    nativeMetadata: `${prefix}/latest.yml`,
    artifacts: [
      {
        path: `${prefix}/${installerName}`,
        fileName: installerName,
        kind: "installer",
        size: 18,
        sha256: sha256("installer-content"),
      },
      {
        path: `${prefix}/${installerName}.blockmap`,
        fileName: `${installerName}.blockmap`,
        kind: "blockmap",
        size: 16,
        sha256: sha256("blockmap-content"),
      },
    ],
  };
  return { latest, release };
}

function createCatalogFetch(
  overrides: Partial<Record<string, Response>> = {},
  seen: Array<{ url: string; init?: RequestInit }> = [],
) {
  const stable = documents("stable");
  const beta = documents("beta");
  const responses = new Map<string, Response>([
    [PLATFORM_CATALOG_ENDPOINTS.stable, Response.json(stable.latest)],
    [`https://cdn.j11.com.cn/${stable.latest.release}`, Response.json(stable.release)],
    [PLATFORM_CATALOG_ENDPOINTS.beta, Response.json(beta.latest)],
    [`https://cdn.j11.com.cn/${beta.latest.release}`, Response.json(beta.release)],
  ]);
  for (const [url, response] of Object.entries(overrides)) {
    if (response) responses.set(url, response);
  }
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, init });
    const response = responses.get(url);
    if (!response) throw new Error(`未配置 fake 响应：${url}`);
    return response.clone();
  };
}

test("客户端端点只允许 cdn.j11.com.cn 的 Stable/Beta Windows x64 latest", () => {
  assert.deepEqual(PLATFORM_CATALOG_ENDPOINTS, {
    stable: "https://cdn.j11.com.cn/desktop/stable/windows/x64/catalog/latest.json",
    beta: "https://cdn.j11.com.cn/desktop/beta/windows/x64/catalog/latest.json",
  });
});

test("Catalog 客户端逐层读取 latest 和 release，且与 Task 1 合同使用同一规范结果", async () => {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const stable = documents("stable");
  const client = new PlatformReleaseCatalogClient({ fetcher: createCatalogFetch({}, seen) as typeof fetch });

  const entry = await client.fetchChannel("stable");
  const task1Latest = parsePlatformLatest(stable.latest, {
    channel: "stable", platform: "windows", arch: "x64",
  });
  const task1Release = parsePlatformRelease(stable.release, {
    channel: "stable", platform: "windows", arch: "x64",
  });

  assert.deepEqual(entry.latest, task1Latest);
  assert.deepEqual(entry.release, task1Release);
  assert.deepEqual(parsePlatformReleaseEntry(entry, "stable"), entry);
  assert.equal(seen.length, 2);
  assert.equal(seen.every(({ init }) => init?.redirect === "manual"), true);
  assert.equal(seen.every(({ init }) => init?.signal instanceof AbortSignal), true);
});

test("Catalog 拒绝非法 Schema、平台架构和未知字段", async (t) => {
  const stable = documents("stable");
  const cases: Array<[string, unknown, RegExp]> = [
    ["schema", { ...stable.latest, schemaVersion: 1 }, /schemaVersion/],
    ["platform", { ...stable.latest, platform: "linux" }, /平台|架构/],
    ["arch", { ...stable.latest, arch: "arm64" }, /平台|架构/],
    ["unknown", { ...stable.latest, catalogUrl: "https://evil.example/latest.json" }, /未知字段|严格/],
  ];
  for (const [name, latest, expected] of cases) {
    await t.test(name, async () => {
      const client = new PlatformReleaseCatalogClient({
        fetcher: createCatalogFetch({
          [PLATFORM_CATALOG_ENDPOINTS.stable]: Response.json(latest),
        }) as typeof fetch,
      });
      await assert.rejects(() => client.fetchChannel("stable"), expected);
    });
  }
});

test("Catalog 拒绝跨域、协议降级、userinfo、端口和通道路径越界重定向", async (t) => {
  const locations = [
    "https://evil.example/desktop/stable/windows/x64/catalog/latest.json",
    "http://cdn.j11.com.cn/desktop/stable/windows/x64/catalog/latest.json",
    "https://user@cdn.j11.com.cn/desktop/stable/windows/x64/catalog/latest.json",
    "https://cdn.j11.com.cn:8443/desktop/stable/windows/x64/catalog/latest.json",
    "https://cdn.j11.com.cn/desktop/beta/windows/x64/catalog/latest.json",
  ];
  for (const location of locations) {
    await t.test(location, async () => {
      const client = new PlatformReleaseCatalogClient({
        fetcher: createCatalogFetch({
          [PLATFORM_CATALOG_ENDPOINTS.stable]: new Response(null, {
            status: 302,
            headers: { location },
          }),
        }) as typeof fetch,
      });
      await assert.rejects(() => client.fetchChannel("stable"), /重定向|HTTPS|端口|userinfo|通道|路径/);
    });
  }
});

test("release 和 artifact 路径不能注入 URL，且必须具备唯一安装包与 blockmap", async (t) => {
  const stable = documents("stable");
  const cases: Array<[string, unknown]> = [
    ["release-url", { ...stable.latest, release: "https://evil.example/release.json" }],
    ["artifact-url", {
      ...stable.release,
      artifacts: stable.release.artifacts.map((artifact, index) => index === 0
        ? { ...artifact, path: "https://evil.example/setup.exe" }
        : artifact),
    }],
    ["missing-blockmap", { ...stable.release, artifacts: [stable.release.artifacts[0]] }],
  ];
  for (const [name, raw] of cases) {
    await t.test(name, async () => {
      const override = name === "release-url"
        ? { [PLATFORM_CATALOG_ENDPOINTS.stable]: Response.json(raw) }
        : { [`https://cdn.j11.com.cn/${stable.latest.release}`]: Response.json(raw) };
      const client = new PlatformReleaseCatalogClient({ fetcher: createCatalogFetch(override) as typeof fetch });
      await assert.rejects(() => client.fetchChannel("stable"), /release|artifact|安装包|blockmap|路径/);
    });
  }
});

test("release 完整校验来源、版本、Tag、Commit、大小与 SHA-256", async (t) => {
  const stable = documents("stable");
  const cases: Array<[string, unknown, RegExp]> = [
    ["source-channel", { ...stable.release, sourceChannel: "beta" }, /sourceChannel|stable/],
    ["version", { ...stable.release, version: "1.1.12", tag: "v1.1.12" }, /版本.*不一致|路径/],
    ["tag", { ...stable.release, tag: "v9.9.9" }, /tag/],
    ["commit", { ...stable.release, commitSha: "A".repeat(40) }, /commitSha/],
    ["size", {
      ...stable.release,
      artifacts: stable.release.artifacts.map((artifact, index) => index === 0
        ? { ...artifact, size: 0 }
        : artifact),
    }, /大小|size/],
    ["sha256", {
      ...stable.release,
      artifacts: stable.release.artifacts.map((artifact, index) => index === 0
        ? { ...artifact, sha256: "0" }
        : artifact),
    }, /sha256/],
  ];
  for (const [name, release, expected] of cases) {
    await t.test(name, async () => {
      const client = new PlatformReleaseCatalogClient({
        fetcher: createCatalogFetch({
          [`https://cdn.j11.com.cn/${stable.latest.release}`]: Response.json(release),
        }) as typeof fetch,
      });
      await assert.rejects(() => client.fetchChannel("stable"), expected);
    });
  }
});

test("所有响应有大小上限，超时时通过 fake clock 取消请求", async () => {
  const oversized = new PlatformReleaseCatalogClient({
    maxResponseBytes: 64,
    fetcher: createCatalogFetch({
      [PLATFORM_CATALOG_ENDPOINTS.stable]: new Response("{}", {
        headers: { "content-length": "65" },
      }),
    }) as typeof fetch,
  });
  await assert.rejects(() => oversized.fetchChannel("stable"), /响应过大/);

  let timeoutHandler: (() => void) | undefined;
  let aborted = false;
  const pendingFetch = (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      aborted = true;
      reject(new Error("aborted"));
    });
  });
  const client = new PlatformReleaseCatalogClient({
    fetcher: pendingFetch as typeof fetch,
    clock: {
      setTimeout(handler) { timeoutHandler = handler; return 1; },
      clearTimeout() {},
    },
  });
  const request = client.fetchChannel("stable");
  assert.ok(timeoutHandler);
  timeoutHandler();
  await assert.rejects(() => request, /超时|aborted/);
  assert.equal(aborted, true);
});

test("3xx、非成功响应和声明超限在抛错前显式取消 body", async (t) => {
  const cases = [
    { name: "redirect", status: 302, headers: { location: "https://evil.example/escape" }, expected: /重定向|HTTPS/ },
    { name: "http-error", status: 503, headers: {}, expected: /HTTP 503/ },
    { name: "oversized", status: 200, headers: { "content-length": "65" }, expected: /响应过大/ },
  ] as const;
  for (const item of cases) {
    await t.test(item.name, async () => {
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull() {},
        cancel() { cancelled = true; },
      });
      const response = new Response(stream, { status: item.status, headers: item.headers });
      const client = new PlatformReleaseCatalogClient({
        maxResponseBytes: 64,
        fetcher: (async () => response) as typeof fetch,
      });
      await assert.rejects(() => client.fetchChannel("stable"), item.expected);
      assert.equal(cancelled, true);
    });
  }
});
