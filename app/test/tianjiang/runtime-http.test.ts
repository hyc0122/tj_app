import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test, { after, before } from "node:test";
import { io as connectSocket } from "socket.io-client";
import Database from "better-sqlite3";
import crypto from "node:crypto";
import { assertSQLiteHasNoImageBase64 } from "../../src/tianjiang/media/media-safety";
import { localLegacyProjectId } from "../../src/tianjiang/runtime/local-project-id";
import { readPendingLegacyMutationIntent } from "../../src/tianjiang/runtime/pending-legacy-mutation-intent";
import { ENGINE_IO_PATH } from "../../src/tianjiang/socket-path";

interface CentralRequest {
  method: string;
  pathname: string;
  body: Record<string, unknown>;
  token: string;
}

const appRoot = path.resolve(__dirname, "../..");
// Windows SQLite 对超长嵌套路径支持不稳定；临时数据仍严格留在工作树内，并使用短目录名。
const workspaceTempRoot = path.resolve(appRoot, "..", ".tmp");
fs.mkdirSync(workspaceTempRoot, { recursive: true });
const tempRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "rh-"));
const centralRequests: CentralRequest[] = [];
let centralServer: http.Server;
let centralURL = "";
let appProcess: ChildProcessWithoutNullStreams;
let appURL = "";
let sessionCookie = "";
let catalogMode: "normal" | "unknown-role" | "non-owner" = "normal";
/** 登录后中央目录可增量注入，用于验证 refresh 后可立即打开。 */
let extraCatalogProjects: Array<Record<string, unknown>> = [];
let catalogFailOnce = false;
let grantLifetimeMs = 3_600_000;
let grantRevoked = false;
const remoteProjectVersions = new Map<string, number>();
let currentUploadProject = "";
const UPLOAD_SESSION_UUID = "88888888-8888-4888-a888-888888888888";
let lastUploadedProjectObject = Buffer.alloc(0);
let initialRemoteProjectObject = Buffer.alloc(0);
const remoteProjectObjects = new Map<string, Buffer>();
let appLogs = "";
const centralDevicePublicKeys = new Map<number, string>();
const centralUserDataKeys = new Map<number, Buffer>();
const centralChallenges = new Map<number, { id: string; nonce: string; deviceUuid: string }>();
const PERSONAL_PROJECT_UUID = "11111111-1111-4111-a111-111111111111";
const VIEWER_PROJECT_UUID = "22222222-2222-4222-a222-222222222222";
const EDITOR_PROJECT_UUID = "33333333-3333-4333-a333-333333333333";
const RELEASE_PROJECT_UUID = "44444444-4444-4444-a444-444444444444";
const BOB_PROJECT_UUID = "55555555-5555-4555-a555-555555555555";
const PERSONAL_LOCAL_ID = localLegacyProjectId(PERSONAL_PROJECT_UUID);
const VIEWER_LOCAL_ID = localLegacyProjectId(VIEWER_PROJECT_UUID);
const EDITOR_LOCAL_ID = localLegacyProjectId(EDITOR_PROJECT_UUID);
const RELEASE_LOCAL_ID = localLegacyProjectId(RELEASE_PROJECT_UUID);
const BOB_LOCAL_ID = localLegacyProjectId(BOB_PROJECT_UUID);

function runtimeUserSegment(userId: number): string {
  return crypto
    .createHash("sha256")
    .update(`tianjiang-central-user:${centralURL.replace(/\/$/, "")}:${userId}`)
    .digest("hex")
    .slice(0, 32);
}

before(async () => {
  // 中文注释：中央测试桩必须返回真实 SQLite 与真实摘要，禁止用占位字符串绕过下载校验。
  const remoteFixturePath = path.join(tempRoot, "central-project.sqlite");
  const remoteFixture = new Database(remoteFixturePath);
  remoteFixture.exec(`
    CREATE TABLE project_records (
      namespace TEXT NOT NULL,
      record_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(namespace, record_key)
    );
    CREATE TABLE project_metadata (
      metadata_key TEXT PRIMARY KEY,
      metadata_value TEXT NOT NULL
    );
  `);
  remoteFixture.close();
  initialRemoteProjectObject = fs.readFileSync(remoteFixturePath);

  // 测试先执行正式构建，再启动被 Git 忽略的真实 data/serve/app.js 产物。
  const build = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "yarn.cmd build"], {
    cwd: appRoot,
    encoding: "utf8",
  });
  assert.equal(build.status, 0, `生产构建失败:\n${build.stdout}\n${build.stderr}`);

  // 验收中央服务只允许显式 HTTP 127.0.0.1，测试不再生成或信任自签证书。
  centralServer = http.createServer(async (request, response) => {
    const body = await readJSON(request);
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const token = String(request.headers["x-token"] ?? "");
    centralRequests.push({ method: request.method ?? "GET", pathname, body, token });
    response.setHeader("content-type", "application/json");

    if (pathname.startsWith("/synthetic-upload/") && request.method === "PUT") {
      return response.end(JSON.stringify({ code: 0, data: null }));
    }
    if (pathname.startsWith("/synthetic-download/") && request.method === "GET") {
      const projectUUID = decodeURIComponent(pathname.split("/").at(-1) ?? "");
      response.setHeader("content-type", "application/octet-stream");
      return response.end(remoteProjectObjects.get(projectUUID) ?? initialRemoteProjectObject);
    }

    if (pathname === "/api/tianjiang/v1/auth/login") {
      const username = String(body.username ?? "");
      const userId = username === "bob" ? 8 : username === "charlie" ? 9 : 7;
      return response.end(JSON.stringify({
        code: 0,
        data: {
          token: `synthetic-central-session-${username}`,
          expiresAt: Date.now() + 600_000,
          user: { id: userId, username, nickname: username },
        },
      }));
    }
    if (pathname === "/api/tianjiang/v1/session") {
      const username = token.endsWith("-bob") ? "bob" : token.endsWith("-charlie") ? "charlie" : "alice";
      const userId = username === "bob" ? 8 : username === "charlie" ? 9 : 7;
      return response.end(JSON.stringify({
        code: 0,
        data: { userId, username },
      }));
    }
    if (pathname === "/api/tianjiang/v1/devices/register") {
      const userId = token.endsWith("-bob") ? 8 : token.endsWith("-charlie") ? 9 : 7;
      centralDevicePublicKeys.set(userId, String(body.recoveryPublicKey ?? ""));
      return response.end(JSON.stringify({ code: 0, data: { deviceUuid: body.deviceUuid } }));
    }
    if (pathname === "/api/tianjiang/v1/profile-key/challenges") {
      const userId = token.endsWith("-bob") ? 8 : token.endsWith("-charlie") ? 9 : 7;
      const nonce = crypto.randomBytes(24).toString("base64url");
      const id = crypto.randomUUID();
      const deviceUuid = String(body.deviceUuid ?? "");
      centralChallenges.set(userId, { id, nonce, deviceUuid });
      return response.end(JSON.stringify({
        code: 0,
        data: {
          challengeId: id,
          challenge: nonce,
          signingPayload: `tj-key-recovery:v1:${id}:${nonce}:${userId}:${deviceUuid}`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      }));
    }
    if (pathname === "/api/tianjiang/v1/profile-key/recover") {
      const userId = token.endsWith("-bob") ? 8 : token.endsWith("-charlie") ? 9 : 7;
      const challenge = centralChallenges.get(userId);
      const publicKey = centralDevicePublicKeys.get(userId);
      assert.ok(challenge && publicKey, "恢复前必须完成设备登记和挑战");
      assert.equal(body.challengeId, challenge.id);
      assert.equal(body.challenge, challenge.nonce);
      const signingPayload = `tj-key-recovery:v1:${challenge.id}:${challenge.nonce}:${userId}:${challenge.deviceUuid}`;
      assert.equal(crypto.verify("sha256", Buffer.from(signingPayload), {
        key: publicKey,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: 32,
      }, Buffer.from(String(body.signature), "base64url")), true);
      const dataKey = centralUserDataKeys.get(userId) ?? crypto.randomBytes(32);
      centralUserDataKeys.set(userId, dataKey);
      const binding = `tj-device-key:v1:${userId}:${challenge.deviceUuid}`;
      return response.end(JSON.stringify({
        code: 0,
        data: {
          deviceCiphertext: crypto.publicEncrypt({
            key: publicKey,
            oaepHash: "sha256",
            oaepLabel: Buffer.from(binding),
          }, dataKey).toString("base64url"),
          binding,
          keyVersion: "test-master-v1",
        },
      }));
    }
    if (pathname === "/api/tianjiang/v1/offline-grants") {
      const userId = token.endsWith("-bob") ? 8 : token.endsWith("-charlie") ? 9 : 7;
      return response.end(JSON.stringify({
        code: 0,
        data: {
          grantId: "99999999-9999-4999-a999-999999999999",
          userId,
          expiresAt: new Date(Date.now() + grantLifetimeMs).toISOString(),
          revokedAt: grantRevoked ? new Date().toISOString() : null,
        },
      }));
    }
    if (pathname === "/api/tianjiang/v1/profile/versions/metadata") {
      return response.end(JSON.stringify({ code: 0, data: { version: 2, etag: "profile-v2" } }));
    }
    if (pathname === "/api/tianjiang/v1/profile/versions/latest") {
      return response.end(JSON.stringify({ code: 0, data: { version: 2, entries: {} } }));
    }
    if (pathname === "/api/tianjiang/v1/profile/versions") {
      return response.end(JSON.stringify({
        code: 0,
        data: {
          version: 3,
          snapshot: body.snapshot,
        },
      }));
    }
    if (pathname === "/api/tianjiang/v1/projects") {
      if (catalogMode === "unknown-role") {
        return response.end(JSON.stringify({
          code: 0,
          data: {
            projects: [{
              projectUuid: "66666666-6666-4666-a666-666666666666",
              name: "字段漂移项目",
              kind: "team",
              ownerUserId: 8,
              myRole: "maintainer",
              currentVersion: 1,
            }],
          },
        }));
      }
      if (catalogMode === "non-owner") {
        return response.end(JSON.stringify({
          code: 0,
          data: {
            projects: [{
              projectUuid: "77777777-7777-4777-a777-777777777777",
              name: "非本人个人项目",
              kind: "personal",
              ownerUserId: 88,
              myRole: "owner",
              businessType: "script",
              currentVersion: 1,
            }],
          },
        }));
      }
      if (token.endsWith("-bob")) {
        return response.end(JSON.stringify({
          code: 0,
          data: {
            projects: [{
              projectUuid: "55555555-5555-4555-a555-555555555555",
              name: "Bob 的个人项目",
              kind: "personal",
              ownerUserId: 8,
              myRole: "owner",
              businessType: "script",
              currentVersion: 1,
            }],
          },
        }));
      }
      if (catalogFailOnce) {
        catalogFailOnce = false;
        response.statusCode = 503;
        return response.end(JSON.stringify({ code: 7, msg: "catalog unavailable" }));
      }
      return response.end(JSON.stringify({
        code: 0,
        data: {
          projects: [{
            projectUuid: "11111111-1111-4111-a111-111111111111",
            name: "个人项目",
            kind: "personal",
            ownerUserId: 7,
            myRole: "owner",
            businessType: "novel",
            currentVersion: 3,
          },
          {
            projectUuid: "22222222-2222-4222-a222-222222222222",
            name: "团队只读项目",
            kind: "team",
            ownerUserId: 8,
            myRole: "viewer",
            businessType: "script",
            currentVersion: 4,
            syncState: "readonly",
            lastSyncedAt: "2026-07-30T00:00:00Z",
            updatedAt: "2026-07-30T00:01:00Z",
            lockStatus: "active",
            lockHolderName: "林编辑",
            openMode: "readonly",
          },
          {
            projectUuid: "33333333-3333-4333-a333-333333333333",
            name: "团队编辑项目",
            kind: "team",
            ownerUserId: 8,
            myRole: "editor",
            businessType: "script",
            currentVersion: 5,
          },
          {
            projectUuid: "44444444-4444-4444-a444-444444444444",
            name: "团队发布项目",
            kind: "team",
            ownerUserId: 8,
            myRole: "editor",
            businessType: "script",
            currentVersion: 5,
          },
          ...extraCatalogProjects],
        },
      }));
    }
    if (/\/api\/tianjiang\/v1\/projects\/[^/]+\/lock$/.test(pathname) && request.method === "POST") {
      return response.end(JSON.stringify({
        code: 0,
        data: { lockId: "lock-editor", fencingToken: 8, expiresAt: new Date(Date.now() + 60_000).toISOString() },
      }));
    }
    if (/\/api\/tianjiang\/v1\/projects\/[^/]+$/.test(pathname)) {
      const projectUUID = pathname.split("/").at(-1) ?? "";
      const object = remoteProjectObjects.get(projectUUID) ?? initialRemoteProjectObject;
      return response.end(JSON.stringify({
        code: 0,
        data: {
          version: remoteProjectVersions.get(projectUUID) ?? 5,
          objects: [{
            relativePath: "project.sqlite",
            md5: crypto.createHash("md5").update(object).digest("hex"),
            size: object.length,
          }],
          records: {},
        },
      }));
    }
    if (/\/api\/tianjiang\/v1\/projects\/[^/]+\/upload-sessions$/.test(pathname)) {
      currentUploadProject = pathname.split("/").at(-2) ?? "";
      assert.equal(typeof body.deviceUuid, "string");
      assert.equal(Array.isArray(body.objects) && body.objects.length > 0, true);
      // 中文注释：中央权威增量——默认要求上传全部候选（夹具无历史版本差分时全量 required）。
      const planned = body.objects as Array<Record<string, unknown>>;
      return response.end(JSON.stringify({
        code: 0,
        data: {
          sessionUuid: UPLOAD_SESSION_UUID,
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          objects: planned.map((item) => ({
            relativePath: item.relativePath,
            size: item.size,
            md5: item.md5,
            objectKey: `staging/${String(item.relativePath)}`,
            verified: false,
          })),
          requiredUploadObjects: planned.map((item) => String(item.relativePath)),
        },
      }));
    }
    if (pathname === "/api/tianjiang/v1/object-authorizations" && body.method === "PUT") {
      return response.end(JSON.stringify({
        code: 0,
        data: {
          url: `${centralURL}/synthetic-upload/${String(body.sessionUuid)}/${encodeURIComponent(String(body.relativePath))}`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          // 正式 V4 授权会签入 Content-MD5；模拟中央必须返回完全相同的签名头。
          signedHeaders: { "Content-Md5": String(body.contentMd5 ?? "") },
        },
      }));
    }
    if (pathname === "/api/tianjiang/v1/object-authorizations" && body.method === "GET") {
      return response.end(JSON.stringify({
        code: 0,
        data: {
          url: `${centralURL}/synthetic-download/${encodeURIComponent(String(body.projectUuid))}`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      }));
    }
    if (pathname === `/api/tianjiang/v1/upload-sessions/${UPLOAD_SESSION_UUID}/objects/confirm`) {
      return response.end(JSON.stringify({ code: 0, data: null }));
    }
    if (pathname === `/api/tianjiang/v1/upload-sessions/${UPLOAD_SESSION_UUID}/fail`) {
      return response.end(JSON.stringify({ code: 0, data: null }));
    }
    if (pathname === `/api/tianjiang/v1/upload-sessions/${UPLOAD_SESSION_UUID}/commit`) {
      const nextVersion = (remoteProjectVersions.get(currentUploadProject) ?? 5) + 1;
      remoteProjectVersions.set(currentUploadProject, nextVersion);
      const manifest = body.manifest as Record<string, unknown>;
      assert.equal(manifest.schema_version, 1);
      assert.equal(manifest.project_uuid, currentUploadProject);
      assert.equal(body.deviceUuid !== undefined, true);
      return response.end(JSON.stringify({
        code: 0,
        data: { version: nextVersion, manifest, objects: [] },
      }));
    }
    if (pathname === "/synthetic/generation" && request.method === "POST") {
      return response.end(JSON.stringify({ taskId: "route-created-remote-task" }));
    }
    if (pathname === "/synthetic/status") {
      return response.end(JSON.stringify({ state: "completed" }));
    }
    if (/\/api\/tianjiang\/v1\/projects\/[^/]+\/lock$/.test(pathname) && request.method === "DELETE") {
      return response.end(JSON.stringify({ code: 0, data: null }));
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ code: 7, msg: `未实现: ${pathname}` }));
  });
  await listen(centralServer);
  const address = centralServer.address();
  centralURL = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  appProcess = await startApp(path.join(appRoot, "data", "serve", "app.js"));
});

after(async () => {
  await stopApp();
  await new Promise<void>((resolve) => centralServer?.close(() => resolve()));
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // Windows 偶尔会延迟释放子进程工作目录；临时目录由系统后续清理。
  }
});

test("登录 HTTP 按设备登记、配置同步、项目目录顺序初始化且不下载正文", async () => {
  const response = await fetch(`${appURL}/api/tianjiang/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "alice",
      password: "synthetic-password",
      captcha: "",
      captchaId: "",
    }),
  });
  const loginBody = await response.clone().json();
  assert.equal(response.status, 200, `登录失败: ${JSON.stringify(loginBody)}\n${appLogs.slice(-2000)}`);
  sessionCookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  assert.notEqual(sessionCookie, "");

  const runtimeCalls = centralRequests
    .map((item) => item.pathname)
    .filter((pathname) => [
      "/api/tianjiang/v1/devices/register",
      "/api/tianjiang/v1/profile/versions/latest",
      "/api/tianjiang/v1/projects",
    ].includes(pathname));
  assert.deepEqual(runtimeCalls, [
    "/api/tianjiang/v1/devices/register",
    "/api/tianjiang/v1/profile/versions/latest",
    "/api/tianjiang/v1/projects",
  ]);
  assert.equal(
    centralRequests.some((item) => /^\/tianjiang\/projects\/[0-9a-f-]+$/.test(item.pathname)),
    false,
    "登录阶段不得下载项目正文",
  );

  const projects = await request("GET", "/api/tianjiang/runtime/projects");
  assert.equal(projects.response.status, 200);
  assert.equal((projects.body.data as unknown[]).length, 4);
  const readonlyTeam = (projects.body.data as Array<Record<string, unknown>>)[1];
  assert.equal(readonlyTeam.myRole, "viewer");
  assert.equal(readonlyTeam.lockStatus, "active");
  assert.equal(readonlyTeam.lockHolderName, "林编辑");
  assert.equal(readonlyTeam.openMode, "readonly");
});

test("个人项目通过 HTTP 打开才下载、编辑后关闭完成最终发布", async () => {
  const projectUUID = PERSONAL_PROJECT_UUID;
  const before = centralRequests.filter(
    (item) => item.pathname === `/api/tianjiang/v1/projects/${projectUUID}`,
  ).length;
  assert.equal(before, 0);

  const opened = await request("POST", `/api/tianjiang/runtime/projects/${projectUUID}/open`);
  assert.equal(opened.response.status, 200, JSON.stringify(opened.body));
  assert.deepEqual((opened.body.data as { project?: unknown }).project, {
    id: String(PERSONAL_LOCAL_ID),
    projectUuid: projectUUID,
    name: "个人项目",
    intro: "",
    type: "",
    artStyle: null,
    videoRatio: null,
    createTime: 0,
    updatedAt: 0,
    imageModel: "",
    videoModel: "",
    projectType: "novel",
    imageQuality: "",
    mode: "",
    directorManual: "",
  });
  assert.equal((opened.body.data as { accessMode?: string }).accessMode, "readwrite");
  // 工作区已初始化：通过项目库小说列表（同 projectId）验证，而非账号级 getProject。
  const initializedWorkspace = await request("POST", "/api/novel/getNovel", {
    projectId: PERSONAL_LOCAL_ID,
    page: 1,
    limit: 10,
  });
  assert.equal(initializedWorkspace.response.status, 200, JSON.stringify(initializedWorkspace.body));
  const novelPage = initializedWorkspace.body.data as { data?: unknown[]; total?: number };
  assert.ok(novelPage && typeof novelPage === "object");
  assert.equal(Array.isArray(novelPage.data) || Array.isArray(initializedWorkspace.body.data), true);
  assert.equal(
    centralRequests.filter(
      (item) => item.pathname === `/api/tianjiang/v1/projects/${projectUUID}`,
    ).length,
    1,
  );

  const edited = await request("POST", `/api/tianjiang/runtime/projects/${projectUUID}/edit`, {
    namespace: "script",
    key: "scene-1",
    value: { title: "真实 HTTP 写入" },
  });
  assert.equal(edited.response.status, 200);
  const manual = await request("POST", `/api/tianjiang/runtime/projects/${projectUUID}/sync`);
  assert.equal(manual.response.status, 200, JSON.stringify(manual.body));
  assert.equal((manual.body.data as { state?: string }).state, "synced");
  // 手动同步后再编辑，关闭仍必须执行最终发布。
  assert.equal((await request("POST", `/api/tianjiang/runtime/projects/${projectUUID}/edit`, {
    namespace: "script",
    key: "scene-2",
    value: { title: "关闭前最终写入" },
  })).response.status, 200);

  const closed = await request("POST", `/api/tianjiang/runtime/projects/${projectUUID}/close`);
  assert.equal(closed.response.status, 200);
  assert.equal(
    centralRequests.some(
      (item) => item.pathname === `/api/tianjiang/v1/upload-sessions/${UPLOAD_SESSION_UUID}/commit`,
    ),
    true,
  );
});

test("个人配置、迁移执行与回滚均由正式运行时路由可达", async () => {
  const profileWrite = await request("POST", "/api/tianjiang/runtime/profile", {
    key: "vendor.synthetic.api_key",
    value: "http-test-secret-value",
    sensitive: true,
  });
  assert.equal(profileWrite.response.status, 200, JSON.stringify(profileWrite.body));
  const profileFlush = await request("POST", "/api/tianjiang/runtime/profile/flush");
  assert.equal(profileFlush.response.status, 200, JSON.stringify(profileFlush.body));
  const profileCommit = [...centralRequests]
    .reverse()
    .find((item) => item.pathname === "/api/tianjiang/v1/profile/versions");
  assert.ok(profileCommit);
  assert.doesNotMatch(JSON.stringify(profileCommit.body), /http-test-secret-value/);

  const status = await request("GET", "/api/tianjiang/runtime/migration");
  assert.equal(status.response.status, 200);
  // 正常启动不能为了迁移探测而创建根目录旧库。
  assert.equal((status.body.data as { sourceDetected?: boolean }).sourceDetected, false);
  const legacyDatabasePath = path.join(tempRoot, "data", "db2.sqlite");
  const legacyDatabase = new Database(legacyDatabasePath);
  legacyDatabase.exec("CREATE TABLE IF NOT EXISTS o_project (id INTEGER PRIMARY KEY, name TEXT)");
  legacyDatabase.close();
  assert.equal((await request("GET", "/api/tianjiang/runtime/migration").then(
    ({ body }) => (body.data as { sourceDetected?: boolean }).sourceDetected,
  )), true);
  const migrated = await request("POST", "/api/tianjiang/runtime/migration/run");
  assert.equal(migrated.response.status, 200, JSON.stringify(migrated.body));
  const report = migrated.body.data as { reportPath: string; backupPath: string; migrationId: string };
  assert.equal(fs.existsSync(report.reportPath), true);
  assert.equal(fs.existsSync(report.backupPath), true);
  assert.equal(fs.existsSync(legacyDatabasePath), true);
  assert.equal((await request("POST", "/api/tianjiang/runtime/migration/rollback")).response.status, 200);
  assert.equal(fs.existsSync(report.reportPath), false);
});

test("团队 viewer 禁写，editor 断网后立即只读并保留恢复证据", async () => {
  const viewerUUID = VIEWER_PROJECT_UUID;
  const viewerOpen = await request("POST", `/api/tianjiang/runtime/projects/${viewerUUID}/open`);
  assert.equal(viewerOpen.response.status, 200, JSON.stringify(viewerOpen.body));
  assert.equal((await request("POST", `/api/tianjiang/runtime/projects/${viewerUUID}/edit`, {
    namespace: "script", key: "forbidden", value: true,
  })).response.status, 403);
  // 旧业务路由不能绕过统一运行时授权；viewer 即使伪造旧表 ID 也必须在入口被拒绝。
  assert.equal((await request("POST", "/api/script/updateScript", {
    id: 1,
    name: "viewer-forbidden",
    content: "不能写入",
    assets: [],
  })).response.status, 403);
  assert.equal((await request("POST", "/api/assets/saveAssets", {
    id: 1,
    projectId: VIEWER_LOCAL_ID,
    type: "role",
    prompt: "不能写入",
  })).response.status, 403);
  assert.equal((await request("POST", "/api/production/storyboard/editStoryboardInfo", {
    id: 1,
    prompt: "不能写入",
    videoDesc: "不能写入",
  })).response.status, 403);
  assert.equal(await socketIsRejected("productionAgent", {
    isolationKey: "viewer-production",
    projectId: VIEWER_LOCAL_ID,
    scriptId: 1,
  }), true);
  assert.equal(await socketIsRejected("scriptAgent", {
    isolationKey: "viewer-script",
    projectId: VIEWER_LOCAL_ID,
  }), true);

  const editorUUID = EDITOR_PROJECT_UUID;
  assert.equal((await request("POST", `/api/tianjiang/runtime/projects/${editorUUID}/open`)).response.status, 200);

  // viewer 与 editor 同时打开，用真实 HTTP 链证明 body.id 精确选择 editor，而不是猜测任一运行时。
  for (const pathname of [
    "/api/general/getSingleProject",
    "/api/general/getSingleProject/",
  ]) {
    const detail = await request("POST", pathname, { id: EDITOR_LOCAL_ID });
    assert.equal(detail.response.status, 200, JSON.stringify(detail.body));
    const rows = detail.body.data as Array<{ id?: number }>;
    assert.equal(rows[0]?.id, EDITOR_LOCAL_ID, `${pathname} 必须定位指定 editor 项目`);
  }

  // 响应 finish 回调若把读取误判成写入，会异步落下 mutation intent；等待一轮事件循环再核验。
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    readPendingLegacyMutationIntent(
      path.join(tempRoot, "data"),
      runtimeUserSegment(7),
      editorUUID,
    ),
    null,
    "纯读取不得创建 mutation intent 或把项目标脏",
  );

  const abnormalDetail = await request(
    "POST",
    "/api/general/getSingleProject//",
    { id: EDITOR_LOCAL_ID },
  );
  assert.equal(
    abnormalDetail.response.status,
    404,
    "双尾斜杠不得识别 body.id；多个项目同时打开时必须因目标歧义失败关闭",
  );
  assert.match(String(abnormalDetail.body.message ?? ""), /项目或子资源不存在/);

  assert.equal((await request("POST", `/api/tianjiang/runtime/projects/${editorUUID}/edit`, {
    namespace: "script", key: "before-network-loss", value: true,
  })).response.status, 200);
  assert.equal(await socketDisconnectsAfterLockInvalid("productionAgent", {
    isolationKey: "editor-production",
    projectId: EDITOR_LOCAL_ID,
    scriptId: 1,
  }, editorUUID), true);
  assert.equal((await request("POST", "/api/tianjiang/runtime/network", { online: false })).response.status, 200);
  assert.equal((await request("POST", `/api/tianjiang/runtime/projects/${editorUUID}/edit`, {
    namespace: "script", key: "after-network-loss", value: true,
  })).response.status, 403);

  const status = await request("GET", "/api/tianjiang/runtime/status");
  const project = (status.body.data as { projects: Array<Record<string, unknown>> }).projects
    .find((item) => item.projectUuid === editorUUID);
  assert.equal(project?.editable, false);
  assert.equal(project?.recoveryRequired, true);
  const recoveryRoot = path.join(
    tempRoot,
    "data",
    "runtime-users",
    runtimeUserSegment(7),
    "sync",
    "recovery",
    editorUUID,
  );
  const recovery = fs.readdirSync(recoveryRoot)
    .map((name) => path.join(recoveryRoot, name))
    .find((entry) => {
      if (!fs.statSync(entry).isDirectory()) return false;
      const recoveryManifest = path.join(entry, "recovery.json");
      const recoveryDatabase = path.join(entry, "project.sqlite");
      if (!fs.existsSync(recoveryManifest) || !fs.existsSync(recoveryDatabase)) return false;
      const metadata = JSON.parse(fs.readFileSync(recoveryManifest, "utf8")) as { resolved?: boolean };
      // 中文注释：远端安装会保留已解决的自动回滚点；此处只验收断网产生的未解决恢复副本。
      return metadata.resolved !== true;
    });
  assert.ok(recovery);
  const recoveryDb = new Database(path.join(recovery, "project.sqlite"), { readonly: true });
  try {
    const row = recoveryDb.prepare(
      "SELECT value_json FROM project_records WHERE namespace = ? AND record_key = ?",
    ).get("script", "before-network-loss") as { value_json: string } | undefined;
    assert.deepEqual(JSON.parse(row?.value_json ?? "null"), true);
  } finally {
    recoveryDb.close();
  }
  const recoveries = await request("GET", `/api/tianjiang/runtime/projects/${editorUUID}/recoveries`);
  assert.equal(recoveries.response.status, 200);
  const recoveryItems = recoveries.body.data as Array<{ recoveryId: string; resolved: boolean }>;
  assert.equal(recoveryItems.length > 0, true);
  assert.equal(recoveryItems[0].resolved, false);
  for (const recoveryItem of recoveryItems) {
    const resolved = await request(
      "POST",
      `/api/tianjiang/runtime/projects/${editorUUID}/recoveries/${recoveryItem.recoveryId}/resolve`,
      { resolution: "keep_backup" },
    );
    assert.equal(resolved.response.status, 200);
  }
  const afterResolve = await request("GET", "/api/tianjiang/runtime/status");
  const resolvedProject = (
    afterResolve.body.data as { projects: Array<Record<string, unknown>> }
  ).projects.find((item) => item.projectUuid === editorUUID);
  assert.equal(resolvedProject?.recoveryRequired, false);
  assert.equal(resolvedProject?.accessMode, "readonly");
});

test("团队关闭发布本地编辑后的 SQLite 摘要且成功后才释放锁", async () => {
  const projectUUID = "44444444-4444-4444-a444-444444444444";
  const teamOpen = await request("POST", `/api/tianjiang/runtime/projects/${projectUUID}/open`);
  assert.equal(teamOpen.response.status, 200, JSON.stringify(teamOpen.body));
  assert.equal((await request("POST", `/api/tianjiang/runtime/projects/${projectUUID}/edit`, {
    namespace: "script",
    key: "team-scene",
    value: { title: "必须进入团队发布" },
  })).response.status, 200);
  const before = centralRequests.length;
  assert.equal((await request("POST", `/api/tianjiang/runtime/projects/${projectUUID}/close`)).response.status, 200);
  const closeCalls = centralRequests.slice(before);
  const commit = closeCalls.find(
    (item) => item.pathname === `/api/tianjiang/v1/upload-sessions/${UPLOAD_SESSION_UUID}/commit`,
  );
  const manifest = commit?.body.manifest as { database?: { md5?: string } } | undefined;
  assert.notEqual(manifest?.database?.md5, "synthetic-db");
  assert.equal(lastUploadedProjectObject.length > 0, true);
  const commitIndex = closeCalls.findIndex((item) => item.pathname.endsWith("/commit"));
  const releaseIndex = closeCalls.findIndex(
    (item) => item.pathname.endsWith("/lock") && item.method === "DELETE",
  );
  assert.equal(commitIndex >= 0 && releaseIndex > commitIndex, true);
});

test("存在尚未中央同步的 Team 时阻断重新登录，进程重启后仍保留恢复事实", async () => {
  const blocked = await login("alice");
  assert.equal(blocked.response.status, 502, JSON.stringify(blocked.body));
  assert.match(
    String(blocked.body.message ?? ""),
    /团队项目同步未完成|取消退出|切换账号/,
    "未完成中央同步的 Team 必须阻断重新登录，禁止把测试清场变成数据丢失通道",
  );

  // 中文注释：模拟用户取消切换后重启客户端。进程重启只能释放运行时句柄，
  // 磁盘上的 journal / recovery 事实仍保留；下一场景使用新的进程态继续验收。
  await restartApp();
  const resumed = await login("alice");
  assert.equal(
    resumed.response.status,
    200,
    `重启后恢复同账号登录失败: ${JSON.stringify(resumed.body)}\n${appLogs.slice(-2000)}`,
  );
  sessionCookie = resumed.cookie;
});

test("旧 UI 路由写入项目 SQLite，跨项目子资源和 Socket 枚举被拒绝，关闭提交该快照", async () => {
  const personalUUID = PERSONAL_PROJECT_UUID;
  const teamUUID = RELEASE_PROJECT_UUID;
  assert.equal((await request("POST", `/api/tianjiang/runtime/projects/${personalUUID}/open`)).response.status, 200);
  const openedTeam = await request("POST", `/api/tianjiang/runtime/projects/${teamUUID}/open`);
  assert.equal(openedTeam.response.status, 200, JSON.stringify(openedTeam.body));

  const personalWrite = await request("POST", "/api/script/addScript", {
    name: "个人项目旧 UI 剧本",
    content: "只能留在个人项目",
    projectId: PERSONAL_LOCAL_ID,
    assets: [],
  });
  assert.equal(personalWrite.response.status, 200);
  const personalDatabase = new Database(
    path.join(
      tempRoot,
      "data",
      "runtime-users",
      runtimeUserSegment(7),
      "projects",
      personalUUID,
      "project.sqlite",
    ),
    { readonly: true },
  );
  const personalScript = personalDatabase.prepare(
    "SELECT id, content FROM o_script WHERE name = ?",
  ).get("个人项目旧 UI 剧本") as { id: number; content: string } | undefined;
  personalDatabase.close();
  assert.ok(personalScript);
  assert.equal(personalScript.content, "只能留在个人项目");

  assert.equal((await request("POST", "/api/assets/addAssets", {
    name: "瞬态上传资产",
    describe: "上传只允许在请求内携带 Base64",
    type: "role",
    projectId: PERSONAL_LOCAL_ID,
  })).response.status, 200);
  const personalDatabaseForUpload = new Database(
    path.join(
      tempRoot,
      "data",
      "runtime-users",
      runtimeUserSegment(7),
      "projects",
      personalUUID,
      "project.sqlite",
    ),
  );
  const uploadedAsset = personalDatabaseForUpload.prepare(
    "SELECT id FROM o_assets WHERE name = ?",
  ).get("瞬态上传资产") as { id: number } | undefined;
  personalDatabaseForUpload.close();
  assert.ok(uploadedAsset);
  const pngDataURL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
    + "AAAADUlEQVR42mNk+M/wHwAF/gL+Xc9WAAAAAElFTkSuQmCC";
  const uploaded = await request("POST", "/api/assets/saveAssets", {
    id: uploadedAsset.id,
    projectId: PERSONAL_LOCAL_ID,
    base64: pngDataURL,
    type: "role",
    prompt: "瞬态上传落盘后只存相对路径",
  });
  assert.equal(uploaded.response.status, 200);
  const personalDatabasePath = path.join(
    tempRoot,
    "data",
    "runtime-users",
    runtimeUserSegment(7),
    "projects",
    personalUUID,
    "project.sqlite",
  );
  assertSQLiteHasNoImageBase64(personalDatabasePath);
  const persistedUpload = new Database(personalDatabasePath, { readonly: true });
  const uploadedImage = persistedUpload.prepare(
    "SELECT filePath FROM o_image WHERE assetsId = ? ORDER BY id DESC LIMIT 1",
  ).get(uploadedAsset.id) as { filePath?: string } | undefined;
  persistedUpload.close();
  assert.match(
    uploadedImage?.filePath ?? "",
    new RegExp(`^/${PERSONAL_LOCAL_ID}/role/[0-9a-f-]+\\.png$`, "i"),
  );

  const crossProject = await request("POST", "/api/script/updateScript", {
    id: personalScript.id,
    projectId: RELEASE_LOCAL_ID,
    name: "越权覆盖",
    content: "不得写入",
    assets: [],
  });
  assert.equal(crossProject.response.status, 404);
  assert.equal(await socketIsRejected("productionAgent", {
    isolationKey: "cross-project-script",
    projectId: RELEASE_LOCAL_ID,
    scriptId: personalScript.id,
  }), true);

  const teamWrite = await request("POST", "/api/script/addScript", {
    name: "团队项目旧 UI 剧本",
    content: "必须进入发布快照",
    projectId: RELEASE_LOCAL_ID,
    assets: [],
  });
  assert.equal(teamWrite.response.status, 200);
  const teamDatabasePath = path.join(
    tempRoot,
    "data",
    "runtime-users",
    runtimeUserSegment(7),
    "projects",
    teamUUID,
    "project.sqlite",
  );
  const teamDatabase = new Database(teamDatabasePath, { readonly: true });
  assert.equal(
    (teamDatabase.prepare("SELECT content FROM o_script WHERE name = ?")
      .get("团队项目旧 UI 剧本") as { content?: string } | undefined)?.content,
    "必须进入发布快照",
  );
  teamDatabase.close();

  const beforeClose = centralRequests.length;
  assert.equal((await request("POST", `/api/tianjiang/runtime/projects/${teamUUID}/close`)).response.status, 200);
  const commit = centralRequests.slice(beforeClose)
    .find((item) => item.pathname === `/api/tianjiang/v1/upload-sessions/${UPLOAD_SESSION_UUID}/commit`);
  const committedMD5 = (commit?.body.manifest as {
    database?: { md5?: string };
  } | undefined)?.database?.md5;
  const snapshotPath = path.join(
    tempRoot,
    "data",
    "runtime-users",
    runtimeUserSegment(7),
    "sync",
    "snapshots",
    teamUUID,
    "project.sqlite",
  );
  assert.equal(fs.existsSync(snapshotPath), true);
  assert.equal(
    committedMD5,
    crypto.createHash("md5").update(fs.readFileSync(snapshotPath)).digest("hex"),
  );
  const publishedDatabase = new Database(snapshotPath, { readonly: true });
  assert.equal(
    (publishedDatabase.prepare("SELECT content FROM o_script WHERE name = ?")
      .get("团队项目旧 UI 剧本") as { content?: string } | undefined)?.content,
    "必须进入发布快照",
  );
  publishedDatabase.close();
});

test("真实生成路由可读取当前项目参考图，绑定远端 ID 后保留临时失败并在重启后恢复", async () => {
  const loggedIn = await login("alice");
  assert.equal(loggedIn.response.status, 200);
  sessionCookie = loggedIn.cookie;
  const projectUUID = "11111111-1111-4111-a111-111111111111";
  assert.equal((await request("POST", `/api/tianjiang/runtime/projects/${projectUUID}/open`)).response.status, 200);
  const accountDatabasePath = path.join(
    tempRoot,
    "data",
    "runtime-users",
    runtimeUserSegment(7),
    "db2.sqlite",
  );
  const projectDatabasePath = path.join(
    tempRoot,
    "data",
    "runtime-users",
    runtimeUserSegment(7),
    "projects",
    projectUUID,
    "project.sqlite",
  );
  // 供应商配置属账号库；写入项目库不会被 AI 解析链读取
  const accountDatabase = new Database(accountDatabasePath);
  accountDatabase.prepare(
    `INSERT INTO o_vendorConfig (id, inputValues, models, enable)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(id) DO UPDATE SET inputValues = excluded.inputValues,
       models = excluded.models, enable = 1`,
  ).run("synthetic", "{}", JSON.stringify([{
    name: "恢复测试图片模型",
    modelName: "recovery-image",
    type: "image",
    mode: ["text"],
  }]));
  accountDatabase.close();
  const vendorRoot = path.join(tempRoot, "data", "vendor");
  fs.mkdirSync(vendorRoot, { recursive: true });
  fs.writeFileSync(path.join(vendorRoot, "synthetic.ts"), `
exports.vendor = {
  id: "synthetic",
  name: "本地恢复测试供应商",
  inputValues: {},
  models: [{ name: "恢复测试图片模型", modelName: "recovery-image", type: "image", mode: ["text"] }]
};
exports.imageRequest = async function () {
  await fetch(${JSON.stringify(`${centralURL}/synthetic/generation`)}, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "route recovery" })
  });
  throw new Error("synthetic temporary poll failure");
};
exports.queryTask = async function (remoteTaskId) {
  const response = await fetch(
    ${JSON.stringify(`${centralURL}/synthetic/status`)} + "?id=" + encodeURIComponent(remoteTaskId)
  );
  return await response.json();
};
`, "utf8");

  // 中文注释：画布拿到的是受保护的 runtime URL；路由必须从当前项目目录直接读取，不能再通过无会话 HTTP 回环。
  const referencePath = path.join(
    tempRoot,
    "data",
    "runtime-users",
    runtimeUserSegment(7),
    "projects",
    projectUUID,
    "files",
    "references",
    "canvas-reference.png",
  );
  fs.mkdirSync(path.dirname(referencePath), { recursive: true });
  fs.writeFileSync(referencePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  const protectedReferenceUrl = `${appURL}/api/tianjiang/runtime/projects/${projectUUID}/files/references/canvas-reference.png?size=20`;

  // 中文注释：即使相对文件名相同，其他项目 UUID 的 URL 也不得借当前项目上下文越权读取。
  const generationCallsBeforeCrossProject = centralRequests.filter(
    (item) => item.pathname === "/synthetic/generation",
  ).length;
  const crossProjectReference = await request("POST", "/api/production/editImage/generateFlowImage", {
    model: "synthetic:recovery-image",
    references: [protectedReferenceUrl.replace(projectUUID, VIEWER_PROJECT_UUID)],
    quality: "1K",
    ratio: "1:1",
    prompt: "跨项目参考图必须拒绝",
    projectId: PERSONAL_LOCAL_ID,
  });
  assert.equal(crossProjectReference.response.status, 400);
  assert.match(JSON.stringify(crossProjectReference.body), /不属于当前项目/);
  assert.equal(
    centralRequests.filter((item) => item.pathname === "/synthetic/generation").length,
    generationCallsBeforeCrossProject,
  );

  const generated = await request("POST", "/api/production/editImage/generateFlowImage", {
    model: "synthetic:recovery-image",
    references: [protectedReferenceUrl],
    quality: "1K",
    ratio: "1:1",
    prompt: "真实路由创建的恢复任务",
    projectId: PERSONAL_LOCAL_ID,
  });
  assert.equal(generated.response.status, 400);
  assert.match(JSON.stringify(generated.body), /普通供应商生成失败|synthetic temporary poll failure/);
  let inspection = new Database(projectDatabasePath, { readonly: true });
  let task = inspection.prepare(
    "SELECT state, remoteTaskId, generationStatus, reason FROM o_tasks WHERE provider = ? ORDER BY id DESC LIMIT 1",
  ).get("synthetic") as {
    state?: string;
    remoteTaskId?: string;
    generationStatus?: string;
    reason?: string;
  } | undefined;
  inspection.close();
  assert.deepEqual({
    state: task?.state,
    remoteTaskId: task?.remoteTaskId,
    generationStatus: task?.generationStatus,
  }, {
    state: "进行中",
    remoteTaskId: "route-created-remote-task",
    generationStatus: "temporary_failure",
  });
  assert.match(task?.reason ?? "", /普通供应商生成失败|temporary poll failure/);

  await restartApp();
  const afterRestart = await login("alice");
  assert.equal(afterRestart.response.status, 200);
  sessionCookie = afterRestart.cookie;
  inspection = new Database(projectDatabasePath, { readonly: true });
  task = inspection.prepare(
    "SELECT state, remoteTaskId, generationStatus FROM o_tasks WHERE provider = ? ORDER BY id DESC LIMIT 1",
  ).get("synthetic") as typeof task;
  inspection.close();
  assert.deepEqual({
    state: task?.state,
    remoteTaskId: task?.remoteTaskId,
    generationStatus: task?.generationStatus,
  }, {
    state: "已完成",
    remoteTaskId: "route-created-remote-task",
    generationStatus: "completed",
  });
});

test("新用户登录后旧 Cookie 不能读取或写入新用户运行时", async () => {
  const aliceCookie = sessionCookie;
  const bob = await login("bob");
  assert.equal(bob.response.status, 200);
  const bobCookie = bob.cookie;
  assert.notEqual(bobCookie, "");
  sessionCookie = bobCookie;

  const oldProjects = await requestWithCookie(aliceCookie, "GET", "/api/tianjiang/runtime/projects");
  assert.equal([401, 403].includes(oldProjects.response.status), true);
  const bobProjects = await requestWithCookie(bobCookie, "GET", "/api/tianjiang/runtime/projects");
  assert.equal(bobProjects.response.status, 200);
  assert.deepEqual(
    (bobProjects.body.data as Array<{ projectUuid: string }>).map((item) => item.projectUuid),
    ["55555555-5555-4555-a555-555555555555"],
  );
  const oldWrite = await requestWithCookie(
    aliceCookie,
    "POST",
    "/api/tianjiang/runtime/projects/55555555-5555-4555-a555-555555555555/open",
  );
  assert.equal([401, 403].includes(oldWrite.response.status), true);
});

test("单活动账号切换主动关闭 Alice Socket，Bob 当前 Socket 和运行时保持可写", async () => {
  const alice = await login("alice");
  assert.equal(alice.response.status, 200);
  sessionCookie = alice.cookie;
  const aliceTeamUUID = "33333333-3333-4333-a333-333333333333";
  assert.equal((await request("POST", `/api/tianjiang/runtime/projects/${aliceTeamUUID}/open`)).response.status, 200);
  const aliceSocket = await connectAuthorizedSocket("scriptAgent", {
    isolationKey: "alice-old-socket",
    projectId: EDITOR_LOCAL_ID,
  }, alice.cookie);
  const aliceDisconnected = new Promise<void>((resolve) => aliceSocket.once("disconnect", () => resolve()));

  const bob = await login("bob");
  assert.equal(bob.response.status, 200);
  await Promise.race([
    aliceDisconnected,
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error("账号切换未主动关闭 Alice Socket")),
      1_500,
    )),
  ]);
  sessionCookie = bob.cookie;
  const bobProjectUUID = "55555555-5555-4555-a555-555555555555";
  assert.equal((await request("POST", `/api/tianjiang/runtime/projects/${bobProjectUUID}/open`)).response.status, 200);
  const bobSocket = await connectAuthorizedSocket("scriptAgent", {
    isolationKey: "bob-current-socket",
    projectId: BOB_LOCAL_ID,
  }, bob.cookie);

  assert.equal(aliceSocket.connected, false);
  assert.equal(bobSocket.connected, true);
  const status = await request("GET", "/api/tianjiang/runtime/status");
  assert.equal(status.response.status, 200);
  const bobProject = (status.body.data as {
    projects: Array<{ projectUuid: string; editable: boolean }>;
  }).projects.find((item) => item.projectUuid === bobProjectUUID);
  assert.equal(bobProject?.editable, true);
  bobSocket.disconnect();
});

test("新建项目后刷新目录即可立即打开；刷新失败保留旧目录；未授权仍不可打开", async () => {
  const loggedIn = await login("alice");
  assert.equal(loggedIn.response.status, 200);
  sessionCookie = loggedIn.cookie;

  const createdUUID = "66666666-6666-4666-a666-666666666666";
  // 中央创建成功但本地未刷新：稳定复现「项目不存在或不可见」
  extraCatalogProjects = [{
    projectUuid: createdUUID,
    name: "登录后新建",
    kind: "personal",
    ownerUserId: 7,
    myRole: "owner",
    businessType: "novel",
    currentVersion: 1,
  }];
  const missing = await request("POST", `/api/tianjiang/runtime/projects/${createdUUID}/open`);
  assert.equal(missing.response.status, 403);
  assert.match(String(missing.body.message ?? ""), /项目不存在或不可见/);

  const refreshed = await request("POST", "/api/tianjiang/runtime/projects/refresh");
  assert.equal(refreshed.response.status, 200, JSON.stringify(refreshed.body));
  assert.equal((refreshed.body.data as unknown[]).length, 5);
  const opened = await request("POST", `/api/tianjiang/runtime/projects/${createdUUID}/open`);
  assert.equal(opened.response.status, 200, JSON.stringify(opened.body));

  // 刷新失败不得清空旧目录
  catalogFailOnce = true;
  const failed = await request("POST", "/api/tianjiang/runtime/projects/refresh");
  assert.notEqual(failed.response.status, 200);
  const stillThere = await request("GET", "/api/tianjiang/runtime/projects");
  assert.equal(stillThere.response.status, 200);
  assert.equal((stillThere.body.data as unknown[]).length, 5);

  // 未出现在中央目录的项目仍不可打开
  const foreign = await request(
    "POST",
    "/api/tianjiang/runtime/projects/77777777-7777-4777-a777-777777777777/open",
  );
  assert.equal(foreign.response.status, 403);

  // 离线禁止伪造中央刷新
  assert.equal((await request("POST", "/api/tianjiang/runtime/network", { online: false })).response.status, 200);
  const offlineRefresh = await request("POST", "/api/tianjiang/runtime/projects/refresh");
  assert.notEqual(offlineRefresh.response.status, 200);
  assert.match(String(offlineRefresh.body.message ?? ""), /离线|禁止|刷新/);

  extraCatalogProjects = [];
  catalogFailOnce = false;
  assert.equal((await request("POST", "/api/tianjiang/runtime/network", { online: true })).response.status, 200);
});

test("中央目录未知角色或类型必须使登录初始化失败而不是默认提权", async () => {
  const alice = await login("alice");
  assert.equal(alice.response.status, 200);
  catalogMode = "unknown-role";
  const result = await login("charlie");
  assert.equal(result.response.status, 502);
  catalogMode = "normal";
  const restored = await requestWithCookie(
    alice.cookie,
    "GET",
    "/api/tianjiang/runtime/projects",
  );
  assert.equal(restored.response.status, 200, "切换失败必须原子恢复上一活动账号");
  assert.equal((restored.body.data as unknown[]).length, 4);
});

test("非本人个人项目目录必须在登录初始化时拒绝", async () => {
  catalogMode = "non-owner";
  const result = await login("alice");
  assert.equal(result.response.status, 502);
  catalogMode = "normal";
});

test("有效离线授权持久化后重启仍只允许本人个人项目写入，团队保持只读", async () => {
  grantLifetimeMs = 60_000;
  grantRevoked = false;
  const loggedIn = await login("alice");
  assert.equal(loggedIn.response.status, 200);
  sessionCookie = loggedIn.cookie;
  const personalUUID = "11111111-1111-4111-a111-111111111111";
  assert.equal((await request("POST", `/api/tianjiang/runtime/projects/${personalUUID}/open`)).response.status, 200);
  assert.equal((await request("POST", `/api/tianjiang/runtime/projects/${personalUUID}/close`)).response.status, 200);
  assert.equal((await request("POST", "/api/tianjiang/runtime/network", { online: false })).response.status, 200);

  await restartApp();
  sessionCookie = "";
  assert.equal((await request("GET", "/api/tianjiang/runtime/projects")).response.status, 200);
  assert.equal((await request("POST", `/api/tianjiang/runtime/projects/${personalUUID}/open`)).response.status, 200);
  assert.equal((await request("POST", `/api/tianjiang/runtime/projects/${personalUUID}/edit`, {
    namespace: "script", key: "offline-edit", value: { title: "离线重启后写入" },
  })).response.status, 200);

  const teamUUID = "22222222-2222-4222-a222-222222222222";
  assert.equal((await request("POST", `/api/tianjiang/runtime/projects/${teamUUID}/open`)).response.status, 200);
  assert.equal((await request("POST", `/api/tianjiang/runtime/projects/${teamUUID}/edit`, {
    namespace: "script", key: "offline-team-forbidden", value: true,
  })).response.status, 403);
  // Round9: 冷重启清掉离线打开的脏项目，避免后续 login closeAll 被中央门阻断。
  await restartApp();
  sessionCookie = "";
});

test("离线授权过期或稳定设备不匹配时重启后拒绝写入", async () => {
  grantLifetimeMs = 80;
  const expiring = await login("alice");
  assert.equal(expiring.response.status, 200);
  sessionCookie = expiring.cookie;
  await stopApp();
  await new Promise((resolve) => setTimeout(resolve, 120));
  appProcess = await startApp(path.join(appRoot, "data", "serve", "app.js"));
  sessionCookie = "";
  assert.equal((await request(
    "POST",
    "/api/tianjiang/runtime/projects/11111111-1111-4111-a111-111111111111/open",
  )).response.status, 403);

  grantLifetimeMs = 60_000;
  const fresh = await login("alice");
  assert.equal(fresh.response.status, 200);
  sessionCookie = fresh.cookie;
  await stopApp();
  fs.writeFileSync(
    path.join(tempRoot, "data", "tianjiang-device-id"),
    "88888888-8888-4888-a888-888888888888",
    "utf8",
  );
  appProcess = await startApp(path.join(appRoot, "data", "serve", "app.js"));
  sessionCookie = "";
  assert.equal((await request(
    "POST",
    "/api/tianjiang/runtime/projects/11111111-1111-4111-a111-111111111111/open",
  )).response.status, 403);
});

test("设备撤销无需 renderer 上报网络变化，新 HTTP 写请求会主动核验并立即拒绝", async () => {
  grantLifetimeMs = 60_000;
  grantRevoked = false;
  const loggedIn = await login("alice");
  assert.equal(loggedIn.response.status, 200);
  sessionCookie = loggedIn.cookie;
  const personalUUID = "11111111-1111-4111-a111-111111111111";
  assert.equal((await request("POST", `/api/tianjiang/runtime/projects/${personalUUID}/open`)).response.status, 200);
  grantRevoked = true;
  assert.equal((await request("POST", `/api/tianjiang/runtime/projects/${personalUUID}/edit`, {
    namespace: "script", key: "revoked-forbidden", value: true,
  })).response.status, 403);
  assert.equal((await request("POST", "/api/script/addScript", {
    name: "撤销设备不得写",
    content: "forbidden",
    projectId: PERSONAL_LOCAL_ID,
    assets: [],
  })).response.status, 403);
  grantRevoked = false;
});

test("设置页列表直接返回当前账号供应商配置，且不写入中央请求或日志", async () => {
  const loggedIn = await login("alice");
  assert.equal(loggedIn.response.status, 200);
  sessionCookie = loggedIn.cookie;
  const secret = "vendor-secret-must-stay-backend";
  appLogs = "";
  assert.equal((await request("POST", "/api/setting/vendorConfig/updateVendorInputs", {
    id: "tianjiang",
    inputValues: {
      apiKey: secret,
      endpoint: "https://backend-only.invalid/v1",
    },
  })).response.status, 200);
  const activeMarker = JSON.parse(fs.readFileSync(
    path.join(tempRoot, "data", "runtime-users", "active-user.json"),
    "utf8",
  )) as { segment: string };
  const activeDatabasePath = path.join(
    tempRoot,
    "data",
    "runtime-users",
    activeMarker.segment,
    "db2.sqlite",
  );
  const activeDatabase = new Database(activeDatabasePath, { readonly: true });
  const allBusinessRows = activeDatabase.prepare(
    "SELECT id, inputValues, models, enable FROM o_vendorConfig ORDER BY id",
  ).all();
  activeDatabase.close();
  assert.match(JSON.stringify(allBusinessRows), new RegExp(secret));
  let foundInLocalSQLite = false;
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${activeDatabasePath}${suffix}`;
    if (fs.existsSync(candidate)) {
      foundInLocalSQLite ||= fs.readFileSync(candidate).includes(Buffer.from(secret));
    }
  }
  assert.equal(foundInLocalSQLite, true);
  assert.doesNotMatch(JSON.stringify(centralRequests), new RegExp(secret));

  const listed = await request("POST", "/api/setting/vendorConfig/getVendorList");
  assert.equal(listed.response.status, 200);
  const vendors = (listed.body.data ?? []) as Array<Record<string, unknown>>;
  const tianjiang = vendors.find((item) => item.id === "tianjiang");
  assert.ok(tianjiang);
  assert.deepEqual(tianjiang.inputValues, {
    apiKey: secret,
    endpoint: "https://backend-only.invalid/v1",
  });
  assert.equal("code" in tianjiang, false);
  assert.equal(tianjiang.configured, true);
  assert.equal("inputMask" in tianjiang, false);
  assert.doesNotMatch(appLogs, new RegExp(secret));
});

test("当前账号无需 reveal 即可直接编辑本人配置，跨账号与中央共享仍隔离", async () => {
  const alice = await login("alice");
  assert.equal(alice.response.status, 200);
  sessionCookie = alice.cookie;
  const secret = "alice-direct-settings-secret";
  assert.equal((await request("POST", "/api/setting/vendorConfig/updateVendorInputs", {
    id: "tianjiang",
    inputValues: {
      apiKey: secret,
      endpoint: "https://alice-provider.invalid/v1",
    },
  })).response.status, 200);

  const aliceList = await requestWithCookie(
    alice.cookie,
    "POST",
    "/api/setting/vendorConfig/getVendorList",
  );
  assert.equal(aliceList.response.status, 200);
  const aliceVendor = (aliceList.body.data as Array<Record<string, any>>)
    .find((item) => item.id === "tianjiang");
  assert.deepEqual(aliceVendor?.inputValues, {
    apiKey: secret,
    endpoint: "https://alice-provider.invalid/v1",
  });
  assert.doesNotMatch(appLogs, new RegExp(secret));

  const bob = await login("bob");
  assert.equal(bob.response.status, 200);
  const bobList = await requestWithCookie(
    bob.cookie,
    "POST",
    "/api/setting/vendorConfig/getVendorList",
  );
  assert.equal(bobList.response.status, 200);
  assert.doesNotMatch(JSON.stringify(bobList.body), new RegExp(secret));

  const removedReveal = await requestWithCookie(
    bob.cookie,
    "POST",
    "/api/setting/vendorConfig/revealInputs",
    { vendorId: "tianjiang" },
  );
  assert.equal(removedReveal.response.status, 404);
  assert.doesNotMatch(JSON.stringify(centralRequests), new RegExp(secret));
  assert.doesNotMatch(appLogs, new RegExp(secret));
});

test("单活动账号切换会原子覆盖 active 数据，旧账号仅进入 recovery 且不可见", async () => {
  const alice = await login("alice");
  assert.equal(alice.response.status, 200);
  sessionCookie = alice.cookie;
  const runtimeUsersRoot = path.join(tempRoot, "data", "runtime-users");
  const aliceMarker = JSON.parse(
    fs.readFileSync(path.join(runtimeUsersRoot, "active-user.json"), "utf8"),
  ) as { segment: string };
  const aliceRoot = path.join(runtimeUsersRoot, aliceMarker.segment);
  const aliceDatabasePath = path.join(aliceRoot, "db2.sqlite");
  const aliceDatabaseBeforeSwitch = new Database(aliceDatabasePath, { readonly: true });
  const aliceMigrationsBeforeSwitch = aliceDatabaseBeforeSwitch.prepare(
    "SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version",
  ).all();
  aliceDatabaseBeforeSwitch.close();
  const aliceBackupFilesBeforeSwitch = fs.readdirSync(
    path.join(aliceRoot, "migration-backups"),
    { recursive: true },
  ).map(String).sort();
  const recoveryRoot = path.join(tempRoot, "data", "runtime-recovery", "account-switch");
  const recoverySwitchesBeforeBob = fs.existsSync(recoveryRoot)
    ? new Set(fs.readdirSync(recoveryRoot))
    : new Set<string>();

  const aliceImageBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
    + "AAAADUlEQVR42mNk+M/wHwAF/gL+Xc9WAAAAAElFTkSuQmCC",
    "base64",
  );
  const aliceBytes = `data:image/png;base64,${aliceImageBytes.toString("base64")}`;
  assert.equal((await request("POST", "/api/artStyle/addArtStyle", {
    name: "alice-private-style",
    fileUrl: aliceBytes,
    prompt: "alice only",
  })).response.status, 200);
  const aliceList = await request("POST", "/api/artStyle/getArtStyle");
  const aliceStyle = ((aliceList.body.data ?? []) as Array<Record<string, unknown>>)
    .find((item) => item.name === "alice-private-style");
  assert.ok(aliceStyle);
  const aliceAssetURL = String(aliceStyle.fileUrl).split("?")[0];
  const aliceAsset = await fetch(`${appURL}${aliceAssetURL}`, {
    headers: { cookie: alice.cookie },
  });
  assert.equal(aliceAsset.status, 200);
  assert.deepEqual(Buffer.from(await aliceAsset.arrayBuffer()), aliceImageBytes);

  const bob = await login("bob");
  assert.equal(bob.response.status, 200);
  sessionCookie = bob.cookie;
  const bobList = await request("POST", "/api/artStyle/getArtStyle");
  assert.equal(
    ((bobList.body.data ?? []) as Array<Record<string, unknown>>)
      .some((item) => item.name === "alice-private-style"),
    false,
  );
  const crossUserAsset = await fetch(`${appURL}${aliceAssetURL}`, {
    headers: { cookie: bob.cookie },
  });
  assert.equal(crossUserAsset.status, 404);

  const activeSegments = fs.readdirSync(runtimeUsersRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.equal(activeSegments.length, 1, "产品运行区只能保留一个活动账号目录");
  const activeMarker = JSON.parse(
    fs.readFileSync(path.join(runtimeUsersRoot, "active-user.json"), "utf8"),
  ) as { segment?: string };
  assert.equal(activeMarker.segment, activeSegments[0]);
  assert.notEqual(activeMarker.segment, aliceMarker.segment);
  const bobDatabase = new Database(
    path.join(runtimeUsersRoot, String(activeMarker.segment), "db2.sqlite"),
    { readonly: true },
  );
  const bobMigrationVersions = bobDatabase.prepare(
    "SELECT version FROM schema_migrations ORDER BY version",
  ).all() as Array<{ version: number }>;
  bobDatabase.close();
  assert.deepEqual(
    bobMigrationVersions.map((row) => row.version),
    Array.from({ length: 43 }, (_unused, index) => index + 1),
    "账号切换只允许把完整迁移链应用到 Bob 目标库（含即梦启用、暂停原因、轮询间隔与佳速模型目录迁移）",
  );

  assert.equal(fs.existsSync(recoveryRoot), true);
  const newRecoverySwitches = fs.readdirSync(recoveryRoot)
    .filter((entry) => !recoverySwitchesBeforeBob.has(entry));
  assert.equal(newRecoverySwitches.length, 1, "Bob 原子切换只能新建一个恢复批次");
  const recoveredAliceRoot = path.join(
    recoveryRoot,
    newRecoverySwitches[0],
    aliceMarker.segment,
  );
  const recoveredAliceDatabasePath = path.join(recoveredAliceRoot, "db2.sqlite");
  assert.equal(fs.existsSync(recoveredAliceDatabasePath), true, "Alice 数据库必须进入恢复区");
  const recoveredAliceDatabase = new Database(recoveredAliceDatabasePath, { readonly: true });
  const aliceMigrationsAfterSwitch = recoveredAliceDatabase.prepare(
    "SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version",
  ).all();
  recoveredAliceDatabase.close();
  assert.deepEqual(
    aliceMigrationsAfterSwitch,
    aliceMigrationsBeforeSwitch,
    "切换 Bob 时不得重新迁移 Alice 恢复库",
  );
  assert.deepEqual(
    fs.readdirSync(path.join(recoveredAliceRoot, "migration-backups"), { recursive: true })
      .map(String).sort(),
    aliceBackupFilesBeforeSwitch,
    "切换 Bob 时不得给 Alice 恢复库误建迁移备份",
  );

  // Windows 下仍被 better-sqlite3 占用的文件无法重命名；往返改名证明旧句柄已经关闭。
  const closedHandleProbe = `${recoveredAliceDatabasePath}.closed-handle-probe`;
  fs.renameSync(recoveredAliceDatabasePath, closedHandleProbe);
  fs.renameSync(closedHandleProbe, recoveredAliceDatabasePath);
});

test("活动库迁移校验和漂移会在 listen、路由和 Socket 注册前阻止启动", async () => {
  const alice = await login("alice");
  assert.equal(alice.response.status, 200);
  sessionCookie = alice.cookie;
  const usersRoot = path.join(tempRoot, "data", "runtime-users");
  const marker = JSON.parse(
    fs.readFileSync(path.join(usersRoot, "active-user.json"), "utf8"),
  ) as { segment: string };
  const databasePath = path.join(usersRoot, marker.segment, "db2.sqlite");
  await stopApp();
  const database = new Database(databasePath);
  const row = database.prepare(
    "SELECT checksum FROM schema_migrations WHERE version = 1",
  ).get() as { checksum: string };
  database.prepare(
    "UPDATE schema_migrations SET checksum = ? WHERE version = 1",
  ).run("0".repeat(64));
  database.close();

  await assert.rejects(
    () => startApp(path.join(appRoot, "data", "serve", "app.js")),
    /本地生产 Express 服务提前退出/,
  );

  const restored = new Database(databasePath);
  restored.prepare(
    "UPDATE schema_migrations SET checksum = ? WHERE version = 1",
  ).run(row.checksum);
  restored.close();
  appProcess = await startApp(path.join(appRoot, "data", "serve", "app.js"));
  sessionCookie = "";
});

async function request(method: string, pathname: string, body?: Record<string, unknown>) {
  return requestWithCookie(sessionCookie, method, pathname, body);
}

async function requestWithCookie(
  cookie: string,
  method: string,
  pathname: string,
  body?: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
) {
  const response = await fetch(`${appURL}${pathname}`, {
    method,
    headers: {
      cookie,
      ...extraHeaders,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const parsed = await response.json() as Record<string, unknown>;
  return { response, body: parsed };
}

async function login(username: string) {
  const response = await fetch(`${appURL}/api/tianjiang/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username,
      password: "synthetic-password",
      captcha: "",
      captchaId: "",
    }),
  });
  const body = await response.json() as Record<string, unknown>;
  return {
    response,
    body,
    cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
  };
}

async function socketIsRejected(namespace: string, auth: Record<string, unknown>): Promise<boolean> {
  const socket = connectSocket(`${appURL}/api/socket/${namespace}`, {
    path: ENGINE_IO_PATH,
    auth,
    extraHeaders: { cookie: sessionCookie },
    forceNew: true,
    reconnection: false,
    transports: ["websocket"],
  });
  return await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      socket.disconnect();
      resolve(false);
    }, 1_500);
    socket.once("disconnect", () => {
      clearTimeout(timeout);
      resolve(true);
    });
    socket.once("connect_error", () => {
      clearTimeout(timeout);
      socket.disconnect();
      resolve(true);
    });
  });
}

async function connectAuthorizedSocket(
  namespace: string,
  auth: Record<string, unknown>,
  cookie: string,
) {
  const socket = connectSocket(`${appURL}/api/socket/${namespace}`, {
    path: ENGINE_IO_PATH,
    auth,
    extraHeaders: { cookie },
    forceNew: true,
    reconnection: false,
    transports: ["websocket"],
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.disconnect();
      reject(new Error(`${namespace} Socket 连接超时`));
    }, 1_500);
    socket.once("connect", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.once("disconnect", () => {
      clearTimeout(timeout);
      reject(new Error(`${namespace} Socket 在授权后立即断开`));
    });
  });
  // 客户端 connect 早于服务端 async connection 回调完成，必须等服务端明确登记监听器。
  const readyDeadline = Date.now() + 2_000;
  while (!appLogs.includes(`已连接: ${socket.id}`)) {
    if (!socket.connected) throw new Error(`${namespace} Socket 在服务端授权完成前断开`);
    if (Date.now() >= readyDeadline) {
      socket.disconnect();
      throw new Error(`${namespace} Socket 服务端授权就绪超时`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return socket;
}

async function socketDisconnectsAfterLockInvalid(
  namespace: string,
  auth: Record<string, unknown>,
  projectUUID: string,
): Promise<boolean> {
  const socket = connectSocket(`${appURL}/api/socket/${namespace}`, {
    path: ENGINE_IO_PATH,
    auth,
    extraHeaders: { cookie: sessionCookie },
    forceNew: true,
    reconnection: false,
    transports: ["websocket"],
  });
  return await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      socket.disconnect();
      resolve(false);
    }, 1_500);
    socket.once("connect_error", () => {
      clearTimeout(timeout);
      socket.disconnect();
      resolve(false);
    });
    socket.once("connect", () => {
      void request("POST", `/api/tianjiang/runtime/projects/${projectUUID}/lock-invalid`)
        .then(({ response }) => {
          if (response.status !== 200) {
            clearTimeout(timeout);
            socket.disconnect();
            resolve(false);
            return;
          }
          // 使用同一条已建立连接发起写事件，服务端必须重新校验锁而不是信任握手结果。
          socket.emit("chat", { content: "失锁后不得继续生成" });
        })
        .catch(() => {
          clearTimeout(timeout);
          socket.disconnect();
          resolve(false);
        });
    });
    socket.once("disconnect", () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

async function startApp(entry: string): Promise<ChildProcessWithoutNullStreams> {
  const childEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    TIANJIANG_ACCEPTANCE_MODE: "1",
    TIANJIANG_ACCEPTANCE_CENTRAL_API_URL: centralURL,
  };
  // 真实服务子进程已把 cwd 放在独立 .tmp 夹具，不继承父测试进程的全局 runtime 覆盖。
  delete childEnvironment.TIANJIANG_TEST_DATA_ROOT;
  delete childEnvironment.TIANJIANG_TEST_WORKTREE_ROOT;
  const child = spawn(process.execPath, [entry], {
    cwd: tempRoot,
    // 仅显式验收模式允许访问当前进程创建的 loopback stub。
    env: childEnvironment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    appLogs += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    appLogs += String(chunk);
  });
  appURL = "http://127.0.0.1:10588";
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`本地生产 Express 服务提前退出: ${child.exitCode}`);
    }
    try {
      await fetch(`${appURL}/api/tianjiang/auth/session`);
      return child;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  child.kill();
  throw new Error("本地生产 Express 服务启动超时");
}

async function stopApp(): Promise<void> {
  if (!appProcess || appProcess.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => appProcess.once("exit", () => resolve()));
  appProcess.kill();
  await exited;
}

async function restartApp(): Promise<void> {
  await stopApp();
  appProcess = await startApp(path.join(appRoot, "data", "serve", "app.js"));
}

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function readJSON(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  const bytes = Buffer.concat(chunks);
  if (request.method === "PUT" && (request.url ?? "").startsWith("/synthetic-upload/")) {
    lastUploadedProjectObject = bytes;
    if (currentUploadProject) remoteProjectObjects.set(currentUploadProject, bytes);
    return {};
  }
  return JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
}
