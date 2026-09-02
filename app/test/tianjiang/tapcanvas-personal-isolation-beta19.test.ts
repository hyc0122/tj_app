/**
 * TapCanvas beta.19：个人作用域、目录隔离、书籍/诊断桥接。
 * 只伪造会话与目录，不得 mock 被测路由。
 */
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import test from "node:test";

import { db, initializeCanvasWorkspace, pauseGenerationTaskRecovery, releaseProjectDatabaseLease } from "../../src/utils/db";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";
import { runWithProjectStorage } from "../../src/tianjiang/runtime/user-storage-context";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import { setTapCanvasCreateProjectForTests } from "../../src/routes/tianjiang/tapcanvas-compat";

const PERSONAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa19";
const TEAM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb19";
const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccc19";
const NOVEL = "dddddddd-dddd-4ddd-8ddd-dddddddddd19";
const SESSION = {
  id: "sess-tapcanvas-beta19",
  serverUrl: "https://api.j11.com.cn",
  token: "memory-only",
  expiresAt: Date.now() + 60_000,
  validatedAt: Date.now(),
  user: { id: 7601, username: "owner", nickname: "owner" },
};

type CatalogItem = {
  projectUuid: string;
  name: string;
  kind: "personal" | "team";
  businessType: "canvas" | "novel" | "script" | "storyboard";
  ownerUserId: number;
  myRole: "owner" | "editor" | "viewer";
  openMode: "editable" | "readonly";
  updatedAt: string;
};

function catalogItem(overrides: Partial<CatalogItem> & Pick<CatalogItem, "projectUuid" | "name">): CatalogItem {
  return {
    kind: "personal",
    businessType: "canvas",
    ownerUserId: 7601,
    myRole: "owner",
    openMode: "editable",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

async function listen(app: express.Express): Promise<{ server: http.Server; origin: string }> {
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function withCompat<T>(run: (origin: string) => Promise<T>): Promise<T> {
  const { default: tapcanvasCompatRouter } = await import("../../src/routes/tianjiang/tapcanvas-compat");
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    (req as { centralSession?: unknown }).centralSession = SESSION;
    next();
  });
  app.use("/api/tianjiang/tapcanvas", tapcanvasCompatRouter);
  const { server, origin } = await listen(app);
  try {
    return await run(origin);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function stubCatalog(items: CatalogItem[]): () => void {
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  const originalOpen = syncCoordinator.openProject.bind(syncCoordinator);
  syncCoordinator.listProjects = (() => items.map((item) => ({ ...item }))) as typeof syncCoordinator.listProjects;
  (syncCoordinator as { isProjectOpened?: (uuid: string) => boolean }).isProjectOpened = (uuid) => (
    items.some((item) => item.projectUuid === uuid && item.kind === "personal" && item.businessType === "canvas")
  );
  syncCoordinator.openProject = (async (_session, projectUuid: string) => {
    const item = items.find((row) => row.projectUuid === projectUuid);
    if (!item || item.kind !== "personal" || item.businessType !== "canvas") {
      throw Object.assign(new Error("项目不存在或不可见"), { status: 403 });
    }
    return { projectUuid };
  }) as typeof syncCoordinator.openProject;
  return () => {
    syncCoordinator.listProjects = originalList;
    syncCoordinator.openProject = originalOpen;
    delete (syncCoordinator as { isProjectOpened?: unknown }).isProjectOpened;
  };
}

async function jsonOf(response: Response): Promise<unknown> {
  return response.json();
}

test("缺少 teamId 与 teamId=personal 都能新建个人画布，真实团队 ID 仍被拒绝", async () => {
  await runWithTemporaryAccount("tc-b19-create", async () => {
    const created: string[] = [];
    setTapCanvasCreateProjectForTests(async (_session, name) => {
      created.push(name);
      return {
        id: PERSONAL,
        name,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        owner: "owner",
        ownerName: "owner",
        access: "owner",
        projectKind: "creative",
        teamShared: false,
      };
    });
    try {
      await withCompat(async (origin) => {
        const missing = await fetch(`${origin}/api/tianjiang/tapcanvas/projects`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "无团队画布" }),
        });
        assert.equal(missing.status, 200);
        assert.equal((await missing.json() as { id: string; teamShared: boolean }).teamShared, false);

        const personal = await fetch(`${origin}/api/tianjiang/tapcanvas/projects`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "哨兵画布", teamId: "personal" }),
        });
        assert.equal(personal.status, 200, "teamId=personal 是个人作用域哨兵，不得返回暂不支持团队画布");
        assert.equal((await personal.json() as { error?: string }).error, undefined);

        const personalPrefix = await fetch(`${origin}/api/tianjiang/tapcanvas/projects`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "前缀画布", teamId: "personal_user-1" }),
        });
        assert.equal(personalPrefix.status, 200);

        const bootstrap = await fetch(`${origin}/api/tianjiang/tapcanvas/projects/bootstrap`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "规划画布",
            teamId: "personal",
            flow: { name: "画布", data: { nodes: [], edges: [] } },
          }),
        });
        assert.notEqual((await bootstrap.json() as { error?: string }).error, "team_disabled");
        assert.notEqual(bootstrap.status, 403);

        const team = await fetch(`${origin}/api/tianjiang/tapcanvas/projects`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "团队画布", teamId: "team-real-uuid" }),
        });
        assert.equal(team.status, 403);
        assert.equal((await team.json() as { error: string }).error, "team_disabled");
      });
      assert.ok(created.includes("无团队画布"));
      assert.ok(created.includes("哨兵画布"));
    } finally {
      setTapCanvasCreateProjectForTests(null);
    }
  });
});

test("个人目录只返回当前账号 kind=personal 且 businessType=canvas 的项目，团队画布不得伪装成个人画布", async () => {
  await runWithTemporaryAccount("tc-b19-list", async () => {
    const items = [
      catalogItem({ projectUuid: PERSONAL, name: "我的画布" }),
      catalogItem({ projectUuid: TEAM, name: "团队画布", kind: "team" }),
      catalogItem({ projectUuid: NOVEL, name: "小说项目", businessType: "novel" }),
      catalogItem({ projectUuid: OTHER, name: "他人画布", ownerUserId: 8801, myRole: "editor" }),
    ];
    const restore = stubCatalog(items);
    try {
      await withCompat(async (origin) => {
        const listed = await fetch(`${origin}/api/tianjiang/tapcanvas/projects?teamId=personal&limit=30`);
        assert.equal(listed.status, 200);
        const body = await listed.json() as { items: Array<{ id: string; name: string; teamShared?: boolean; access?: string }> };
        const ids = body.items.map((item) => item.id);
        assert.deepEqual(ids, [PERSONAL]);
        assert.equal(body.items[0]?.name, "我的画布");
        assert.equal(body.items.some((item) => item.id === TEAM), false);
      });
      const stillThere = syncCoordinator.listProjects(SESSION as never);
      assert.ok(stillThere.some((item) => item.projectUuid === TEAM), "旧团队画布不得被删除或迁移");
      assert.equal(stillThere.find((item) => item.projectUuid === TEAM)?.kind, "team");
    } finally {
      restore();
    }
  });
});

test("当前账号真实个人画布可打开、保存并再次打开；他人/团队/非画布项目不得越权打开", async () => {
  await runWithTemporaryAccount("tc-b19-open", async () => {
    const restore = stubCatalog([
      catalogItem({ projectUuid: PERSONAL, name: "可编辑画布" }),
      catalogItem({ projectUuid: TEAM, name: "团队画布", kind: "team" }),
      catalogItem({ projectUuid: NOVEL, name: "小说", businessType: "novel" }),
      catalogItem({ projectUuid: OTHER, name: "他人", ownerUserId: 8801, myRole: "owner" }),
    ]);
    try {
      await initializeCanvasWorkspace(PERSONAL);
      await withCompat(async (origin) => {
        const saved = await fetch(`${origin}/api/tianjiang/tapcanvas/flows`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId: PERSONAL,
            name: "画布",
            data: { nodes: [{ id: "n-open", type: "taskNode", data: { kind: "text", prompt: "第一稿" } }], edges: [] },
            expectedRevision: 0,
          }),
        });
        assert.equal(saved.status, 200);
        const first = await saved.json() as { canvasRevision: number; data: { nodes: Array<{ id: string }> } };
        assert.equal(first.canvasRevision, 1);

        const loaded = await fetch(`${origin}/api/tianjiang/tapcanvas/flows/${PERSONAL}`);
        assert.equal(loaded.status, 200);
        const flow = await loaded.json() as { canvasRevision: number; data: { nodes: Array<{ data?: { prompt?: string } }> } };
        assert.equal(flow.canvasRevision, 1);
        assert.ok(flow.data.nodes.some((node) => String(node.data?.prompt ?? "").includes("第一稿")));

        const listed = await fetch(`${origin}/api/tianjiang/tapcanvas/flows?projectId=${PERSONAL}`);
        assert.equal(listed.status, 200);
        const listedBody = await listed.json() as Array<{ canvasRevision: number }>;
        assert.equal(listedBody[0]?.canvasRevision, 1);

        const teamOpen = await fetch(`${origin}/api/tianjiang/tapcanvas/flows/${TEAM}`);
        assert.notEqual(teamOpen.status, 200);
        const teamListed = await fetch(`${origin}/api/tianjiang/tapcanvas/flows?projectId=${TEAM}`);
        assert.notEqual(teamListed.status, 200);
        assert.notEqual(JSON.stringify(await teamListed.json()), "[]");
        const otherOpen = await fetch(`${origin}/api/tianjiang/tapcanvas/flows/${OTHER}`);
        assert.notEqual(otherOpen.status, 200, "他人个人画布即使被标成 owner 也不得越权打开");
        const novelOpen = await fetch(`${origin}/api/tianjiang/tapcanvas/flows/${NOVEL}`);
        assert.notEqual(novelOpen.status, 200);
      });
    } finally {
      restore();
      await pauseGenerationTaskRecovery().catch(() => undefined);
      await releaseProjectDatabaseLease(PERSONAL, "ui").catch(() => undefined);
    }
  });
});

test("未打开的个人画布必须经授权打开后可读，不得因未在打开表而伪装成不存在", async () => {
  await runWithTemporaryAccount("tc-b19-ensure-open", async () => {
    const items = [catalogItem({ projectUuid: PERSONAL, name: "历史画布" })];
    const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
    const originalOpen = syncCoordinator.openProject.bind(syncCoordinator);
    const originalClose = syncCoordinator.closeProject.bind(syncCoordinator);
    let opened = false;
    const closeGenerations: number[] = [];
    syncCoordinator.listProjects = (() => items.map((item) => ({ ...item }))) as typeof syncCoordinator.listProjects;
    (syncCoordinator as { isProjectOpened?: (uuid: string) => boolean }).isProjectOpened = () => opened;
    syncCoordinator.openProject = (async () => {
      opened = true;
      return { projectUuid: PERSONAL, runtimeGeneration: 19 };
    }) as typeof syncCoordinator.openProject;
    syncCoordinator.closeProject = (async (_session, projectUuid, runtimeGeneration) => {
      assert.equal(projectUuid, PERSONAL);
      closeGenerations.push(Number(runtimeGeneration));
      opened = false;
      return { projectUuid, state: "closed", runtimeGeneration: 0 };
    }) as typeof syncCoordinator.closeProject;
    try {
      await initializeCanvasWorkspace(PERSONAL);
      await withCompat(async (origin) => {
        const loaded = await fetch(`${origin}/api/tianjiang/tapcanvas/flows/${PERSONAL}`);
        assert.equal(loaded.status, 200, "已有个人画布关闭后重开不得返回项目不存在或不可见");
        assert.deepEqual(closeGenerations, [19], "兼容接口临时打开的运行时必须携带准确代次关闭");
        assert.equal(opened, false, "接口完成后不得把历史画布永久留在内存打开表");
      });
    } finally {
      syncCoordinator.listProjects = originalList;
      syncCoordinator.openProject = originalOpen;
      syncCoordinator.closeProject = originalClose;
      delete (syncCoordinator as { isProjectOpened?: unknown }).isProjectOpened;
      await pauseGenerationTaskRecovery().catch(() => undefined);
      await releaseProjectDatabaseLease(PERSONAL, "ui").catch(() => undefined);
    }
  });
});

test("临时打开返回代次但未登记成功时仍必须关闭，禁止泄漏项目运行时", async () => {
  await runWithTemporaryAccount("tc-b19-open-registration-failed", async () => {
    const items = [catalogItem({ projectUuid: PERSONAL, name: "登记失败画布" })];
    const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
    const originalOpen = syncCoordinator.openProject.bind(syncCoordinator);
    const originalClose = syncCoordinator.closeProject.bind(syncCoordinator);
    const closeGenerations: number[] = [];
    syncCoordinator.listProjects = (() => items.map((item) => ({ ...item }))) as typeof syncCoordinator.listProjects;
    // 中文注释：模拟 open 返回成功代次，但权威打开表仍未登记的异常现场。
    (syncCoordinator as { isProjectOpened?: () => boolean }).isProjectOpened = () => false;
    syncCoordinator.openProject = (async () => ({
      projectUuid: PERSONAL,
      runtimeGeneration: 20,
    })) as typeof syncCoordinator.openProject;
    syncCoordinator.closeProject = (async (_session, projectUuid, runtimeGeneration) => {
      assert.equal(projectUuid, PERSONAL);
      closeGenerations.push(Number(runtimeGeneration));
      return { projectUuid, state: "closed", runtimeGeneration: 0 };
    }) as typeof syncCoordinator.closeProject;
    try {
      await withCompat(async (origin) => {
        const loaded = await fetch(`${origin}/api/tianjiang/tapcanvas/flows/${PERSONAL}`);
        assert.notEqual(loaded.status, 200, "打开表未登记时必须拒绝访问");
        assert.deepEqual(closeGenerations, [20], "拒绝访问前仍须按准确代次回收临时运行时");
      });
    } finally {
      syncCoordinator.listProjects = originalList;
      syncCoordinator.openProject = originalOpen;
      syncCoordinator.closeProject = originalClose;
      delete (syncCoordinator as { isProjectOpened?: unknown }).isProjectOpened;
    }
  });
});

test("只读个人画布拒绝写入时必须关闭本次临时打开的运行时", async () => {
  await runWithTemporaryAccount("tc-b19-readonly-cleanup", async () => {
    const items = [catalogItem({ projectUuid: PERSONAL, name: "只读画布", openMode: "readonly" })];
    const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
    const originalOpen = syncCoordinator.openProject.bind(syncCoordinator);
    const originalClose = syncCoordinator.closeProject.bind(syncCoordinator);
    let opened = false;
    const closeGenerations: number[] = [];
    syncCoordinator.listProjects = (() => items.map((item) => ({ ...item }))) as typeof syncCoordinator.listProjects;
    (syncCoordinator as { isProjectOpened?: () => boolean }).isProjectOpened = () => opened;
    syncCoordinator.openProject = (async () => {
      opened = true;
      return { projectUuid: PERSONAL, runtimeGeneration: 21 };
    }) as typeof syncCoordinator.openProject;
    syncCoordinator.closeProject = (async (_session, projectUuid, runtimeGeneration) => {
      assert.equal(projectUuid, PERSONAL);
      closeGenerations.push(Number(runtimeGeneration));
      opened = false;
      return { projectUuid, state: "closed", runtimeGeneration: 0 };
    }) as typeof syncCoordinator.closeProject;
    try {
      await withCompat(async (origin) => {
        const saved = await fetch(`${origin}/api/tianjiang/tapcanvas/flows`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId: PERSONAL,
            name: "不得保存",
            data: { nodes: [], edges: [] },
            expectedRevision: 0,
          }),
        });
        assert.notEqual(saved.status, 200, "只读画布必须拒绝写入");
        assert.deepEqual(closeGenerations, [21], "只读拒绝后仍须回收临时运行时");
        assert.equal(opened, false);
      });
    } finally {
      syncCoordinator.listProjects = originalList;
      syncCoordinator.openProject = originalOpen;
      syncCoordinator.closeProject = originalClose;
      delete (syncCoordinator as { isProjectOpened?: unknown }).isProjectOpened;
    }
  });
});

test("书籍列表与索引：有小说返回真实章节，无小说返回空数组，故障不得伪装成空目录，禁止跨项目读取", async () => {
  await runWithTemporaryAccount("tc-b19-books", async () => {
    const restore = stubCatalog([
      catalogItem({ projectUuid: PERSONAL, name: "有书" }),
      catalogItem({ projectUuid: OTHER, name: "另一本", ownerUserId: 7601 }),
    ]);
    try {
      await initializeCanvasWorkspace(PERSONAL);
      await initializeCanvasWorkspace(OTHER);
      await runWithProjectStorage(PERSONAL, async () => {
        await db("o_novel").insert([
          {
            id: 11,
            chapterIndex: 1,
            reel: "卷一",
            chapter: "第一章 海边",
            chapterData: "风把衣摆吹起来。",
            projectId: 101,
            eventState: 0,
            createTime: 1_700_000_001,
          },
          {
            id: 12,
            chapterIndex: 2,
            reel: "卷一",
            chapter: "第二章 夜雨",
            chapterData: "便利店的灯还亮着。",
            projectId: 101,
            eventState: 0,
            createTime: 1_700_000_002,
          },
        ]);
      });
      await withCompat(async (origin) => {
        const empty = await fetch(`${origin}/api/tianjiang/tapcanvas/assets/books?projectId=${OTHER}`);
        assert.equal(empty.status, 200, "无小说时不得 404");
        assert.deepEqual(await empty.json(), []);

        const listed = await fetch(`${origin}/api/tianjiang/tapcanvas/assets/books?projectId=${PERSONAL}`);
        assert.equal(listed.status, 200);
        const books = await listed.json() as Array<{ bookId: string; title: string; chapterCount: number }>;
        assert.equal(books.length, 1);
        assert.equal(books[0]!.chapterCount, 2);
        assert.ok(books[0]!.bookId);
        assert.equal(books[0]!.bookId.includes(OTHER), false);

        const index = await fetch(`${origin}/api/tianjiang/tapcanvas/assets/books/${encodeURIComponent(books[0]!.bookId)}/index?projectId=${PERSONAL}`);
        assert.equal(index.status, 200);
        const body = await index.json() as {
          bookId: string;
          projectId: string;
          chapterCount: number;
          chapters: Array<{ chapter: number; title: string; startOffset: number; endOffset: number; length: number }>;
        };
        assert.equal(body.projectId, PERSONAL);
        assert.equal(body.chapterCount, 2);
        assert.equal(body.chapters[0]?.title, "第一章 海边");
        assert.equal(body.chapters[1]?.title, "第二章 夜雨");
        assert.ok(body.chapters[0]!.length > 0);
        assert.ok(body.chapters[0]!.endOffset >= body.chapters[0]!.startOffset);

        const crossed = await fetch(`${origin}/api/tianjiang/tapcanvas/assets/books/${encodeURIComponent(books[0]!.bookId)}/index?projectId=${OTHER}`);
        assert.ok(crossed.status >= 400, "不得跨项目读取章节");
        const crossedBody = await jsonOf(crossed);
        assert.notEqual(JSON.stringify(crossedBody), "[]");

        const illegal = await fetch(`${origin}/api/tianjiang/tapcanvas/assets/books/${encodeURIComponent("not-a-book")}/index?projectId=${PERSONAL}`);
        assert.ok(illegal.status >= 400);
      });

      await runWithProjectStorage(PERSONAL, async () => {
        await db.raw("DROP TABLE o_novel");
      });
      await withCompat(async (origin) => {
        const failed = await fetch(`${origin}/api/tianjiang/tapcanvas/assets/books?projectId=${PERSONAL}`);
        assert.notEqual(failed.status, 200);
        const payload = await jsonOf(failed);
        assert.notEqual(JSON.stringify(payload), "[]");
      });
    } finally {
      restore();
      await pauseGenerationTaskRecovery().catch(() => undefined);
      await releaseProjectDatabaseLease(PERSONAL, "ui").catch(() => undefined);
      await releaseProjectDatabaseLease(OTHER, "ui").catch(() => undefined);
    }
  });
});

test("AI 执行诊断：空项目合法空结果而不是 404；只映射本项目真实任务，不伪造供应商进度", async () => {
  await runWithTemporaryAccount("tc-b19-diag", async () => {
    const restore = stubCatalog([
      catalogItem({ projectUuid: PERSONAL, name: "诊断画布" }),
      catalogItem({ projectUuid: OTHER, name: "别人的画布", ownerUserId: 8801, myRole: "viewer" }),
    ]);
    try {
      await initializeCanvasWorkspace(PERSONAL);
      await initializeCanvasWorkspace(OTHER);
      await withCompat(async (origin) => {
        const empty = await fetch(`${origin}/api/tianjiang/tapcanvas/agents/diagnostics?projectId=${PERSONAL}`);
        assert.equal(empty.status, 200, "无执行记录时不得 404");
        const emptyBody = await empty.json() as {
          traces: unknown[];
          spans: unknown[];
          publicChatRuns: unknown[];
          executionHealth: { totalTraceCount: number; status: string };
          metrics: { traceCount: number; totalTokens: number };
        };
        assert.deepEqual(emptyBody.traces, []);
        assert.deepEqual(emptyBody.spans, []);
        assert.deepEqual(emptyBody.publicChatRuns, []);
        assert.equal(emptyBody.executionHealth.totalTraceCount, 0);
        assert.equal(emptyBody.metrics.traceCount, 0);
        assert.equal(emptyBody.metrics.totalTokens, 0);
      });

      await runWithProjectStorage(PERSONAL, async () => {
        await db("canvas_execution_confirmations").insert({
          confirmation_uuid: "conf-b19",
          origin_device_uuid: "dev-1",
          document_revision: 1,
          request_digest: "digest-b19",
          capability_registry_version: "1",
          model_catalog_version: "1",
          immutable_items_json: "[]",
          ordered_request_digests_json: "[]",
          first_batch_uuid: "batch-b19",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          consumed_at: new Date().toISOString(),
        });
        await db("canvas_execution_batches").insert({
          batch_uuid: "batch-b19",
          confirmation_uuid: "conf-b19",
          client_request_id: "client-b19",
          request_digest: "digest-b19",
          origin_device_uuid: "dev-1",
          state: "accepted",
          response_json: "{}",
          created_by: "canvas-owner",
          created_at: new Date().toISOString(),
        });
        await db("canvas_node_runs").insert({
          run_uuid: "run-b19-personal",
          batch_uuid: "batch-b19",
          node_uuid: "node-b19",
          capability_id: "image",
          run_generation: 1,
          normalized_parameters_json: "{}",
          task_uuid: null,
          attempt: 0,
          state: "waiting_for_origin_device",
          failure_text: null,
          created_at: "2026-09-02T00:00:00.000Z",
          updated_at: "2026-09-02T00:05:00.000Z",
        });
      });

      await withCompat(async (origin) => {
        const mine = await fetch(`${origin}/api/tianjiang/tapcanvas/agents/diagnostics?projectId=${PERSONAL}`);
        assert.equal(mine.status, 200);
        const body = await mine.json() as {
          projectId: string | null;
          spans: Array<{
            id: string;
            status: string;
            startedAt: string;
            createdAt: string;
            durationMs: number | null;
            totalTokens: number;
            attributes: Record<string, unknown>;
          }>;
          traces: Array<{ id?: string; startedAt?: string; updatedAt?: string; status?: string }>;
          executionHealth: { runningTraceCount: number; waitingAsyncTraceCount: number };
          metrics: { traceCount: number; persistedCount: number };
        };
        assert.equal(body.projectId, PERSONAL);
        assert.ok(body.spans.some((span) => span.id === "run-b19-personal" || JSON.stringify(span).includes("run-b19-personal")));
        for (const span of body.spans) {
          assert.equal(span.startedAt, "2026-09-02T00:00:00.000Z", "开始时间必须来自真实 created_at");
          assert.equal(span.createdAt, "2026-09-02T00:00:00.000Z");
          assert.equal(span.status, "suspended", "等待原设备执行不能伪装成正在运行");
          assert.equal(span.totalTokens, 0, "不得伪造 token");
          assert.equal(span.durationMs, null, "不得伪造耗时");
          assert.equal(span.attributes.progress, undefined, "不得伪造供应商进度");
        }
        assert.equal(body.traces[0]?.startedAt, "2026-09-02T00:00:00.000Z");
        assert.equal(body.traces[0]?.updatedAt, "2026-09-02T00:05:00.000Z");
        assert.equal(body.executionHealth.runningTraceCount, 0);
        assert.equal(body.executionHealth.waitingAsyncTraceCount, 1);
        assert.equal(body.metrics.traceCount, 1);
        assert.equal(body.metrics.persistedCount, 1);

        const foreign = await fetch(`${origin}/api/tianjiang/tapcanvas/agents/diagnostics?projectId=${OTHER}`);
        assert.notEqual(foreign.status, 200);
      });
    } finally {
      restore();
      await pauseGenerationTaskRecovery().catch(() => undefined);
      await releaseProjectDatabaseLease(PERSONAL, "ui").catch(() => undefined);
      await releaseProjectDatabaseLease(OTHER, "ui").catch(() => undefined);
    }
  });
});
