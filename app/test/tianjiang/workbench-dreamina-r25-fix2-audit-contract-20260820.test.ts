import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import type { Response as ExpressResponse } from "express";

import type { CentralAuthGateway, CentralSession } from "../../src/tianjiang/auth/central-session";
import {
  decodeTransientMedia,
  matchesFileSignature,
  resolveVerifiedMediaMime,
} from "../../src/tianjiang/media/transient-media";
import { CentralRuntimeAdapter } from "../../src/tianjiang/runtime/central-runtime-adapter";
import { writeWorkbenchDreaminaError } from "../../src/tianjiang/workbench/dreamina-workbench-enqueue";

const projectUuid = "018f3d6e-2d9e-7b6c-8a9b-0000000000f1";
const deviceUuid = "018f3d6e-2d9e-7b6c-8a9b-1234567890f1";
const uploadSessionUuid = "018f3d6e-2d9e-7b6c-8a9b-0000000000f2";

const session = {
  id: "r25-fix2-audit",
  serverUrl: "https://api.example.invalid",
  token: "memory-only",
  expiresAt: Date.now() + 60_000,
  validatedAt: Date.now(),
  user: { id: 25, username: "audit", nickname: "Audit" },
} as CentralSession;

function makeAviBytes(payload = "test-frame"): Buffer {
  const tail = Buffer.from(payload, "utf8");
  const bytes = Buffer.alloc(12 + tail.length);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("AVI ", 8, "ascii");
  tail.copy(bytes, 12);
  return bytes;
}

function md5(bytes: Buffer): string {
  return crypto.createHash("md5").update(bytes).digest("hex");
}

function captureWorkbenchError(error: unknown): { status: number; body: Record<string, unknown> } {
  let status = 0;
  let body: Record<string, unknown> = {};
  const response = {
    headersSent: false,
    status(code: number) {
      status = code;
      return this;
    },
    send(value: Record<string, unknown>) {
      body = value;
      return this;
    },
  } as unknown as ExpressResponse;
  writeWorkbenchDreaminaError(response, error);
  return { status, body };
}

test("工作台未知服务端错误码不得原样回显，稳定白名单仍保留", () => {
  const unsafeCodes = [
    "E:\\secret\\db2.sqlite",
    "DROP TABLE o_video",
    "apiKey=sk-secret",
    "Cookie=session-token",
    "UNKNOWN_UPSTREAM_CODE",
    "constructor",
    "__proto__",
  ];
  for (const rawCode of unsafeCodes) {
    const error = Object.assign(new Error("上游任意自由文本"), { status: 503, code: rawCode });
    const captured = captureWorkbenchError(error);
    assert.equal(captured.status, 503);
    assert.deepEqual(captured.body, {
      code: "WORKBENCH_DREAMINA_REQUEST_FAILED",
      message: "提交生成失败，请重试",
    });
    assert.doesNotMatch(JSON.stringify(captured.body), /db2\.sqlite|DROP TABLE|apiKey|Cookie|sk-secret|UNKNOWN_UPSTREAM/i);
  }

  const known = captureWorkbenchError(Object.assign(new Error("任意消息"), {
    status: 400,
    code: "DREAMINA_CLI_DISABLED",
  }));
  assert.deepEqual(known, {
    status: 400,
    body: { code: "DREAMINA_CLI_DISABLED", message: "即梦 CLI 已关闭" },
  });
});

test("AVI 内联只接受 RIFF/AVI 文件头并返回标准视频 MIME", () => {
  const valid = makeAviBytes();
  const decoded = decodeTransientMedia(
    `data:video/x-msvideo;base64,${valid.toString("base64")}`,
    "video",
  );
  assert.equal(decoded.extension, "avi");
  assert.equal(decoded.mime, "video/x-msvideo");
  assert.deepEqual(decoded.bytes, valid);
  assert.equal(matchesFileSignature(valid, "avi"), true);
  assert.equal(resolveVerifiedMediaMime("files/videos/reference.avi", valid), "video/x-msvideo");

  const disguisedWave = Buffer.from(valid);
  disguisedWave.write("WAVE", 8, "ascii");
  assert.equal(matchesFileSignature(disguisedWave, "avi"), false);
  assert.throws(
    () => decodeTransientMedia(
      `data:video/x-msvideo;base64,${disguisedWave.toString("base64")}`,
      "video",
    ),
    /媒体文件头与声明类型不匹配/,
  );
  assert.throws(
    () => resolveVerifiedMediaMime("files/videos/disguised.avi", disguisedWave),
    (error: unknown) => (error as { code?: unknown }).code === "STORYBOARD_REFERENCE_IDENTITY_MISMATCH",
  );
});

test("中央同步清单必须把 AVI 标记为 video 而不是 binary", async () => {
  const database = Buffer.from("sqlite-snapshot", "utf8");
  const avi = makeAviBytes("central-frame");
  let committedManifest: Record<string, unknown> | undefined;
  const gateway = {
    forwardBusinessRequest: async (
      _session: CentralSession,
      pathname: string,
      _method: string,
      body: Record<string, unknown> = {},
    ) => {
      if (pathname.endsWith("/upload-sessions")) {
        return {
          sessionUuid: uploadSessionUuid,
          objects: [],
          requiredUploadObjects: [],
        };
      }
      if (pathname.endsWith("/commit")) {
        committedManifest = body.manifest as Record<string, unknown>;
        return { version: 1, manifest: body.manifest, objects: [] };
      }
      throw new Error(`未预期请求：${pathname}`);
    },
  } as unknown as CentralAuthGateway;
  const objects = {
    "project.sqlite": database,
    "files/videos/reference.avi": avi,
  } as const;
  const adapter = new CentralRuntimeAdapter(gateway, session, deviceUuid);
  const remote = adapter.personalRemote(projectUuid, () => undefined, {
    currentVersion: 0,
    readObject: (relativePath) => objects[relativePath as keyof typeof objects],
  });

  const committed = await remote.publish(0, {
    version: 0,
    objects: Object.entries(objects).map(([relativePath, bytes]) => ({
      relativePath,
      size: bytes.length,
      md5: md5(bytes),
    })),
  }, ["project.sqlite", "files/videos/reference.avi"], "manual");

  assert.equal(committed.version, 1);
  const files = committedManifest?.files as Array<Record<string, unknown>>;
  assert.deepEqual(files, [{
    relative_path: "files/videos/reference.avi",
    size: avi.length,
    md5: md5(avi),
    media_type: "video",
  }]);
});
