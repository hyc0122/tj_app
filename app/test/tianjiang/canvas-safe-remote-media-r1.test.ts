import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const SENTINEL = "RED_EXPECTED:CANVAS_SAFE_REMOTE_MEDIA";
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);

test("安全下载器必须固定已校验公网 IP、保持 Host/SNI，并拒绝 DNS rebinding/私网/代理绕过", async () => {
  const target = path.resolve(
    __dirname,
    "../../src/tianjiang/media/safe-remote-media.ts",
  );
  let src = "";
  try {
    src = fs.readFileSync(target, "utf8");
  } catch {
    console.error(SENTINEL);
    assert.fail(SENTINEL);
  }
  const required = [
    "downloadSafeRemoteMedia",
    "servername",
    "isBlockedRemoteIp",
    "HTTPS_PROXY",
    "maxRedirects",
  ];
  const missing = required.filter((token) => !src.includes(token));
  if (missing.length !== 0) {
    console.error(SENTINEL);
    assert.deepEqual(missing, [], SENTINEL);
  }
  const media = await import("../../src/tianjiang/media/safe-remote-media");
  if (typeof media.downloadSafeRemoteMedia !== "function" || typeof media.isBlockedRemoteIp !== "function") {
    console.error(SENTINEL);
    assert.equal(typeof media.downloadSafeRemoteMedia, "function", SENTINEL);
  }
  assert.equal(media.isBlockedRemoteIp("127.0.0.1"), true, SENTINEL);
  assert.equal(media.isBlockedRemoteIp("10.0.0.1"), true, SENTINEL);
  assert.equal(media.isBlockedRemoteIp("192.168.1.1"), true, SENTINEL);
  assert.equal(media.isBlockedRemoteIp("172.16.0.1"), true, SENTINEL);
  assert.equal(media.isBlockedRemoteIp("169.254.1.1"), true, SENTINEL);
  assert.equal(media.isBlockedRemoteIp("100.64.1.1"), true, SENTINEL);
  assert.equal(media.isBlockedRemoteIp("0.0.0.0"), true, SENTINEL);
  assert.equal(media.isBlockedRemoteIp("255.255.255.255"), true, SENTINEL);
  assert.equal(media.isBlockedRemoteIp("::1"), true, SENTINEL);
  assert.equal(media.isBlockedRemoteIp("fc00::1"), true, SENTINEL);
  assert.equal(media.isBlockedRemoteIp("fe80::1"), true, SENTINEL);
  assert.equal(media.isBlockedRemoteIp("2001:db8::1"), true, SENTINEL);
  assert.equal(media.isBlockedRemoteIp("::ffff:127.0.0.1"), true, SENTINEL);
  assert.equal(media.isBlockedRemoteIp("0:0:0:0:0:ffff:7f00:1"), true, SENTINEL);
  assert.equal(media.isBlockedRemoteIp("0:0:0:0:0:ffff:a00:1"), true, SENTINEL);
  assert.equal(media.isBlockedRemoteIp("8.8.8.8"), false, SENTINEL);

  let httpRejected = false;
  try {
    await media.downloadSafeRemoteMedia("http://example.com/a.png");
  } catch {
    httpRejected = true;
  }
  if (!httpRejected) {
    console.error(SENTINEL);
    assert.equal(httpRejected, true, SENTINEL);
  }

  const connections: Array<Record<string, unknown>> = [];
  const lookups: string[] = [];
  const body = await media.downloadSafeRemoteMedia("https://cdn.example/a.png", {
    lookup: async (hostname: string) => {
      lookups.push(hostname);
      return [{ address: "8.8.8.8", family: 4 as const }];
    },
    connect: async (opts: { ip: string; hostname: string; servername?: string; path: string }) => {
      connections.push({ ...opts });
      return { status: 200, headers: { "content-type": "image/png" }, body: PNG };
    },
    env: { HTTPS_PROXY: "http://127.0.0.1:8080", HTTP_PROXY: "http://127.0.0.1:8080" },
  });
  if (
    connections[0]?.ip !== "8.8.8.8"
    || connections[0]?.hostname !== "cdn.example"
    || connections[0]?.servername !== "cdn.example"
    || connections.some((item) => String(item.ip).startsWith("127."))
    || !Buffer.from(body).equals(PNG)
  ) {
    console.error(SENTINEL);
    assert.equal(connections[0]?.ip, "8.8.8.8", SENTINEL);
    assert.equal(connections[0]?.servername, "cdn.example", SENTINEL);
  }

  let rebound = false;
  try {
    await media.downloadSafeRemoteMedia("https://rebind.example/a.png", {
      lookup: async () => [{ address: "8.8.8.8", family: 4 as const }],
      connect: async () => ({
        status: 302,
        headers: { location: "https://evil.internal/secret.png" },
        body: Buffer.alloc(0),
      }),
    });
  } catch {
    rebound = true;
  }
  let privateAfterRedirect = false;
  try {
    await media.downloadSafeRemoteMedia("https://rebind.example/a.png", {
      lookup: async (hostname: string) => {
        if (hostname === "evil.internal") return [{ address: "127.0.0.1", family: 4 as const }];
        return [{ address: "1.1.1.1", family: 4 as const }];
      },
      connect: async (opts): Promise<import("../../src/tianjiang/media/safe-remote-media").SafeRemoteConnectResult> => {
        if (opts.hostname === "rebind.example") {
          return { status: 302, headers: { location: "https://evil.internal/secret.png" }, body: Buffer.alloc(0) };
        }
        return { status: 200, headers: { "content-type": "image/png" }, body: PNG };
      },
    });
  } catch {
    privateAfterRedirect = true;
  }
  if (!rebound && !privateAfterRedirect) {
    console.error(SENTINEL);
    assert.equal(privateAfterRedirect, true, SENTINEL);
  }
  let ipv6Rejected = false;
  try {
    await media.downloadSafeRemoteMedia("https://aaaa.example/a.png", {
      lookup: async () => [{ address: "fc00::1", family: 6 as const }],
      connect: async () => ({ status: 200, headers: {}, body: PNG }),
    });
  } catch {
    ipv6Rejected = true;
  }
  if (!ipv6Rejected) {
    console.error(SENTINEL);
    assert.equal(ipv6Rejected, true, SENTINEL);
  }
});
