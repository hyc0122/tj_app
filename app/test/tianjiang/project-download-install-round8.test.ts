import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import type { CentralAuthGateway, CentralSession } from "../../src/tianjiang/auth/central-session";
import { projectDirectory } from "../../src/tianjiang/data/paths";
import { ProjectStore } from "../../src/tianjiang/data/project-store";
import { CentralRuntimeAdapter } from "../../src/tianjiang/runtime/central-runtime-adapter";
import { RuntimeProjectLocal } from "../../src/tianjiang/runtime/project-runtime-local";
import { PersonalProjectSync } from "../../src/tianjiang/sync/personal-project-sync";

const projectUuid = "018f3d6e-2d9e-7b6c-8a9b-000000000081";
const deviceUuid = "018f3d6e-2d9e-7b6c-8a9b-1234567890a1";
const userSegment = "8".repeat(32);
const remoteVersion = 14;
const workspaceTempRoot = path.resolve(__dirname, "../../../.tmp");
fs.mkdirSync(workspaceTempRoot, { recursive: true });

const session = {
  id: "session",
  serverUrl: "https://api.example.invalid",
  token: "memory-only",
  expiresAt: Date.now() + 60_000,
  validatedAt: Date.now(),
  user: { id: 7, username: "alice", nickname: "Alice" },
} as CentralSession;

test("同版本旧空库必须下载并安装中央 project.sqlite，而不能只同步名称和版本", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-project-download-r8-"));
  const remoteDatabasePath = path.join(dataRoot, "remote-project.sqlite");
  const localRoot = projectDirectory(dataRoot, projectUuid, userSegment);
  fs.mkdirSync(localRoot, { recursive: true });

  // 中文注释：远端快照用真实 SQLite 和旧业务表，确保测试验证的是正文数据而非 mock records。
  const remoteDatabase = new Database(remoteDatabasePath);
  remoteDatabase.exec(`
    CREATE TABLE o_novel (
      id INTEGER PRIMARY KEY,
      projectId INTEGER NOT NULL,
      chapter TEXT NOT NULL,
      chapterData TEXT NOT NULL
    );
    INSERT INTO o_novel(id, projectId, chapter, chapterData)
    VALUES (101, 1, '第一章', '这是真实中央正文');
  `);
  remoteDatabase.close();
  const remoteBytes = fs.readFileSync(remoteDatabasePath);
  const remoteMD5 = crypto.createHash("md5").update(remoteBytes).digest("hex");

  // 中文注释：复现已发布客户端的坏状态——本地是空库，却被写成与中央相同的版本号。
  const emptyStore = new ProjectStore(dataRoot, projectUuid, "readwrite", userSegment);
  emptyStore.close();
  fs.writeFileSync(path.join(localRoot, ".tianjiang-manifest.json"), JSON.stringify({
    version: remoteVersion,
    objects: [{ relativePath: "project.sqlite", size: remoteBytes.length, md5: remoteMD5 }],
  }, null, 2));

  const calls: Array<{ pathname: string; method: string; body: unknown }> = [];
  const gateway = {
    forwardBusinessRequest: async (
      _session: CentralSession,
      pathname: string,
      method: string,
      body?: unknown,
    ) => {
      calls.push({ pathname, method, body });
      if (pathname.endsWith(`/projects/${projectUuid}`)) {
        return {
          projectUuid,
          currentVersion: remoteVersion,
          objects: [{ relativePath: "project.sqlite", size: remoteBytes.length, md5: remoteMD5 }],
        };
      }
      if (pathname.endsWith("/object-authorizations")) {
        const request = body as { expiresInSeconds?: number };
        if ((request.expiresInSeconds ?? 0) > 600) {
          // 中文注释：真实后台下载授权上限为 600 秒，超过上限会返回“请求参数无效”。
          throw Object.assign(new Error("请求参数无效"), { status: 422 });
        }
        assert.deepEqual(body, {
          method: "GET",
          projectUuid,
          version: remoteVersion,
          relativePath: "project.sqlite",
          deviceUuid,
          expiresInSeconds: 600,
          useCdn: false,
        });
        return { url: "https://oss.example.invalid/project.sqlite?signature=redacted" };
      }
      throw new Error(`未预期请求：${method} ${pathname}`);
    },
  } as unknown as CentralAuthGateway;
  let objectDownloads = 0;
  const transport = async (_input: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method, "GET");
    objectDownloads += 1;
    return new Response(remoteBytes, {
      status: 200,
      headers: { "x-oss-request-id": "safe-download-request-id" },
    });
  };

  const local = new RuntimeProjectLocal(dataRoot, projectUuid, userSegment);
  const adapter = new CentralRuntimeAdapter(
    gateway,
    session,
    deviceUuid,
    transport as typeof fetch,
  );
  const remote = adapter.personalRemote(projectUuid, (snapshot) => {
    local.acceptDownloaded(snapshot);
  }, {
    currentVersion: remoteVersion,
    readObject: () => Buffer.alloc(0),
  });
  const sync = new PersonalProjectSync(local, remote, () => true);
  sync.open();

  try {
    await sync.ensureLoaded();
    local.close();

    const installed = new Database(path.join(localRoot, "project.sqlite"), { readonly: true });
    let novel: unknown;
    try {
      novel = installed.prepare(
        "SELECT id, chapter, chapterData FROM o_novel WHERE id = ?",
      ).get(101);
    } finally {
      // 中文注释：查询预期失败时也必须释放 Windows 文件句柄，保留真正的业务 RED。
      installed.close();
    }

    assert.deepEqual(novel, {
      id: 101,
      chapter: "第一章",
      chapterData: "这是真实中央正文",
    });
    assert.equal(objectDownloads, 1);
    assert.equal(
      calls.filter((item) => item.pathname.endsWith("/object-authorizations")).length,
      1,
    );
  } finally {
    local.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("OSS 下载内容与中央 MD5 不一致时必须失败关闭且不得交给本地安装", async () => {
  const expectedBytes = Buffer.from("expected-project-snapshot");
  const expectedMD5 = crypto.createHash("md5").update(expectedBytes).digest("hex");
  let accepted = false;
  const gateway = {
    forwardBusinessRequest: async (
      _session: CentralSession,
      pathname: string,
    ) => {
      if (pathname.endsWith(`/projects/${projectUuid}`)) {
        return {
          currentVersion: 1,
          objects: [{
            relativePath: "project.sqlite",
            size: expectedBytes.length,
            md5: expectedMD5,
          }],
        };
      }
      if (pathname.endsWith("/object-authorizations")) {
        return { url: "https://oss.example.invalid/project.sqlite?signature=redacted" };
      }
      throw new Error(`未预期请求：${pathname}`);
    },
  } as unknown as CentralAuthGateway;
  const adapter = new CentralRuntimeAdapter(
    gateway,
    session,
    deviceUuid,
    (async () => new Response(Buffer.from("tampered-project-snapshot"), {
      status: 200,
    })) as typeof fetch,
  );
  const remote = adapter.personalRemote(projectUuid, () => {
    accepted = true;
  }, {
    currentVersion: 1,
    readObject: () => Buffer.alloc(0),
  });

  await assert.rejects(
    () => {
      if (!remote.downloadObjects) throw new Error("downloadObjects 生产入口必须存在");
      return remote.downloadObjects(
      {
        version: 1,
        objects: [{
          relativePath: "project.sqlite",
          size: expectedBytes.length,
          md5: expectedMD5,
        }],
      },
      [{
        relativePath: "project.sqlite",
        size: expectedBytes.length,
        md5: expectedMD5,
      }]);
    },
    (error: unknown) => {
      assert.equal(
        (error as Error & { code?: string }).code,
        "PROJECT_DOWNLOAD_CHECKSUM_MISMATCH",
      );
      return true;
    },
  );
  assert.equal(accepted, false);
});

test("下载对象并非完整 SQLite 时必须保留原本地数据库", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-project-download-invalid-r8-"));
  const localRoot = projectDirectory(dataRoot, projectUuid, userSegment);
  const store = new ProjectStore(dataRoot, projectUuid, "readwrite", userSegment);
  store.setRecord("sentinel", "local", { value: "必须保留" });
  store.close();

  const invalidBytes = Buffer.from("not-a-sqlite-database");
  const invalidMD5 = crypto.createHash("md5").update(invalidBytes).digest("hex");
  fs.writeFileSync(path.join(localRoot, ".tianjiang-manifest.json"), JSON.stringify({
    version: 1,
    objects: [{ relativePath: "project.sqlite", size: 1, md5: "0".repeat(32) }],
  }, null, 2));
  const local = new RuntimeProjectLocal(dataRoot, projectUuid, userSegment);
  local.acceptDownloaded({
    version: 2,
    objects: [{
      relativePath: "project.sqlite",
      size: invalidBytes.length,
      md5: invalidMD5,
    }],
    records: {},
    objectContents: { "project.sqlite": Uint8Array.from(invalidBytes) },
  });

  try {
    await assert.rejects(
      () => local.install({
        version: 2,
        objects: [{
          relativePath: "project.sqlite",
          size: invalidBytes.length,
          md5: invalidMD5,
        }],
      }, ["project.sqlite"]),
      /安装中央项目数据库失败/,
    );
    local.close();
    const preserved = new ProjectStore(dataRoot, projectUuid, "readonly", userSegment);
    try {
      assert.deepEqual(preserved.getRecord("sentinel", "local"), { value: "必须保留" });
    } finally {
      preserved.close();
    }
  } finally {
    local.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
