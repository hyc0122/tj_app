import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemoryCredentialStore } from "../../src/tianjiang/crypto/credential-store";
import { ProfileCrypto } from "../../src/tianjiang/crypto/profile-crypto";
import { UserKeyRecoveryClient } from "../../src/tianjiang/crypto/user-key-recovery";
import {
  CentralBusinessError,
  CentralAuthGateway,
  createTestOnlyLoopbackPolicy,
  type CentralSession,
} from "../../src/tianjiang/auth/central-session";
import { isKeyServiceUnavailableError } from "../../src/tianjiang/auth/key-service-error";
import { ProfileStore } from "../../src/tianjiang/data/profile-store";
import { CentralRuntimeAdapter } from "../../src/tianjiang/runtime/central-runtime-adapter";
import { ProfileSync, type ProfileSnapshot } from "../../src/tianjiang/sync/profile-sync";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";

const userUUID = "018f3d6e-2d9e-7b6c-8a9b-1234567890ab";
const deviceUUID = "018f3d6e-2d9e-7b6c-8a9b-1234567890ac";

test("中央密钥服务不可用必须保留可降级错误语义", async () => {
  const unavailable = new CentralBusinessError(
    503,
    "KEY_SERVICE_UNAVAILABLE",
    "个人密钥服务暂不可用",
    "request-key-service-down",
    true,
  );
  const client = new UserKeyRecoveryClient({
    forwardBusinessRequest: async () => {
      throw unavailable;
    },
  }, syntheticSession(7), deviceUUID, new MemoryCredentialStore());

  await assert.rejects(
    () => client.loadOrRecover(userUUID),
    (error: unknown) => {
      // 中文注释：登录协调器依赖该错误码进入可重试降级，不能被包装成普通网络错误。
      assert.equal(error, unavailable);
      assert.equal(isKeyServiceUnavailableError(error), true);
      return true;
    },
  );
});

test("同一用户新设备经一次性挑战恢复密钥，重启从安全存储复用且不同用户不可解密", async () => {
  const dataKey = crypto.randomBytes(32);
  const credentials = new MemoryCredentialStore();
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let expectedPublicKey = "";
  const gateway = {
    forwardBusinessRequest: async (
      _session: CentralSession,
      path: string,
      _method: string,
      body?: unknown,
    ): Promise<unknown> => {
      calls.push({ path, body: body as Record<string, unknown> });
      if (path.endsWith("/challenges")) {
        expectedPublicKey = String((body as Record<string, unknown>).recoveryPublicKey ?? "");
        return {
          challengeId: "11111111-1111-4111-a111-111111111111",
          challenge: "challenge-nonce",
          signingPayload: `tj-key-recovery:v1:11111111-1111-4111-a111-111111111111:challenge-nonce:7:${deviceUUID}`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      }
      const publicKey = crypto.createPublicKey(expectedPublicKey);
      return {
        deviceCiphertext: crypto.publicEncrypt({
          key: publicKey,
          oaepHash: "sha256",
          oaepLabel: Buffer.from(`tj-device-key:v1:7:${deviceUUID}`, "utf8"),
        }, dataKey).toString("base64url"),
        binding: `tj-device-key:v1:7:${deviceUUID}`,
        keyVersion: "master-v1",
      };
    },
  };
  const session = syntheticSession(7);
  const firstClient = new UserKeyRecoveryClient(gateway, session, deviceUUID, credentials);
  const first = await firstClient.loadOrRecover(userUUID);
  assert.deepEqual(first, dataKey);
  assert.equal(calls.map((item) => item.path).join(","), [
    "/api/tianjiang/v1/profile-key/challenges",
    "/api/tianjiang/v1/profile-key/recover",
  ].join(","));
  assert.equal(
    typeof calls[1].body.signature === "string" && String(calls[1].body.signature).length > 100,
    true,
  );

  const restarted = new UserKeyRecoveryClient(gateway, session, deviceUUID, credentials);
  assert.deepEqual(await restarted.loadOrRecover(userUUID), dataKey);
  assert.equal(calls.length, 2, "本机重启必须只读 OS 安全存储，不重复发起恢复挑战");

  const encrypted = new ProfileCrypto(userUUID, dataKey).encrypt("model-key-no-plaintext");
  const otherUser = "018f3d6e-2d9e-7b6c-8a9b-1234567890ad";
  assert.throws(
    () => new ProfileCrypto(otherUser, dataKey).decrypt(encrypted),
    /个人配置密文认证失败/,
  );
});

test("篡改设备密文、错误用户绑定或缺失本机私钥均拒绝且不落盘", async () => {
  const credentials = new MemoryCredentialStore();
  let responseBinding = `tj-device-key:v1:7:${deviceUUID}`;
  const gateway = {
    forwardBusinessRequest: async (
      _session: CentralSession,
      path: string,
      _method: string,
      body?: unknown,
    ): Promise<unknown> => {
      if (path.endsWith("/challenges")) {
        return {
          challengeId: "11111111-1111-4111-a111-111111111111",
          challenge: "challenge-nonce",
          signingPayload: `tj-key-recovery:v1:11111111-1111-4111-a111-111111111111:challenge-nonce:7:${deviceUUID}`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      }
      return {
        deviceCiphertext: crypto.randomBytes(256).toString("base64url"),
        binding: responseBinding,
        keyVersion: "master-v1",
        echoed: body,
      };
    },
  };
  const client = new UserKeyRecoveryClient(gateway, syntheticSession(7), deviceUUID, credentials);
  await assert.rejects(() => client.loadOrRecover(userUUID), /个人配置密钥恢复失败/);
  assert.equal(credentials.get(`profile-key:${userUUID}`), undefined);

  responseBinding = `tj-device-key:v1:8:${deviceUUID}`;
  const second = new UserKeyRecoveryClient(gateway, syntheticSession(7), deviceUUID, new MemoryCredentialStore());
  await assert.rejects(() => second.loadOrRecover(userUUID), /个人配置密钥恢复失败/);
});

test("真实 HTTP 中央存根支持设备1加密同步、设备2独立恢复解密且异用户失败", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tj-key-http-e2e-"));
  const central = await startKeyAndProfileCentralStub();
  const gateway = new CentralAuthGateway(fetch, createTestOnlyLoopbackPolicy());
  const sessionOne = syntheticSession(7);
  sessionOne.serverUrl = central.url;
  sessionOne.token = "user-7-device-1";
  const sessionTwo = syntheticSession(7);
  sessionTwo.serverUrl = central.url;
  sessionTwo.token = "user-7-device-2";
  const sessionOther = syntheticSession(8);
  sessionOther.serverUrl = central.url;
  sessionOther.token = "user-8-device-1";
  const deviceOne = "018f3d6e-2d9e-7b6c-8a9b-1234567890b1";
  const deviceTwo = "018f3d6e-2d9e-7b6c-8a9b-1234567890b2";
  const otherDevice = "018f3d6e-2d9e-7b6c-8a9b-1234567890b3";
  const userOneUUID = "018f3d6e-2d9e-7b6c-8a9b-1234567890c1";
  const userOtherUUID = "018f3d6e-2d9e-7b6c-8a9b-1234567890c2";
  const secret = `cross-device-secret-${crypto.randomUUID()}`;
  let firstStore: ProfileStore | undefined;
  let secondStore: ProfileStore | undefined;
  let otherStore: ProfileStore | undefined;
  try {
    const keyOne = await new UserKeyRecoveryClient(
      gateway,
      sessionOne,
      deviceOne,
      new MemoryCredentialStore(),
    ).loadOrRecover(userOneUUID);
    firstStore = new ProfileStore(
      path.join(root, "device-1"),
      userOneUUID,
      new ProfileCrypto(userOneUUID, keyOne),
    );
    const firstSync = new ProfileSync(
      firstStore,
      new CentralRuntimeAdapter(gateway, sessionOne, deviceOne).profileRemote(),
      () => undefined,
    );
    await runWithTemporaryAccount("key-recovery-e2e-a", async () => {
      await firstSync.login();
      firstSync.setPersistent("legacy.private.synthetic", JSON.stringify({ value: secret }), true);
      await firstSync.flush();
    });
    firstStore.close();
    firstStore = undefined;

    const secondCredentials = new MemoryCredentialStore();
    const keyTwo = await new UserKeyRecoveryClient(
      gateway,
      sessionTwo,
      deviceTwo,
      secondCredentials,
    ).loadOrRecover(userOneUUID);
    assert.deepEqual(keyTwo, keyOne);
    secondStore = new ProfileStore(
      path.join(root, "device-2"),
      userOneUUID,
      new ProfileCrypto(userOneUUID, keyTwo),
    );
    const secondSync = new ProfileSync(
      secondStore,
      new CentralRuntimeAdapter(gateway, sessionTwo, deviceTwo).profileRemote(),
      () => undefined,
    );
    await runWithTemporaryAccount("key-recovery-e2e-b", async () => {
      await secondSync.login();
    });
    assert.deepEqual(
      JSON.parse(secondStore.get("legacy.private.synthetic") ?? "{}"),
      { value: secret },
    );

    const otherKey = await new UserKeyRecoveryClient(
      gateway,
      sessionOther,
      otherDevice,
      new MemoryCredentialStore(),
    ).loadOrRecover(userOtherUUID);
    assert.notDeepEqual(otherKey, keyOne);
    otherStore = new ProfileStore(
      path.join(root, "other-user"),
      userOtherUUID,
      new ProfileCrypto(userOtherUUID, otherKey),
    );
    otherStore.applyStoredSnapshot(central.profile(7).entries, central.profile(7).version);
    assert.throws(
      () => otherStore!.get("legacy.private.synthetic"),
      /个人配置密文认证失败/,
    );

    const dataKeyText = keyOne.toString("base64url");
    assert.equal(central.requestBodies.some((body) => body.includes(secret)), false);
    assert.equal(central.requestBodies.some((body) => body.includes(dataKeyText)), false);
    for (const databasePath of [secondStore.databasePath, otherStore.databasePath]) {
      for (const suffix of ["", "-wal", "-shm"]) {
        const candidate = `${databasePath}${suffix}`;
        if (!fs.existsSync(candidate)) continue;
        assert.equal(fs.readFileSync(candidate).includes(Buffer.from(secret)), false);
      }
    }
  } finally {
    firstStore?.close();
    secondStore?.close();
    otherStore?.close();
    await central.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function startKeyAndProfileCentralStub(): Promise<{
  url: string;
  requestBodies: string[];
  profile(userId: number): ProfileSnapshot;
  close(): Promise<void>;
}> {
  const dataKeys = new Map<number, Buffer>();
  const profiles = new Map<number, ProfileSnapshot>();
  const challenges = new Map<string, {
    userId: number;
    deviceUuid: string;
    challenge: string;
    signingPayload: string;
    publicKey: string;
  }>();
  const requestBodies: string[] = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const rawBody = Buffer.concat(chunks).toString("utf8");
    if (rawBody) requestBodies.push(rawBody);
    const body = rawBody ? JSON.parse(rawBody) as Record<string, any> : {};
    const token = String(request.headers["x-token"] ?? "");
    const userId = Number(token.match(/^user-(\d+)-/)?.[1]);
    const send = (data: unknown, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: status === 200 ? 0 : status, data, msg: "" }));
    };
    if (!Number.isSafeInteger(userId)) return send(null, 401);

    if (request.url === "/api/tianjiang/v1/profile-key/challenges") {
      const challengeId = crypto.randomUUID();
      const challenge = crypto.randomBytes(24).toString("base64url");
      const signingPayload = [
        "tj-key-recovery:v1",
        challengeId,
        challenge,
        String(userId),
        String(body.deviceUuid),
      ].join(":");
      challenges.set(challengeId, {
        userId,
        deviceUuid: String(body.deviceUuid),
        challenge,
        signingPayload,
        publicKey: String(body.recoveryPublicKey),
      });
      return send({
        challengeId,
        challenge,
        signingPayload,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    }
    if (request.url === "/api/tianjiang/v1/profile-key/recover") {
      const challenge = challenges.get(String(body.challengeId));
      if (
        !challenge
        || challenge.userId !== userId
        || challenge.deviceUuid !== body.deviceUuid
        || challenge.challenge !== body.challenge
        || !crypto.verify(
          "sha256",
          Buffer.from(challenge.signingPayload),
          {
            key: challenge.publicKey,
            padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
            saltLength: 32,
          },
          Buffer.from(String(body.signature), "base64url"),
        )
      ) return send(null, 403);
      challenges.delete(String(body.challengeId));
      let dataKey = dataKeys.get(userId);
      if (!dataKey) {
        dataKey = crypto.randomBytes(32);
        dataKeys.set(userId, dataKey);
      }
      const binding = `tj-device-key:v1:${userId}:${body.deviceUuid}`;
      return send({
        deviceCiphertext: crypto.publicEncrypt({
          key: challenge.publicKey,
          oaepHash: "sha256",
          oaepLabel: Buffer.from(binding),
        }, dataKey).toString("base64url"),
        binding,
        keyVersion: "test-master-v1",
      });
    }
    if (request.url === "/api/tianjiang/v1/profile/versions/metadata" && request.method === "GET") {
      const profile = profiles.get(userId) ?? { version: 0, entries: {} };
      return send({ version: profile.version, etag: `profile-v${profile.version}` });
    }
    if (request.url === "/api/tianjiang/v1/profile/versions/latest" && request.method === "GET") {
      const profile = profiles.get(userId) ?? { version: 0, entries: {} };
      return send({ version: profile.version, snapshot: { entries: profile.entries } });
    }
    if (request.url === "/api/tianjiang/v1/profile/versions" && request.method === "POST") {
      const current = profiles.get(userId) ?? { version: 0, entries: {} };
      if (body.baseVersion !== current.version) return send(null, 409);
      const next: ProfileSnapshot = {
        version: current.version + 1,
        entries: structuredClone(body.snapshot.entries),
      };
      profiles.set(userId, next);
      return send({ version: next.version, snapshot: { entries: next.entries } });
    }
    return send(null, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试中央服务监听失败");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requestBodies,
    profile: (userId) => structuredClone(profiles.get(userId) ?? { version: 0, entries: {} }),
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())),
  };
}

function syntheticSession(userId: number): CentralSession {
  return {
    id: "session",
    serverUrl: "https://central.example.invalid",
    token: "token",
    expiresAt: Date.now() + 60_000,
    validatedAt: Date.now(),
    user: {
      id: userId,
      username: `user-${userId}`,
      nickname: "",
    },
  };
}
