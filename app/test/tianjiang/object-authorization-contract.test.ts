import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import type { CentralAuthGateway, CentralSession } from "../../src/tianjiang/auth/central-session";
import { CentralRuntimeAdapter } from "../../src/tianjiang/runtime/central-runtime-adapter";

test("模型对象下载按中央正式字段绑定项目版本路径和活动设备", async () => {
  let captured: { pathname: string; method: string; body: unknown } | undefined;
  const gateway = {
    forwardBusinessRequest: async (
      _session: CentralSession,
      pathname: string,
      method: string,
      body: unknown,
    ) => {
      captured = { pathname, method, body };
      return { url: "https://media.invalid/object?signature=redacted" };
    },
  } as unknown as CentralAuthGateway;
  const session = {
    id: "session",
    serverUrl: "https://api.example.invalid",
    token: "memory-only",
    expiresAt: Date.now() + 60_000,
    validatedAt: Date.now(),
    user: { id: 7, username: "alice", nickname: "Alice" },
  } as CentralSession;
  const deviceUuid = "018f3d6e-2d9e-7b6c-8a9b-1234567890a1";
  const adapter = new CentralRuntimeAdapter(gateway, session, deviceUuid);
  const projectUuid = "018f3d6e-2d9e-7b6c-8a9b-000000000001";

  await adapter.signObjectDownload(
    `v1/projects/${projectUuid}/3/files/images/a.png`,
    120,
  );
  assert.deepEqual(captured, {
    pathname: "/api/tianjiang/v1/object-authorizations",
    method: "POST",
    body: {
      method: "GET",
      projectUuid,
      version: 3,
      relativePath: "files/images/a.png",
      deviceUuid,
      expiresInSeconds: 120,
      useCdn: false,
    },
  });
  assert.equal("objectKey" in (captured!.body as Record<string, unknown>), false);
});

test("模型对象下载拒绝非平台稳定键，不能把任意对象键送入授权接口", async () => {
  let forwarded = false;
  const gateway = {
    forwardBusinessRequest: async () => {
      forwarded = true;
      return {};
    },
  } as unknown as CentralAuthGateway;
  const adapter = new CentralRuntimeAdapter(gateway, {
    id: "session",
    serverUrl: "https://api.example.invalid",
    token: "memory-only",
    expiresAt: Date.now() + 60_000,
    validatedAt: Date.now(),
    user: { id: 7, username: "alice", nickname: "Alice" },
  } as CentralSession, "018f3d6e-2d9e-7b6c-8a9b-1234567890a1");

  await assert.rejects(
    () => adapter.signObjectDownload("staging/users/other/private.png", 120),
    /稳定对象键无效/,
  );
  assert.equal(forwarded, false);
});

test("本地媒体生产链使用中央暂存会话、实际 PUT、服务端确认和短时 GET", async () => {
  const calls: Array<{ pathname: string; body: Record<string, unknown> }> = [];
  const sessionUuid = "018f3d6e-2d9e-7b6c-8a9b-000000000090";
  const gateway = {
    forwardBusinessRequest: async (
      _session: CentralSession,
      pathname: string,
      _method: string,
      body: Record<string, unknown>,
    ) => {
      calls.push({ pathname, body });
      if (pathname.endsWith("/upload-sessions")) return { sessionUuid };
      if (pathname.endsWith("/objects")) return {};
      if (body.method === "PUT") {
        return {
          url: "https://oss.invalid/staging/object?signature=upload",
          signedHeaders: {
            "Content-Md5": String(body.contentMd5 ?? ""),
            "x-oss-meta-test": "bound",
          },
        };
      }
      return { url: "https://oss.invalid/staging/object?signature=download" };
    },
  } as unknown as CentralAuthGateway;
  const uploaded: Array<{ url: string; body: Buffer; headers: HeadersInit | undefined }> = [];
  const transport = async (input: string | URL | Request, init?: RequestInit) => {
    uploaded.push({
      url: String(input),
      body: Buffer.from(init?.body as Buffer),
      headers: init?.headers,
    });
    return new Response(null, { status: 200 });
  };
  const adapter = new CentralRuntimeAdapter(gateway, {
    id: "session",
    serverUrl: "https://api.example.invalid",
    token: "memory-only",
    expiresAt: Date.now() + 60_000,
    validatedAt: Date.now(),
    user: { id: 7, username: "alice", nickname: "Alice" },
  } as CentralSession, "018f3d6e-2d9e-7b6c-8a9b-1234567890a1", transport as typeof fetch);
  const bytes = Buffer.from("local-image-bytes");
  const projectUuid = "018f3d6e-2d9e-7b6c-8a9b-000000000001";
  const url = await adapter.stageModelMedia(projectUuid, 2, {
    projectUuid,
    relativePath: "files/images/local.png",
    md5: crypto.createHash("md5").update(bytes).digest("hex"),
    size: bytes.length,
  }, bytes, 300);

  assert.equal(url, "https://oss.invalid/staging/object?signature=download");
  assert.deepEqual(calls.map((item) => item.pathname), [
    `/api/tianjiang/v1/projects/${projectUuid}/upload-sessions`,
    "/api/tianjiang/v1/object-authorizations",
    `/api/tianjiang/v1/upload-sessions/${sessionUuid}/objects/confirm`,
    "/api/tianjiang/v1/object-authorizations",
  ]);
  assert.equal(calls[1].body.method, "PUT");
  assert.equal(calls[3].body.method, "GET");
  assert.equal(calls[3].body.sessionUuid, sessionUuid);
  assert.equal(calls[3].body.deviceUuid, "018f3d6e-2d9e-7b6c-8a9b-1234567890a1");
  assert.equal(uploaded.length, 1);
  assert.deepEqual(uploaded[0].body, bytes);
  const uploadHeaders = new Headers(uploaded[0].headers);
  const expectedContentMD5 = crypto.createHash("md5").update(bytes).digest("base64");
  assert.equal(
    uploadHeaders.get("content-md5"),
    expectedContentMD5,
    "媒体上传必须原样发送中央签名的单一 Content-MD5，禁止大小写重复合并",
  );
  assert.doesNotMatch(JSON.stringify(calls), /local-image-bytes|data:image|base64,/i);
});
