/**
 * Round24 RED：生产 ProfileSync 登录前必须主动恢复 durable vendor outbox。
 * 只打 SyncCoordinator.onLogin / retryProfileSync，禁止 notifyAccountSettingsMutated，
 * 也禁止 login 后手工消费 outbox。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import test from "node:test";

import {
  CentralAuthGateway,
  createTestOnlyLoopbackPolicy,
  type CentralSession,
} from "../../src/tianjiang/auth/central-session";
import { KeyServiceUnavailableError } from "../../src/tianjiang/auth/key-service-error";
import { MemoryCredentialStore } from "../../src/tianjiang/crypto/credential-store";
import { ProfileCrypto } from "../../src/tianjiang/crypto/profile-crypto";
import { ProfileStore } from "../../src/tianjiang/data/profile-store";
import { SyncCoordinator } from "../../src/tianjiang/runtime/sync-coordinator";
import { runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import {
  accountDatabase,
  destroyAllDatabaseHandles,
  prepareUserDatabase,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import getPath from "../../src/utils/getPath";
import { closeActivatedWorkspaceRuntime, createUniqueWorktreeRoot } from "./helpers/worktree-runtime";

const ISSUER = "http://127.0.0.1:43240";
const identityA = { issuer: ISSUER, userId: 2401 };
const identityB = { issuer: ISSUER, userId: 2402 };
const OUTBOX = "o_profileVendorOutbox";
const LOGIN_VENDOR = "loginDrainVendor";

function stableUserUuid(issuer: string, userId: number): string {
  const hex = crypto
    .createHash("sha256")
    .update(`tianjiang-central-user:${issuer}:${userId}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function sessionFor(identity: { issuer: string; userId: number }, username: string): CentralSession {
  return {
    id: `r24-${identity.userId}`,
    serverUrl: identity.issuer,
    token: `token-${identity.userId}`,
    expiresAt: Date.now() + 60_000,
    validatedAt: Date.now(),
    user: { id: identity.userId, username, nickname: username },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-request-id": "r24-login-drain" },
  });
}

function vendorJson(id: string, apiKey: string): string {
  return JSON.stringify({
    id,
    inputValues: { apiKey },
    models: { custom: [], excluded: [] },
    enable: 1,
  });
}

class ProfileLoginStub {
  version: number;
  entries: Record<string, { value: string; sensitive: boolean }>;
  metadataCalls = 0;
  currentCalls = 0;
  commitCalls = 0;

  constructor(version = 1, entries: ProfileLoginStub["entries"] = {}) {
    this.version = version;
    this.entries = structuredClone(entries);
  }

  handle(pathname: string, init?: RequestInit): Response | undefined {
    if (pathname.endsWith("/devices/register")) return jsonResponse({ code: 0, data: {} });
    if (pathname.endsWith("/offline-grants")) {
      const token = new Headers(init?.headers).get("x-token") ?? "";
      const userId = token.endsWith("2402") ? identityB.userId : identityA.userId;
      return jsonResponse({
        code: 0,
        data: {
          grantId: "33333333-3333-4333-a333-333333333333",
          userId,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          revokedAt: null,
        },
      });
    }
    if (pathname.endsWith("/projects")) return jsonResponse({ code: 0, data: { projects: [] } });
    if (pathname.endsWith("/profile/versions/metadata")) {
      this.metadataCalls += 1;
      return jsonResponse({ code: 0, data: { version: this.version, etag: `profile-v${this.version}` } });
    }
    if (pathname.endsWith("/profile/versions/latest")) {
      this.currentCalls += 1;
      return jsonResponse({
        code: 0,
        data: { version: this.version, snapshot: { schemaVersion: 1, entries: this.entries } },
      });
    }
    if (pathname.endsWith("/profile/versions") && (init?.method ?? "GET").toUpperCase() === "POST") {
      this.commitCalls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        snapshot?: { entries?: ProfileLoginStub["entries"] };
      };
      this.version += 1;
      this.entries = structuredClone(body.snapshot?.entries ?? {});
      return jsonResponse({
        code: 0,
        data: { version: this.version, snapshot: { schemaVersion: 1, entries: this.entries } },
      });
    }
    return undefined;
  }
}

function encodeStore(
  dataRoot: string,
  userUuid: string,
  key: Buffer,
  write: (store: ProfileStore) => void,
): Record<string, { value: string; sensitive: boolean }> {
  const store = new ProfileStore(dataRoot, userUuid, new ProfileCrypto(userUuid, key));
  try {
    write(store);
    return store.exportStoredSnapshot();
  } finally {
    store.close();
  }
}

async function queueVendor(
  adapter: typeof import("../../src/tianjiang/sync/profile-settings-adapter"),
  mutation: { op: "upsert" | "delete"; id: string },
  apiKey = "sk-login-drain",
  writeRow = true,
): Promise<void> {
  await adapter.commitVendorConfigMutation(accountDatabase(), mutation, async (trx) => {
    if (!writeRow) return;
    if (mutation.op === "delete") {
      await trx("o_vendorConfig").where({ id: mutation.id }).del();
      return;
    }
    const exists = await trx("o_vendorConfig").where({ id: mutation.id }).first();
    if (exists) {
      await trx("o_vendorConfig").where({ id: mutation.id }).update({
        inputValues: JSON.stringify({ apiKey }),
        enable: 1,
      });
      return;
    }
    await trx("o_vendorConfig").insert({
      id: mutation.id,
      inputValues: JSON.stringify({ apiKey }),
      models: JSON.stringify({ custom: [], excluded: [] }),
      enable: 1,
    });
  });
}

async function readOutbox(): Promise<Array<Record<string, unknown>>> {
  const db = accountDatabase();
  if (!await db.schema.hasTable(OUTBOX)) return [];
  return db(OUTBOX).select("operationId", "sequence", "op", "vendorId", "status");
}

function liveVendorKey(decoded: Record<string, string>, id: string): string | undefined {
  return Object.keys(decoded).find((key) => key === `vendor.${id}`);
}

function decodeEntries(
  userUuid: string,
  key: Buffer,
  entries: Record<string, { value: string; sensitive: boolean }>,
): Record<string, string> {
  const cryptoBox = new ProfileCrypto(userUuid, key);
  const decoded: Record<string, string> = {};
  for (const [entryKey, entry] of Object.entries(entries)) {
    decoded[entryKey] = entry.sensitive
      ? cryptoBox.decrypt(entry.value)
      : entry.value.replace(/^plain:/, "");
  }
  return decoded;
}

async function withLoginWorld<T>(
  label: string,
  run: (ctx: {
    dataRoot: string;
    adapter: typeof import("../../src/tianjiang/sync/profile-settings-adapter");
    profileKey: Buffer;
    userUuid: string;
    keyBox: { available: boolean };
    openCoordinator: (options?: {
      identity?: { issuer: string; userId: number };
      stub?: ProfileLoginStub;
    }) => SyncCoordinator;
  }) => Promise<T>,
): Promise<T> {
  const root = createUniqueWorktreeRoot(label);
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";
  const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
  const coordinators: SyncCoordinator[] = [];
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    const dataRoot = getPath();
    const profileKey = Buffer.alloc(32, 0x24);
    const userUuid = stableUserUuid(identityA.issuer, identityA.userId);
    const keyBox = { available: true };
    const openCoordinator = (options?: {
      identity?: { issuer: string; userId: number };
      stub?: ProfileLoginStub;
    }) => {
      const identity = options?.identity ?? identityA;
      const stub = options?.stub ?? new ProfileLoginStub();
      const coordinator = new SyncCoordinator(
        dataRoot,
        new CentralAuthGateway(async (input, init) => {
          const pathname = new URL(String(input)).pathname;
          const handled = stub.handle(pathname, init);
          if (handled) return handled;
          return jsonResponse({ code: 404, msg: `unexpected path: ${pathname}` }, 404);
        }, createTestOnlyLoopbackPolicy(ISSUER)),
        new MemoryCredentialStore(),
        {
          createKeyRecoveryClient: () => ({
            deviceIdentity: () => ({ publicKey: "r24-public", publicFingerprint: "r24-fp" }),
            loadOrRecover: async () => {
              if (!keyBox.available) throw new KeyServiceUnavailableError();
              return profileKey;
            },
          }),
        },
      );
      coordinators.push(coordinator);
      Object.assign(coordinator, { __stub: stub, __identity: identity });
      return coordinator;
    };
    return await run({ dataRoot, adapter, profileKey, userUuid, keyBox, openCoordinator });
  } finally {
    adapter.bindAccountProfileSync(null);
    for (const coordinator of coordinators) {
      await coordinator.shutdown().catch(() => undefined);
    }
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
}

test("1. 同版本 queued upsert：生产 onLogin 返回前必须上传 live 并确认 outbox", async () => {
  await withLoginWorld("r24-same-ver", async ({ dataRoot, adapter, profileKey, userUuid, openCoordinator }) => {
    await prepareUserDatabase(identityA);
    await runWithUserStorage(identityA, () => queueVendor(adapter, { op: "upsert", id: LOGIN_VENDOR }, "sk-login-drain"));
    const seeded = encodeStore(dataRoot, userUuid, profileKey, (store) => {
      store.set(`deleted.vendor.${LOGIN_VENDOR}`, JSON.stringify({ $tombstone: true, id: LOGIN_VENDOR }), false);
      store.applyStoredSnapshot(store.exportStoredSnapshot(), 1);
    });
    const stub = new ProfileLoginStub(1, seeded);
    const coordinator = openCoordinator({ stub });
    await coordinator.onLogin(sessionFor(identityA, "alice"));
    const decoded = decodeEntries(userUuid, profileKey, stub.entries);
    assert.equal(
      liveVendorKey(decoded, LOGIN_VENDOR),
      `vendor.${LOGIN_VENDOR}`,
      "本机/远端同版本 queued upsert 必须在生产 login 返回前变成 live",
    );
    assert.match(decoded[`vendor.${LOGIN_VENDOR}`] ?? "", /sk-login-drain/);
    assert.equal(decoded[`deleted.vendor.${LOGIN_VENDOR}`], undefined, "历史 tombstone 必须清除");
    assert.ok(stub.commitCalls > 0, "login 返回前必须已上传 pending");
    const box = await runWithUserStorage(identityA, readOutbox);
    assert.ok(
      box.some((row) => row.vendorId === LOGIN_VENDOR && row.status === "profile_written"),
      `outbox 必须在 login 返回前确认，实际=${JSON.stringify(box)}`,
    );
  });
});

test("2. 远端较新 tombstone + 无关设置：queued upsert 必须先转 pending 且不得被远端删掉", async () => {
  await withLoginWorld("r24-remote-newer", async ({ dataRoot, adapter, profileKey, userUuid, openCoordinator }) => {
    await prepareUserDatabase(identityA);
    await runWithUserStorage(identityA, () => queueVendor(adapter, { op: "upsert", id: LOGIN_VENDOR }, "sk-keep-local"));
    encodeStore(dataRoot, userUuid, profileKey, (store) => {
      store.set("language", "en", false);
      store.applyStoredSnapshot(store.exportStoredSnapshot(), 1);
    });
    const remoteEntries = encodeStore(path.join(dataRoot, "r24-remote-b"), userUuid, profileKey, (store) => {
      store.set(`deleted.vendor.${LOGIN_VENDOR}`, JSON.stringify({ $tombstone: true, id: LOGIN_VENDOR }), false);
      store.set("language", "ja", false);
    });
    const stub = new ProfileLoginStub(5, remoteEntries);
    const coordinator = openCoordinator({ stub });
    await coordinator.onLogin(sessionFor(identityA, "alice"));
    const decoded = decodeEntries(userUuid, profileKey, stub.entries);
    assert.equal(
      liveVendorKey(decoded, LOGIN_VENDOR),
      `vendor.${LOGIN_VENDOR}`,
      "远端较新 tombstone 不得删除本机 queued upsert",
    );
    assert.equal(decoded.language, "ja", "无关远端设置必须保留");
    assert.equal(decoded[`deleted.vendor.${LOGIN_VENDOR}`], undefined);
  });
});

test("3. queued delete 与远端较新 live 冲突时，明确删除必须获胜", async () => {
  await withLoginWorld("r24-queued-delete", async ({ dataRoot, adapter, profileKey, userUuid, openCoordinator }) => {
    await prepareUserDatabase(identityA);
    await runWithUserStorage(identityA, async () => {
      await queueVendor(adapter, { op: "upsert", id: LOGIN_VENDOR }, "sk-will-delete");
      await queueVendor(adapter, { op: "delete", id: LOGIN_VENDOR });
    });
    encodeStore(dataRoot, userUuid, profileKey, (store) => {
      store.applyStoredSnapshot({}, 1);
    });
    const remoteEntries = encodeStore(path.join(dataRoot, "r24-remote-c"), userUuid, profileKey, (store) => {
      store.set(`vendor.${LOGIN_VENDOR}`, vendorJson(LOGIN_VENDOR, "sk-remote-old"), true);
    });
    const stub = new ProfileLoginStub(4, remoteEntries);
    await openCoordinator({ stub }).onLogin(sessionFor(identityA, "alice"));
    const decoded = decodeEntries(userUuid, profileKey, stub.entries);
    assert.equal(decoded[`vendor.${LOGIN_VENDOR}`], undefined, "远端旧 live 不得复活");
    assert.ok(
      Object.keys(decoded).some((key) => key.startsWith("deleted.vendor")),
      "明确 delete 必须留下 tombstone",
    );
  });
});

test("4. B 的生产登录不得消费 A 的 outbox", async () => {
  await withLoginWorld("r24-isolate-b", async ({ adapter, openCoordinator }) => {
    await prepareUserDatabase(identityA);
    await prepareUserDatabase(identityB);
    await runWithUserStorage(identityA, () => queueVendor(adapter, { op: "upsert", id: LOGIN_VENDOR }, "sk-only-a"));
    const stub = new ProfileLoginStub(0, {});
    await openCoordinator({ identity: identityB, stub }).onLogin(sessionFor(identityB, "bob"));
    const aBox = await runWithUserStorage(identityA, readOutbox);
    assert.ok(
      aBox.some((row) => row.vendorId === LOGIN_VENDOR && row.status === "queued"),
      `A 的 queued outbox 必须仍在，实际=${JSON.stringify(aBox)}`,
    );
    const decodedKeys = Object.keys(stub.entries);
    assert.equal(
      decodedKeys.some((key) => key.includes(LOGIN_VENDOR)),
      false,
      "B 登录不得上传 A 的 vendor",
    );
  });
});

test("5. keyRecovery retry 路径也必须在 login 前恢复 outbox", async () => {
  await withLoginWorld("r24-key-retry", async ({ adapter, keyBox, openCoordinator }) => {
    await prepareUserDatabase(identityA);
    const stub = new ProfileLoginStub(0, {});
    keyBox.available = false;
    const coordinator = openCoordinator({ stub });
    const first = await coordinator.onLogin(sessionFor(identityA, "alice"));
    assert.equal(first.keyServiceDegraded, true);
    await runWithUserStorage(identityA, () => queueVendor(adapter, { op: "upsert", id: LOGIN_VENDOR }, "sk-retry-path"));
    stub.metadataCalls = 0;
    stub.currentCalls = 0;
    stub.commitCalls = 0;
    keyBox.available = true;
    await coordinator.retryProfileSync(sessionFor(identityA, "alice"));
    const decodedKeys = Object.keys(stub.entries);
    assert.equal(
      decodedKeys.includes(`vendor.${LOGIN_VENDOR}`) ? `vendor.${LOGIN_VENDOR}` : undefined,
      `vendor.${LOGIN_VENDOR}`,
      "retryKeyRecovery 必须在 login 前恢复 queued upsert",
    );
  });
});

test("6. 无 queued outbox 的正常登录只读 metadata，不得拉 current", async () => {
  await withLoginWorld("r24-no-outbox", async ({ dataRoot, profileKey, userUuid, openCoordinator }) => {
    await prepareUserDatabase(identityA);
    encodeStore(dataRoot, userUuid, profileKey, (store) => {
      store.set("language", "zh", false);
      store.applyStoredSnapshot(store.exportStoredSnapshot(), 1);
    });
    const stub = new ProfileLoginStub(1, encodeStore(dataRoot, userUuid, profileKey, () => undefined));
    await openCoordinator({ stub }).onLogin(sessionFor(identityA, "alice"));
    assert.equal(stub.metadataCalls, 1, "无 outbox 时 metadata 必须恰好 1 次");
    assert.equal(stub.currentCalls, 0, "无 outbox 时不得请求 current");
    assert.equal(stub.commitCalls, 0, "无 outbox 时不得提交远端");
  });
});

test("7. queued upsert 缺本机行必须在远端 reconcile 前 fail-closed，且错误不含密钥", async () => {
  await withLoginWorld("r24-missing-row", async ({ adapter, openCoordinator }) => {
    await prepareUserDatabase(identityA);
    await runWithUserStorage(identityA, () => queueVendor(
      adapter,
      { op: "upsert", id: LOGIN_VENDOR },
      "sk-must-not-leak",
      false,
    ));
    const stub = new ProfileLoginStub(1, {});
    const coordinator = openCoordinator({ stub });
    await assert.rejects(
      () => coordinator.onLogin(sessionFor(identityA, "alice")),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.doesNotMatch(message, /sk-must-not-leak|apiKey|inputValues|token|cookie/i);
        return true;
      },
    );
    assert.equal(stub.metadataCalls, 0, "缺本机行时不得进入远端 metadata");
    assert.equal(stub.currentCalls, 0, "缺本机行时不得进入远端 current");
    assert.equal(stub.commitCalls, 0, "缺本机行时不得提交");
    const box = await runWithUserStorage(identityA, readOutbox);
    assert.ok(
      box.some((row) => row.vendorId === LOGIN_VENDOR && row.status === "queued"),
      "失败时 outbox 必须仍为 queued",
    );
  });
});
