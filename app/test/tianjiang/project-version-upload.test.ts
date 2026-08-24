import assert from "node:assert/strict";
import test from "node:test";

import type { CentralAuthGateway, CentralSession } from "../../src/tianjiang/auth/central-session";
import { CentralRuntimeAdapter } from "../../src/tianjiang/runtime/central-runtime-adapter";
import { checksumBuffer } from "../../src/tianjiang/sync/checksum";

const projectUuid = "018f3d6e-2d9e-7b6c-8a9b-000000000001";
const deviceUuid = "018f3d6e-2d9e-7b6c-8a9b-1234567890a1";
const sessionUuid = "018f3d6e-2d9e-7b6c-8a9b-000000000090";
const session = {
  id: "session",
  serverUrl: "https://api.example.invalid",
  token: "memory-only",
  expiresAt: Date.now() + 60_000,
  validatedAt: Date.now(),
  user: { id: 7, username: "alice", nickname: "Alice" },
} as CentralSession;

test("零版本项目首次打开使用空快照，不请求尚不存在的中央版本", async () => {
  let forwarded = false;
  const gateway = {
    forwardBusinessRequest: async () => {
      forwarded = true;
      throw new Error("零版本项目不应读取 latest");
    },
  } as unknown as CentralAuthGateway;
  const adapter = new CentralRuntimeAdapter(gateway, session, deviceUuid);
  let downloaded: unknown;
  const remote = adapter.personalRemote(projectUuid, (snapshot) => {
    downloaded = snapshot;
  }, {
    currentVersion: 0,
    readObject: () => Buffer.alloc(0),
  });

  assert.deepEqual(await remote.latest(), { version: 0, objects: [] });
  assert.deepEqual(downloaded, { version: 0, objects: [], records: {} });
  assert.equal(forwarded, false);
});

test("项目发布必须完成对象计划、PUT、确认和完整 manifest 后再提交", async () => {
  const bytes = Buffer.from("project-sqlite-snapshot");
  const checksum = checksumBuffer(bytes);
  const contentMD5 = Buffer.from(checksum.md5, "hex").toString("base64");
  const calls: Array<{ pathname: string; method: string; body: Record<string, unknown> }> = [];
  const gateway = {
    forwardBusinessRequest: async (
      _session: CentralSession,
      pathname: string,
      method: string,
      body: Record<string, unknown> = {},
    ) => {
      calls.push({ pathname, method, body });
      if (pathname.endsWith("/upload-sessions")) {
        assert.equal(body.baseVersion, 0);
        assert.equal(body.deviceUuid, deviceUuid);
        assert.ok(typeof body.ttlSeconds === "number" && body.ttlSeconds >= 300);
        assert.deepEqual(body.objects, [{
          relativePath: "project.sqlite",
          size: bytes.length,
          md5: checksum.md5,
          crc64: checksum.crc64,
          uploadMode: "simple",
        }]);
        // 中央权威增量：session.objects 即 requiredUploadObjects
        return {
          sessionUuid,
          expiresAt: "2026-08-03T12:00:00Z",
          objects: [{
            relativePath: "project.sqlite",
            size: bytes.length,
            md5: checksum.md5,
            objectKey: "staging/project.sqlite",
            verified: false,
          }],
          requiredUploadObjects: ["project.sqlite"],
        };
      }
      if (pathname.endsWith("/object-authorizations")) {
        assert.equal(body.method, "PUT");
        assert.equal(body.sessionUuid, sessionUuid);
        assert.equal(body.deviceUuid, deviceUuid);
        assert.equal(body.relativePath, "project.sqlite");
        return {
          url: "https://oss.invalid/staging/project.sqlite?signature=redacted",
          // 阿里云 V4 预签名结果已经包含 Content-MD5；客户端必须原样且仅发送一次。
          signedHeaders: { "Content-Md5": contentMD5, "x-oss-meta-bound": "1" },
        };
      }
      if (pathname.endsWith("/objects/confirm")) return {};
      if (pathname.endsWith("/commit")) {
        assert.equal(body.deviceUuid, deviceUuid);
        const manifest = body.manifest as Record<string, unknown>;
        assert.equal(manifest.schema_version, 1);
        assert.equal(manifest.project_uuid, projectUuid);
        assert.equal(manifest.version, 1);
        assert.equal(manifest.base_version, 0);
        assert.equal(typeof manifest.created_at, "string");
        assert.deepEqual(manifest.database, {
          relative_path: "project.sqlite",
          size: bytes.length,
          md5: checksum.md5,
        });
        assert.deepEqual(manifest.files, []);
        return { version: 1, manifest, objects: [] };
      }
      throw new Error(`未预期请求：${method} ${pathname}`);
    },
  } as unknown as CentralAuthGateway;
  const uploads: Buffer[] = [];
  const transport = async (_input: string | URL | Request, init?: RequestInit) => {
    uploads.push(Buffer.from(init?.body as ArrayBuffer));
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("content-md5"), contentMD5);
    assert.equal(
      [...headers.keys()].filter((name) => name.toLowerCase() === "content-md5").length,
      1,
      "Content-MD5 必须按大小写无关语义仅出现一次",
    );
    return new Response(null, { status: 200 });
  };
  const adapter = new CentralRuntimeAdapter(gateway, session, deviceUuid, transport as typeof fetch);
  const remote = adapter.personalRemote(projectUuid, () => undefined, {
    currentVersion: 0,
    readObject: () => bytes,
  });

  const committed = await remote.publish(0, {
    version: 0,
    objects: [{ relativePath: "project.sqlite", size: bytes.length, md5: checksum.md5 }],
  }, ["project.sqlite"], "close");

  assert.equal(committed.version, 1);
  assert.deepEqual(uploads, [bytes]);
  assert.deepEqual(calls.map((item) => item.pathname), [
    `/api/tianjiang/v1/projects/${projectUuid}/upload-sessions`,
    "/api/tianjiang/v1/object-authorizations",
    `/api/tianjiang/v1/upload-sessions/${sessionUuid}/objects/confirm`,
    `/api/tianjiang/v1/upload-sessions/${sessionUuid}/commit`,
  ]);
  assert.doesNotMatch(JSON.stringify(calls), /project-sqlite-snapshot|memory-only/);
});

test("对象上传失败后必须终止暂存会话，并保留原同步错误", async () => {
  const bytes = Buffer.from("project-sqlite-snapshot");
  const checksum = checksumBuffer(bytes);
  const calls: string[] = [];
  let failureBody: Record<string, unknown> | undefined;
  const gateway = {
    forwardBusinessRequest: async (
      _session: CentralSession,
      pathname: string,
      _method: string,
      _body: Record<string, unknown> = {},
    ) => {
      calls.push(pathname);
      if (pathname.endsWith("/upload-sessions")) {
        return {
          sessionUuid,
          objects: [{
            relativePath: "project.sqlite",
            size: bytes.length,
            md5: checksum.md5,
          }],
          requiredUploadObjects: ["project.sqlite"],
        };
      }
      if (pathname.endsWith("/object-authorizations")) {
        return {
          url: "https://oss.invalid/staging/project.sqlite?signature=redacted",
          signedHeaders: {
            "Content-Md5": Buffer.from(checksum.md5, "hex").toString("base64"),
          },
        };
      }
      if (pathname.endsWith("/fail")) {
        failureBody = _body;
        return {};
      }
      throw new Error(`未预期请求：${pathname}`);
    },
  } as unknown as CentralAuthGateway;
  const adapter = new CentralRuntimeAdapter(
    gateway,
    session,
    deviceUuid,
    (async () => new Response(null, {
      status: 503,
      headers: { "x-oss-request-id": "safe-request-id-503" },
    })) as typeof fetch,
  );
  const remote = adapter.personalRemote(projectUuid, () => undefined, {
    currentVersion: 0,
    readObject: () => bytes,
  });

  await assert.rejects(
    () => remote.publish(0, {
      version: 0,
      objects: [{ relativePath: "project.sqlite", size: bytes.length, md5: checksum.md5 }],
    }, ["project.sqlite"], "close"),
    (error: unknown) => {
      const actual = error as Error & { code?: string; status?: number; requestId?: string };
      assert.match(actual.message, /项目对象上传失败（HTTP 503）/);
      assert.equal(actual.code, "HTTP_503");
      assert.equal(actual.status, 503);
      assert.equal(actual.requestId, "safe-request-id-503");
      return true;
    },
  );
  assert.equal(calls.at(-1), `/api/tianjiang/v1/upload-sessions/${sessionUuid}/fail`);
  assert.deepEqual(failureBody, { failureCode: "client_upload_http_503" });
});
