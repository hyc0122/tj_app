/**
 * 剧本 Agent 数据契约行为测试：
 * - 只读路由分类（真实 isLegacyProjectMutation）
 * - Socket 严格 number projectId（真实 requireStrictPositiveSafeInteger）
 * - setPlanData/getPlanData 真实路由 + 项目库 ALS
 * - 测试数据根隔离，禁止写入 app/data
 *
 * 注意：使用 ESM 静态 import 挂载生产 Router（与 bulkConfigureAgents 测试一致），
 * 避免 createRequire 导致 `@/utils` 默认导出 interop 丢失 callable db。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import express from "express";

import {
  requireStrictPositiveSafeInteger,
  PositiveSafeIntegerError,
  parsePositiveSafeInteger,
} from "../../src/tianjiang/runtime/positive-safe-integer";
import {
  isLegacyProjectMutation,
  isLegacyProjectRoute,
} from "../../src/tianjiang/runtime/legacy-project-guard";
import {
  activateUserDatabase,
  destroyAllDatabaseHandles,
  prepareProjectDatabase,
  resetDatabaseRuntimeForServe,
  beginDatabaseShutdown,
  db as activeDb,
} from "../../src/utils/db";
import {
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import setPlanDataRouter from "../../src/routes/scriptAgent/setPlanData";
import getPlanDataRouter from "../../src/routes/scriptAgent/getPlanData";

const worktreeRoot = path.resolve(__dirname, "../..", "..");
const testDataRoot = path.join(worktreeRoot, ".tmp", "script-agent-data-contract");
const appDataRoot = path.join(worktreeRoot, "app", "data");

function listRelativeFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else out.push(path.relative(root, p).replace(/\\/g, "/"));
    }
  };
  walk(root);
  return out.sort();
}

function ensureTestEnv(): void {
  process.env.NODE_TEST_CONTEXT = "1";
  process.env.TIANJIANG_TEST_WORKTREE_ROOT = worktreeRoot;
  process.env.TIANJIANG_TEST_DATA_ROOT = testDataRoot;
  fs.mkdirSync(testDataRoot, { recursive: true });
}

const appDataBefore = listRelativeFiles(appDataRoot);
ensureTestEnv();

const PROJECT_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PROJECT_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 88041 };

async function postJson(
  port: number,
  routePath: string,
  body: unknown,
): Promise<{ status: number; json: any }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: routePath,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: any = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = { raw: text };
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function withProjectHttp(
  projectUuid: string,
  run: (port: number) => Promise<void>,
): Promise<void> {
  ensureTestEnv();
  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;
  process.chdir(path.join(worktreeRoot, "app"));
  process.env.NODE_ENV = "prod";
  resetDatabaseRuntimeForServe();
  let server: http.Server | undefined;
  try {
    await activateUserDatabase(IDENTITY);
    await runWithUserStorage(IDENTITY, async () => {
      await prepareProjectDatabase(projectUuid);
      await runWithProjectStorage(projectUuid, async () => {
        const app = express();
        app.use(express.json({ limit: "2mb" }));
        // 与 bulk 生产 Router 测试一致：请求进入账号 + 项目 ALS
        app.use((_req, _res, next) => {
          runWithUserStorage(IDENTITY, () => {
            runWithProjectStorage(projectUuid, () => {
              next();
            });
          });
        });
        app.use("/api/scriptAgent/setPlanData", setPlanDataRouter);
        app.use("/api/scriptAgent/getPlanData", getPlanDataRouter);
        server = http.createServer(app);
        await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as { port: number }).port;
        await run(port);
      });
    });
  } finally {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    beginDatabaseShutdown();
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
}

test("严格正安全整数：拒绝字符串/0/NaN，接受 number", () => {
  assert.equal(requireStrictPositiveSafeInteger(101), 101);
  assert.throws(() => requireStrictPositiveSafeInteger("101"), PositiveSafeIntegerError);
  assert.throws(() => requireStrictPositiveSafeInteger(0), PositiveSafeIntegerError);
  assert.throws(() => requireStrictPositiveSafeInteger(NaN), PositiveSafeIntegerError);
  assert.throws(() => requireStrictPositiveSafeInteger(1.2), PositiveSafeIntegerError);
  assert.throws(
    () => requireStrictPositiveSafeInteger(Number.MAX_SAFE_INTEGER + 1),
    PositiveSafeIntegerError,
  );
  assert.equal(parsePositiveSafeInteger("101"), 101);
});

test("只读路由：getPlanData/getMemory/getModelDetails 不得判为 mutation", () => {
  assert.equal(isLegacyProjectMutation("POST", "/api/scriptAgent/getPlanData"), false);
  assert.equal(isLegacyProjectMutation("POST", "/api/agents/getMemory"), false);
  assert.equal(isLegacyProjectMutation("POST", "/api/project/getModelDetails"), false);
  assert.equal(isLegacyProjectMutation("POST", "/api/scriptAgent/setPlanData"), true);
  assert.equal(isLegacyProjectMutation("POST", "/api/agents/clearMemory"), true);
  assert.equal(isLegacyProjectMutation("POST", "/api/scriptAgent/updateData"), true);
  assert.equal(isLegacyProjectRoute("/api/project/getModelDetails"), false);
});

test("写路由 setPlanData/clearMemory 仍是 mutation", () => {
  assert.equal(isLegacyProjectMutation("POST", "/api/scriptAgent/setPlanData"), true);
  assert.equal(isLegacyProjectMutation("POST", "/api/agents/clearMemory"), true);
  assert.equal(isLegacyProjectMutation("POST", "/api/scriptAgent/updateData"), true);
});

test("setPlanData：空项目创建 workData 与多剧本，立即读取可见；getPlanData 无数据不插入", async () => {
  await withProjectHttp(PROJECT_A, async (port) => {
    const empty = await postJson(port, "/api/scriptAgent/getPlanData", {
      projectId: 101,
      agentType: "scriptAgent",
    });
    assert.equal(empty.status, 200, JSON.stringify(empty.json));
    assert.equal(empty.json?.data?.id, null);
    assert.deepEqual(empty.json?.data?.data?.script ?? [], []);
    const workCount0 = await activeDb("o_agentWorkData")
      .where({ projectId: 101, key: "scriptAgent" })
      .count({ c: "*" })
      .first();
    assert.equal(Number((workCount0 as { c?: number | string } | undefined)?.c ?? 0), 0);

    const saved = await postJson(port, "/api/scriptAgent/setPlanData", {
      projectId: 101,
      agentType: "scriptAgent",
      data: {
        storySkeleton: "骨架-A",
        adaptationStrategy: "策略-A",
        script: [
          { name: "第一集", content: "内容1" },
          { name: "第二集", content: "内容2" },
        ],
      },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));

    const loaded = await postJson(port, "/api/scriptAgent/getPlanData", {
      projectId: 101,
      agentType: "scriptAgent",
    });
    assert.equal(loaded.status, 200, JSON.stringify(loaded.json));
    assert.equal(loaded.json?.data?.data?.storySkeleton, "骨架-A");
    assert.equal(loaded.json?.data?.data?.adaptationStrategy, "策略-A");
    assert.equal(loaded.json?.data?.data?.script?.length, 2);
    assert.ok(loaded.json?.data?.id != null);

    const rows = await activeDb("o_script").where({ projectId: 101 }).select("name", "content");
    assert.equal(rows.length, 2);
    assert.ok(rows.some((r: { name: string; content: string }) => r.name === "第一集" && r.content === "内容1"));
  });
});

test("setPlanData：跨项目 script.id 拒绝且不修改任何数据", async () => {
  await withProjectHttp(PROJECT_A, async (port) => {
    const first = await postJson(port, "/api/scriptAgent/setPlanData", {
      projectId: 201,
      agentType: "scriptAgent",
      data: {
        storySkeleton: "骨架-本项目",
        adaptationStrategy: "策略-本项目",
        script: [{ name: "本集", content: "本内容" }],
      },
    });
    assert.equal(first.status, 200, JSON.stringify(first.json));

    await activeDb("o_script").insert({
      projectId: 9999,
      name: "外项目",
      content: "外内容",
    });
    const foreign = await activeDb("o_script").where({ projectId: 9999, name: "外项目" }).first();
    assert.ok(foreign?.id);

    const beforeWork = await activeDb("o_agentWorkData")
      .where({ projectId: 201, key: "scriptAgent" })
      .first();
    const beforeScript = await activeDb("o_script").where({ projectId: 201 }).select("*");

    const rejected = await postJson(port, "/api/scriptAgent/setPlanData", {
      projectId: 201,
      agentType: "scriptAgent",
      data: {
        storySkeleton: "不应写入",
        adaptationStrategy: "不应写入",
        script: [{ id: Number(foreign.id), name: "劫持", content: "坏" }],
      },
    });
    assert.equal(rejected.status, 400);
    assert.match(String(rejected.json?.message ?? ""), /剧本不属于当前项目|保存已取消|参数错误/);

    const afterWork = await activeDb("o_agentWorkData")
      .where({ projectId: 201, key: "scriptAgent" })
      .first();
    const afterScript = await activeDb("o_script").where({ projectId: 201 }).select("*");
    assert.equal(afterWork?.data, beforeWork?.data);
    assert.deepEqual(
      afterScript.map((r: { name: string; content: string }) => ({ name: r.name, content: r.content })),
      beforeScript.map((r: { name: string; content: string }) => ({ name: r.name, content: r.content })),
    );
    const foreignAfter = await activeDb("o_script").where({ id: foreign.id }).first();
    assert.equal(foreignAfter?.content, "外内容");
  });
});

test("setPlanData：事务中途失败整体回滚", async () => {
  await withProjectHttp(PROJECT_B, async (port) => {
    await postJson(port, "/api/scriptAgent/setPlanData", {
      projectId: 301,
      agentType: "scriptAgent",
      data: {
        storySkeleton: "初始骨架",
        adaptationStrategy: "初始策略",
        script: [{ name: "保留集", content: "保留内容" }],
      },
    });
    await activeDb("o_script").insert({
      projectId: 7777,
      name: "外",
      content: "外",
    });
    const foreign = await activeDb("o_script").where({ projectId: 7777 }).first();
    assert.ok(foreign?.id);
    const useId = Number(foreign.id);

    const before = await activeDb("o_agentWorkData")
      .where({ projectId: 301, key: "scriptAgent" })
      .first();
    const res = await postJson(port, "/api/scriptAgent/setPlanData", {
      projectId: 301,
      agentType: "scriptAgent",
      data: {
        storySkeleton: "半状态骨架",
        adaptationStrategy: "半状态策略",
        script: [
          { name: "保留集", content: "应回滚" },
          { id: useId, name: "坏", content: "坏" },
        ],
      },
    });
    assert.equal(res.status, 400);
    const after = await activeDb("o_agentWorkData")
      .where({ projectId: 301, key: "scriptAgent" })
      .first();
    assert.equal(after?.data, before?.data);
    const keep = await activeDb("o_script").where({ projectId: 301, name: "保留集" }).first();
    assert.equal(keep?.content, "保留内容");
  });
});

test("A/B 项目数据隔离：写 A 不影响 B", async () => {
  await withProjectHttp(PROJECT_A, async (port) => {
    await postJson(port, "/api/scriptAgent/setPlanData", {
      projectId: 401,
      agentType: "scriptAgent",
      data: {
        storySkeleton: "仅A",
        adaptationStrategy: "仅A策略",
        script: [{ name: "A集", content: "A内容" }],
      },
    });
  });
  await withProjectHttp(PROJECT_B, async (port) => {
    const empty = await postJson(port, "/api/scriptAgent/getPlanData", {
      projectId: 401,
      agentType: "scriptAgent",
    });
    assert.equal(empty.json?.data?.id, null);
    assert.equal((empty.json?.data?.data?.script ?? []).length, 0);

    await postJson(port, "/api/scriptAgent/setPlanData", {
      projectId: 402,
      agentType: "scriptAgent",
      data: {
        storySkeleton: "仅B",
        adaptationStrategy: "仅B策略",
        script: [{ name: "B集", content: "B内容" }],
      },
    });
    const loaded = await postJson(port, "/api/scriptAgent/getPlanData", {
      projectId: 402,
      agentType: "scriptAgent",
    });
    assert.equal(loaded.json?.data?.data?.storySkeleton, "仅B");
  });
});

test("字符串 projectId body 被 Zod 拒绝（参数错误）", async () => {
  await withProjectHttp(PROJECT_A, async (port) => {
    const res = await postJson(port, "/api/scriptAgent/getPlanData", {
      projectId: "101",
      agentType: "scriptAgent",
    });
    assert.equal(res.status, 400);
    assert.match(String(res.json?.message ?? ""), /参数错误/);
  });
});

test("测试环境变量契约与 app/data 不污染", async () => {
  ensureTestEnv();
  assert.equal(process.env.NODE_TEST_CONTEXT, "1");
  assert.equal(
    path.resolve(process.env.TIANJIANG_TEST_WORKTREE_ROOT ?? ""),
    path.resolve(worktreeRoot),
  );
  assert.equal(
    path.resolve(process.env.TIANJIANG_TEST_DATA_ROOT ?? ""),
    path.resolve(testDataRoot),
  );
  assert.ok(testDataRoot.startsWith(path.join(worktreeRoot, ".tmp")));
  const appDataAfter = listRelativeFiles(appDataRoot);
  assert.deepEqual(appDataAfter, appDataBefore, "本测试套件不得向 app/data 新增文件");
  beginDatabaseShutdown();
  await destroyAllDatabaseHandles().catch(() => undefined);
  fs.rmSync(testDataRoot, { recursive: true, force: true });
});
