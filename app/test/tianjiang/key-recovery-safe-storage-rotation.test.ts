import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  MemoryCredentialStore,
  ScopedCredentialStore,
  unreadableBackupKey,
} from "../../src/tianjiang/crypto/credential-store";
import {
  PROFILE_KEY_RECOVERY_FAILED_MESSAGE,
  UserKeyRecoveryClient,
} from "../../src/tianjiang/crypto/user-key-recovery";
import type { CentralSession } from "../../src/tianjiang/auth/central-session";

const userUUID = "018f3d6e-2d9e-7b6c-8a9b-1234567890ab";
const deviceUUID = "018f3d6e-2d9e-7b6c-8a9b-1234567890ac";
const userBUUID = "018f3d6e-2d9e-7b6c-8a9b-1234567890bb";

function syntheticSession(userId: number): CentralSession {
  return {
    id: `session-${userId}`,
    serverUrl: "https://api.j11.com.cn",
    token: `token-${userId}`,
    expiresAt: Date.now() + 3_600_000,
    user: { id: userId, username: `u${userId}`, nickname: `U${userId}` },
    validatedAt: Date.now(),
  };
}

function mockGateway(dataKey: Buffer, deviceUUID: string, userId: number) {
  let registeredPublicKey = "";
  const calls: string[] = [];
  return {
    calls,
    get registeredPublicKey() {
      return registeredPublicKey;
    },
    setRegistered(publicKey: string) {
      registeredPublicKey = publicKey;
    },
    gateway: {
      forwardBusinessRequest: async (
        _session: CentralSession,
        pathName: string,
        _method: string,
        body?: unknown,
      ): Promise<unknown> => {
        calls.push(pathName);
        if (pathName.endsWith("/challenges")) {
          const pk = String((body as Record<string, unknown>).recoveryPublicKey ?? registeredPublicKey);
          registeredPublicKey = pk;
          return {
            challengeId: "11111111-1111-4111-a111-111111111111",
            challenge: "challenge-nonce",
            signingPayload: `tj-key-recovery:v1:11111111-1111-4111-a111-111111111111:challenge-nonce:${userId}:${deviceUUID}`,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          };
        }
        const publicKey = crypto.createPublicKey(registeredPublicKey);
        return {
          deviceCiphertext: crypto.publicEncrypt({
            key: publicKey,
            oaepHash: "sha256",
            oaepLabel: Buffer.from(`tj-device-key:v1:${userId}:${deviceUUID}`, "utf8"),
          }, dataKey).toString("base64url"),
          binding: `tj-device-key:v1:${userId}:${deviceUUID}`,
          keyVersion: "master-v1",
        };
      },
    },
  };
}

test("设备公私钥不可读时备份密文、轮换密钥对并可继续恢复", async () => {
  const dataKey = crypto.randomBytes(32);
  const credentials = new MemoryCredentialStore();
  const session = syntheticSession(7);
  const mock = mockGateway(dataKey, deviceUUID, 7);

  const first = new UserKeyRecoveryClient(mock.gateway, session, deviceUUID, credentials);
  const identity1 = first.deviceIdentity();
  mock.setRegistered(identity1.publicKey);
  assert.equal(identity1.rotated, true); // 首次生成也算“缺失后写入”
  await first.loadOrRecover(userUUID);

  // 模拟跨运行形态：设备密钥不可读
  credentials.markUndecryptable(`device-recovery-private:${deviceUUID}`);
  credentials.markUndecryptable(`device-recovery-public:${deviceUUID}`);

  const second = new UserKeyRecoveryClient(mock.gateway, session, deviceUUID, credentials);
  const identity2 = second.deviceIdentity();
  assert.equal(identity2.rotated, true);
  assert.notEqual(identity2.publicKey, identity1.publicKey);
  assert.equal(
    credentials.has(unreadableBackupKey(`device-recovery-private:${deviceUUID}`)),
    true,
  );
  // 幂等：再次 deviceIdentity 不应再生成第三套（新密钥可读）
  const identity3 = second.deviceIdentity();
  assert.equal(identity3.publicKey, identity2.publicKey);
  assert.equal(identity3.rotated, false);

  mock.setRegistered(identity2.publicKey);
  // profile-key 也不可读 → 中央恢复同一 32 字节
  credentials.markUndecryptable(`profile-key:${userUUID}`);
  const recovered = await second.loadOrRecover(userUUID);
  assert.deepEqual(recovered, dataKey);
  assert.equal(
    credentials.has(unreadableBackupKey(`profile-key:${userUUID}`)),
    true,
  );
});

test("中央恢复失败不覆盖 unreadable-backup", async () => {
  const credentials = new MemoryCredentialStore();
  credentials.set(`profile-key:${userUUID}`, "old-ciphertext-value");
  credentials.markUndecryptable(`profile-key:${userUUID}`);
  const session = syntheticSession(7);
  const gateway = {
    forwardBusinessRequest: async () => {
      throw new Error("central 500 internal");
    },
  };
  const client = new UserKeyRecoveryClient(gateway, session, deviceUUID, credentials);
  // 先确保有设备密钥
  client.deviceIdentity();
  await assert.rejects(
    () => client.loadOrRecover(userUUID),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, PROFILE_KEY_RECOVERY_FAILED_MESSAGE);
      assert.doesNotMatch(error.message, /central 500|internal/i);
      return true;
    },
  );
  assert.equal(
    credentials.getCiphertext(unreadableBackupKey(`profile-key:${userUUID}`)),
    "old-ciphertext-value",
  );
  // 失败不得写入新的可读 profile-key（仍为 undecryptable 原键或已备份）
  assert.throws(() => credentials.get(`profile-key:${userUUID}`));
});

test("A/B 账号 profile-key 隔离：恢复 A 不影响 B", async () => {
  const keyA = crypto.randomBytes(32);
  const keyB = crypto.randomBytes(32);
  const credentials = new MemoryCredentialStore();
  const mockA = mockGateway(keyA, deviceUUID, 7);
  const mockB = mockGateway(keyB, deviceUUID, 8);

  const clientA = new UserKeyRecoveryClient(mockA.gateway, syntheticSession(7), deviceUUID, credentials);
  mockA.setRegistered(clientA.deviceIdentity().publicKey);
  assert.deepEqual(await clientA.loadOrRecover(userUUID), keyA);

  const clientB = new UserKeyRecoveryClient(mockB.gateway, syntheticSession(8), deviceUUID, credentials);
  // 同设备密钥对复用
  mockB.setRegistered(clientB.deviceIdentity().publicKey);
  assert.deepEqual(await clientB.loadOrRecover(userBUUID), keyB);

  credentials.markUndecryptable(`profile-key:${userUUID}`);
  mockA.setRegistered(clientA.deviceIdentity().publicKey);
  assert.deepEqual(await clientA.loadOrRecover(userUUID), keyA);
  // B 仍可读原密钥
  assert.deepEqual(await clientB.loadOrRecover(userBUUID), keyB);
});

test("开发态 scope → 打包 scope 共用隔离 userData 后可恢复同一 profile key", async () => {
  const root = path.resolve(process.cwd(), "..", ".local", "profile", "safe-storage-migration-acceptance");
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, "secure-credentials.json");
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // ignore
  }

  const dataKey = crypto.randomBytes(32);
  const dev = new ScopedCredentialStore(file, "dev-electron");
  const mock = mockGateway(dataKey, deviceUUID, 7);
  const session = syntheticSession(7);

  const writer = new UserKeyRecoveryClient(mock.gateway, session, deviceUUID, dev);
  mock.setRegistered(writer.deviceIdentity().publicKey);
  assert.deepEqual(await writer.loadOrRecover(userUUID), dataKey);

  // RED 形态：打包 scope 直接读失败
  const packaged = new ScopedCredentialStore(file, "packaged-exe");
  assert.throws(() => packaged.get(`profile-key:${userUUID}`));
  assert.throws(() => packaged.get(`device-recovery-private:${deviceUUID}`));

  // GREEN：轮换设备密钥 + 中央恢复同一 key
  const recovery = new UserKeyRecoveryClient(mock.gateway, session, deviceUUID, packaged);
  const id = recovery.deviceIdentity();
  assert.equal(id.rotated, true);
  mock.setRegistered(id.publicKey);
  const recovered = await recovery.loadOrRecover(userUUID);
  assert.deepEqual(recovered, dataKey);
  // 备份存在且原文件未整文件删除
  assert.ok(fs.existsSync(file));
  assert.equal(packaged.has(unreadableBackupKey(`profile-key:${userUUID}`)), true);
});
