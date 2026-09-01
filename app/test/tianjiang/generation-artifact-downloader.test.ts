/**
 * HTTPS 产物下载必须落实 SSRF、私网、重定向、大小、内容类型、摘要和真实路径校验。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  downloadGenerationArtifact,
  isBlockedAddress,
  setGenerationArtifactDownloaderForTests,
  UnsafeGenerationArtifactUrlError,
} from "../../src/tianjiang/tasks/generation-artifact-downloader";
import { inferArtifactMediaType } from "../../src/tianjiang/tasks/generation-task-artifacts";
import { normalizeRemoteState } from "../../src/tianjiang/tasks/vendor-status-adapters";

const FIXTURE_MP4 = path.resolve(__dirname, "fixtures", "minimal-adoptable.mp4");

test("MP4 即使带查询串也必须推断为 video", () => {
  assert.equal(inferArtifactMediaType("https://cdn.example/result.mp4?token=1"), "video");
  assert.equal(inferArtifactMediaType("files/videos/out.mp4"), "video");
  assert.equal(
    normalizeRemoteState({
      status: "success",
      url: "https://cdn.example/result.mp4?token=1",
    }).artifact?.mediaType,
    "video",
  );
});

test("网络响应中的 localPath/filePath 不得成为产物定位", () => {
  const result = normalizeRemoteState({
    state: "completed",
    localPath: "C:\\\\Windows\\\\System32\\\\config\\\\sam",
    filePath: "/etc/passwd",
  });
  assert.equal(result.state, "completed");
  assert.equal(result.artifact, undefined);
});

test("禁止私网、环回和元数据地址", () => {
  assert.equal(isBlockedAddress("127.0.0.1"), true);
  assert.equal(isBlockedAddress("10.0.0.8"), true);
  assert.equal(isBlockedAddress("192.168.1.1"), true);
  assert.equal(isBlockedAddress("169.254.169.254"), true);
  assert.equal(isBlockedAddress("::1"), true);
  assert.equal(isBlockedAddress("0:0:0:0:0:ffff:7f00:1"), true);
  assert.equal(isBlockedAddress("0:0:0:0:0:ffff:a00:1"), true);
  assert.equal(isBlockedAddress("1.1.1.1"), false);
});

test("HTTPS 下载拒绝 SSRF、重定向到私网、超限大小和不匹配类型", async () => {
  const staging = path.join(process.cwd(), "..", ".tmp", `dl-${process.pid}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const mp4 = fs.readFileSync(FIXTURE_MP4);
  try {
    setGenerationArtifactDownloaderForTests({
      stagingRoot: staging,
      maxBytes: 1024,
      lookup: async (hostname) => {
        if (hostname === "evil.local") return ["127.0.0.1"];
        if (hostname === "ok.example") return ["1.1.1.1"];
        return ["8.8.8.8"];
      },
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("redirect-private")) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://127.0.0.1/secret.mp4" },
          });
        }
        if (url.includes("too-big")) {
          return new Response(Buffer.alloc(2048), {
            status: 200,
            headers: { "content-type": "video/mp4" },
          });
        }
        if (url.includes("octet-html")) {
          return new Response("<html>no</html>", {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          });
        }
        if (url.includes("fake-mime")) {
          return new Response("<html>no</html>", {
            status: 200,
            headers: { "content-type": "video/mp4" },
          });
        }
        if (url.includes("html")) {
          return new Response("<html>no</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        return new Response(mp4, {
          status: 200,
          headers: { "content-type": "video/mp4" },
        });
      },
    });

    await assert.rejects(
      () => downloadGenerationArtifact({
        remoteUrl: "http://ok.example/a.mp4",
        mediaType: "video",
      }),
      UnsafeGenerationArtifactUrlError,
    );
    await assert.rejects(
      () => downloadGenerationArtifact({
        remoteUrl: "https://127.0.0.1/a.mp4",
        mediaType: "video",
      }),
      /私网|环回|HTTPS|禁止/,
    );
    await assert.rejects(
      () => downloadGenerationArtifact({
        remoteUrl: "https://evil.local/a.mp4",
        mediaType: "video",
      }),
      /私网|禁止/,
    );
    await assert.rejects(
      () => downloadGenerationArtifact({
        remoteUrl: "https://ok.example/redirect-private.mp4",
        mediaType: "video",
      }),
      /私网|禁止|环回/,
    );
    await assert.rejects(
      () => downloadGenerationArtifact({
        remoteUrl: "https://ok.example/too-big.mp4",
        mediaType: "video",
      }),
      /大小/,
    );
    await assert.rejects(
      () => downloadGenerationArtifact({
        remoteUrl: "https://ok.example/html.mp4",
        mediaType: "video",
      }),
      /内容类型/,
    );
    await assert.rejects(
      () => downloadGenerationArtifact({
        remoteUrl: "https://ok.example/octet-html.mp4",
        mediaType: "video",
      }),
      /容器|文件头/,
    );

    await assert.rejects(
      () => downloadGenerationArtifact({
        remoteUrl: "https://ok.example/fake-mime.mp4",
        mediaType: "video",
      }),
      /内容类型|容器|文件头/,
    );

    const artifact = await downloadGenerationArtifact({
      remoteUrl: "https://ok.example/generated.mp4",
      mediaType: "video",
    });
    assert.equal(artifact.sourceKind, "local_path");
    assert.ok(artifact.localPath && fs.existsSync(artifact.localPath));
    assert.equal(fs.realpathSync.native(artifact.localPath!).startsWith(fs.realpathSync.native(staging)), true);
    assert.ok((artifact.byteLength ?? 0) > 0);
    assert.match(artifact.sha256 ?? "", /^[0-9a-f]{64}$/);
  } finally {
    setGenerationArtifactDownloaderForTests(null);
    fs.rmSync(staging, { recursive: true, force: true });
  }
});

test("第一次解析公网、连接时变成私网：必须把连接固定到已校验 IP", async () => {
  const staging = path.join(process.cwd(), "..", ".tmp", `rebind-${process.pid}`);
  fs.mkdirSync(staging, { recursive: true });
  const mp4 = fs.readFileSync(FIXTURE_MP4);
  let lookups = 0;
  const connections: Array<{ url: string; host?: string; sni?: string }> = [];
  try {
    setGenerationArtifactDownloaderForTests({
      stagingRoot: staging,
      lookup: async () => {
        lookups += 1;
        return lookups === 1 ? ["1.1.1.1"] : ["127.0.0.1"];
      },
      request: async (input) => {
        connections.push({
          url: input.url.href,
          host: input.headers.host,
          sni: input.servername,
        });
        if (input.pinnedIp !== "1.1.1.1") {
          throw new UnsafeGenerationArtifactUrlError("禁止下载私网或保留地址");
        }
        return new Response(mp4, {
          status: 200,
          headers: { "content-type": "video/mp4" },
        });
      },
    });
    const artifact = await downloadGenerationArtifact({
      remoteUrl: "https://cdn.example/generated.mp4",
      mediaType: "video",
    });
    assert.ok(artifact.localPath);
    assert.equal(lookups, 1);
    assert.equal(new URL(connections[0]!.url).hostname, "cdn.example");
    assert.equal(connections[0]!.host, "cdn.example");
    assert.equal(connections[0]!.sni, "cdn.example");
    assert.doesNotMatch(JSON.stringify(connections[0]), /x-tls-servername/i);
  } finally {
    setGenerationArtifactDownloaderForTests(null);
    fs.rmSync(staging, { recursive: true, force: true });
  }
});

test("IPv4 与 IPv6 都必须把 TCP 固定到已校验 IP，URL/Host/SNI 保持原主机名", async () => {
  const staging = path.join(process.cwd(), "..", ".tmp", `pin-ip-${process.pid}`);
  fs.mkdirSync(staging, { recursive: true });
  const mp4 = fs.readFileSync(FIXTURE_MP4);
  const pins: Array<{ hostname: string; pinnedIp: string; servername: string; host: string }> = [];
  try {
    for (const pinnedIp of ["1.1.1.1", "2606:4700:4700::1111"] as const) {
      pins.length = 0;
      setGenerationArtifactDownloaderForTests({
        stagingRoot: staging,
        lookup: async () => [pinnedIp],
        fetch: async () => {
          throw new Error("禁止回退到 fetch 伪 SNI");
        },
        request: async (input) => {
          pins.push({
            hostname: input.url.hostname,
            pinnedIp: input.pinnedIp,
            servername: input.servername,
            host: input.headers.host ?? "",
          });
          return new Response(mp4, {
            status: 200,
            headers: { "content-type": "video/mp4" },
          });
        },
      });
      const artifact = await downloadGenerationArtifact({
        remoteUrl: "https://cdn.example/generated.mp4",
        mediaType: "video",
      });
      assert.ok(artifact.localPath);
      assert.equal(pins.length, 1);
      assert.equal(pins[0]!.hostname, "cdn.example");
      assert.equal(pins[0]!.pinnedIp, pinnedIp);
      assert.equal(pins[0]!.servername, "cdn.example");
      assert.equal(pins[0]!.host, "cdn.example");
    }
  } finally {
    setGenerationArtifactDownloaderForTests(null);
    fs.rmSync(staging, { recursive: true, force: true });
  }
});

test("每次重定向都必须重新解析并重新固定到该主机的公网 IP", async () => {
  const staging = path.join(process.cwd(), "..", ".tmp", `pin-redir-${process.pid}`);
  fs.mkdirSync(staging, { recursive: true });
  const mp4 = fs.readFileSync(FIXTURE_MP4);
  const pins: Array<{ href: string; pinnedIp: string; servername: string }> = [];
  try {
    setGenerationArtifactDownloaderForTests({
      stagingRoot: staging,
      lookup: async (hostname) => {
        if (hostname === "cdn.example") return ["1.1.1.1"];
        if (hostname === "other.example") return ["8.8.8.8"];
        return ["9.9.9.9"];
      },
      fetch: async () => {
        throw new Error("禁止回退到 fetch 伪 SNI");
      },
      request: async (input) => {
        pins.push({
          href: input.url.href,
          pinnedIp: input.pinnedIp,
          servername: input.servername,
        });
        if (input.url.hostname === "cdn.example") {
          return new Response(null, {
            status: 302,
            headers: { location: "https://other.example/final.mp4" },
          });
        }
        return new Response(mp4, {
          status: 200,
          headers: { "content-type": "video/mp4" },
        });
      },
    });
    await downloadGenerationArtifact({
      remoteUrl: "https://cdn.example/start.mp4",
      mediaType: "video",
    });
    assert.equal(pins.length, 2);
    assert.equal(pins[0]!.servername, "cdn.example");
    assert.equal(pins[0]!.pinnedIp, "1.1.1.1");
    assert.equal(pins[1]!.servername, "other.example");
    assert.equal(pins[1]!.pinnedIp, "8.8.8.8");
    assert.equal(new URL(pins[0]!.href).hostname, "cdn.example");
    assert.equal(new URL(pins[1]!.href).hostname, "other.example");
  } finally {
    setGenerationArtifactDownloaderForTests(null);
    fs.rmSync(staging, { recursive: true, force: true });
  }
});

test("真实本地 TLS：TCP 连已校验 IP，SNI/证书主机名/Host 保持原主机名，禁止伪 Header", async () => {
  const https = await import("node:https");
  const tls = await import("node:tls");
  const staging = path.join(process.cwd(), "..", ".tmp", `sni-${process.pid}`);
  fs.mkdirSync(staging, { recursive: true });
  const mp4 = fs.readFileSync(FIXTURE_MP4);
  const fixtureDir = path.resolve(__dirname, "fixtures", "tls");
  const key = fs.readFileSync(path.join(fixtureDir, "cdn.test.key.pem"));
  const cert = fs.readFileSync(path.join(fixtureDir, "cdn.test.crt.pem"));
  const observed = { sni: "", host: "", remote: "" };
  const server = https.createServer({
    key,
    cert,
    SNICallback(servername, callback) {
      observed.sni = String(servername ?? "");
      callback(null, tls.createSecureContext({ key, cert }));
    },
  }, (req, res) => {
    observed.host = String(req.headers.host ?? "");
    observed.remote = String(req.socket.remoteAddress ?? "");
    assert.equal(req.headers["x-tls-servername"], undefined);
    res.writeHead(200, { "content-type": "video/mp4" });
    res.end(mp4);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  try {
    setGenerationArtifactDownloaderForTests({
      stagingRoot: staging,
      allowLoopbackPin: true,
      tlsCa: cert,
      lookup: async (hostname) => {
        assert.equal(hostname, "cdn.test");
        return ["127.0.0.1"];
      },
    });
    const artifact = await downloadGenerationArtifact({
      remoteUrl: `https://cdn.test:${port}/generated.mp4`,
      mediaType: "video",
    });
    assert.ok(artifact.localPath);
    assert.equal(observed.sni, "cdn.test");
    assert.equal(observed.host, `cdn.test:${port}`);
  } finally {
    setGenerationArtifactDownloaderForTests(null);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    fs.rmSync(staging, { recursive: true, force: true });
  }
});

test("允许列表与下载校验对齐：未提供容器校验的扩展不得推断为 audio", () => {
  assert.equal(inferArtifactMediaType("https://cdn.example/a.mp3"), "audio");
  assert.equal(inferArtifactMediaType("https://cdn.example/a.wav"), "audio");
  assert.notEqual(inferArtifactMediaType("https://cdn.example/a.m4a"), "audio");
  assert.notEqual(inferArtifactMediaType("https://cdn.example/a.aac"), "audio");
  assert.notEqual(inferArtifactMediaType("https://cdn.example/a.flac"), "audio");
  assert.notEqual(inferArtifactMediaType("https://cdn.example/a.ogg"), "audio");
});
