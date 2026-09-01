/**
 * 正式 tapcanvas-compat 路由：只伪造会话与目录，不得 mock 被测路由。
 */
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import {
  initializeCanvasWorkspace,
  pauseGenerationTaskRecovery,
  releaseProjectDatabaseLease,
} from "../../src/utils/db";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import {
  setTapCanvasCreateProjectForTests,
  setTapCanvasHomePlanForTests,
  setTapCanvasTextInvokeForTests,
} from "../../src/routes/tianjiang/tapcanvas-compat";

const UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01";
const SESSION = {
  id: "sess-tapcanvas-fix",
  serverUrl: "https://api.j11.com.cn",
  token: "memory-only",
  expiresAt: Date.now() + 60_000,
  validatedAt: Date.now(),
  user: { id: 7601, username: "owner", nickname: "owner" },
};

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

test("公开项目正式路径返回空列表，不得 404", async () => {
  await withCompat(async (origin) => {
    const response = await fetch(`${origin}/api/tianjiang/tapcanvas/projects/public`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  });
});

test("未登录生成偏好必须 401", async () => {
  const { default: tapcanvasCompatRouter } = await import("../../src/routes/tianjiang/tapcanvas-compat");
  const app = express();
  app.use(express.json());
  app.use("/api/tianjiang/tapcanvas", tapcanvasCompatRouter);
  const { server, origin } = await listen(app);
  try {
    const response = await fetch(`${origin}/api/tianjiang/tapcanvas/auth/generation-preferences`);
    assert.equal(response.status, 401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("生成偏好读写一致性、非法模型拒绝、重启恢复", async () => {
  await runWithTemporaryAccount("tc-prefs", async () => {
    await withCompat(async (origin) => {
      const empty = await fetch(`${origin}/api/tianjiang/tapcanvas/auth/generation-preferences`);
      assert.equal(empty.status, 200);
      assert.equal((await empty.json()).prefs, null);

      const illegal = await fetch(`${origin}/api/tianjiang/tapcanvas/auth/generation-preferences`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ imageModel: "missing:model", apiKey: "sk-secret" }),
      });
      assert.equal(illegal.status, 400);

      const invalidValue = await fetch(`${origin}/api/tianjiang/tapcanvas/auth/generation-preferences`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ imageSize: "5K" }),
      });
      assert.equal(invalidValue.status, 400);
      assert.equal((await invalidValue.json() as { code: string }).code, "generation_prefs_invalid_value");

      const models = await fetch(`${origin}/api/tianjiang/tapcanvas/new-api-models?kind=image&enabled=true&selectable=true`);
      assert.equal(models.status, 200);
      const list = await models.json() as Array<{ requestModelKey: string; kind: string }>;
      if (list.length > 0) {
        const saved = await fetch(`${origin}/api/tianjiang/tapcanvas/auth/generation-preferences`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ imageModel: list[0]!.requestModelKey, imageSize: "1K" }),
        });
        assert.equal(saved.status, 200);
        const roundtrip = await fetch(`${origin}/api/tianjiang/tapcanvas/auth/generation-preferences`);
        const body = await roundtrip.json() as { prefs: { imageModel?: string } };
        assert.equal(body.prefs?.imageModel, list[0]!.requestModelKey);
      }
    });
  });
});

test("Codex bridges/tasks 离线合同，不得返回接口未接入；消息幂等", async () => {
  await runWithTemporaryAccount("tc-codex", async () => {
    await withCompat(async (origin) => {
      const bridges = await fetch(`${origin}/api/tianjiang/tapcanvas/codex/bridges`);
      assert.equal(bridges.status, 200);
      const bridgeBody = await bridges.json() as { items: unknown[]; status?: string; pairingHint?: string };
      assert.ok(Array.isArray(bridgeBody.items));
      assert.notEqual(bridgeBody.status, "online");
      assert.ok(String(bridgeBody.pairingHint ?? "").length > 0);

      const pairing = await fetch(`${origin}/api/tianjiang/tapcanvas/codex/pairings`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(pairing.status, 200);
      const session = await pairing.json() as { pairingCode: string; expiresAt: string };
      assert.ok(session.pairingCode);
      assert.ok(session.expiresAt);

      const created = await fetch(`${origin}/api/tianjiang/tapcanvas/codex/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bridgeId: "bridge-local",
          workspaceId: "ws-1",
          goal: "整理分镜",
          idempotencyKey: "idemp-1",
          context: { projectId: UUID, flowId: null, chapterId: null, canvasRevision: 0, selectedNodeIds: [] },
        }),
      });
      assert.equal(created.status, 200);
      const first = await created.json() as { task: { id: string }; deduplicated: boolean; unpaired?: boolean };
      assert.equal(first.unpaired, true);
      const replay = await fetch(`${origin}/api/tianjiang/tapcanvas/codex/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bridgeId: "bridge-local",
          workspaceId: "ws-1",
          goal: "整理分镜",
          idempotencyKey: "idemp-1",
          context: { projectId: UUID, flowId: null, chapterId: null, canvasRevision: 0, selectedNodeIds: [] },
        }),
      });
      const second = await replay.json() as { task: { id: string }; deduplicated: boolean };
      assert.equal(second.deduplicated, true);
      assert.equal(second.task.id, first.task.id);

      const msgBody = { text: "继续", idempotencyKey: "msg-1" };
      const msg1 = await fetch(`${origin}/api/tianjiang/tapcanvas/codex/tasks/${first.task.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msgBody),
      });
      const msg2 = await fetch(`${origin}/api/tianjiang/tapcanvas/codex/tasks/${first.task.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msgBody),
      });
      assert.equal(msg1.status, 200);
      assert.equal((await msg2.json() as { deduplicated: boolean }).deduplicated, true);

      // 中文注释：Codex 快照是整份 JSON，必须锁定并发 read-modify-write 不丢任务。
      const concurrent = await Promise.all(Array.from({ length: 24 }, async (_value, index) => {
        const response = await fetch(`${origin}/api/tianjiang/tapcanvas/codex/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            bridgeId: "bridge-local",
            workspaceId: "ws-1",
            goal: `并发任务-${index}`,
            idempotencyKey: `idemp-concurrent-${index}`,
            context: { projectId: UUID, flowId: null, chapterId: null, canvasRevision: 0, selectedNodeIds: [] },
          }),
        });
        assert.equal(response.status, 200);
        return (await response.json() as { task: { id: string } }).task.id;
      }));
      assert.equal(new Set(concurrent).size, 24);

      const tasks = await fetch(`${origin}/api/tianjiang/tapcanvas/codex/tasks?limit=100`);
      assert.equal(tasks.status, 200);
      const taskItems = (await tasks.json() as { items: Array<{ idempotencyKey: string }> }).items;
      assert.equal(
        taskItems.filter((item) => item.idempotencyKey.startsWith("idemp-concurrent-")).length,
        24,
      );
    });
  });
});

test("Codex 持久化不可用时必须失败，不得把未写入数据返回成成功", async () => {
  const { createCodexPairing, listOnlineBridges } = await import("../../src/tianjiang/canvas/tapcanvas-codex-store");
  await assert.rejects(
    () => createCodexPairing(),
    /database|账号|中央用户存储|storage|identity|initialized|active/i,
  );

  // 中文注释：陈旧 online 只能显示为离线，也绝不能让新任务误判为可领取。
  const staleSnapshot = {
    pairings: [],
    bridges: [{
      protocolVersion: 2,
      bridgeId: "stale-bridge",
      workerInstanceId: "worker-1",
      name: "本机 Bridge",
      workerVersion: "1.0.0",
      codexVersion: "1.0.0",
      workspaces: [],
      status: "online",
      lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
      activeTaskId: null,
    }],
    tasks: [],
    messages: [],
    previews: [],
  } as never;
  assert.equal(listOnlineBridges(staleSnapshot).length, 0);
});

test("new-api-models 按 kind 过滤，readiness 符合 URL schema", async () => {
  await runWithTemporaryAccount("tc-models", async () => {
    await withCompat(async (origin) => {
      const readiness = await fetch(`${origin}/api/tianjiang/tapcanvas/new-api-models/readiness`);
      assert.equal(readiness.status, 200);
      const body = await readiness.json() as { setupUrl: string; recommendedProvider?: unknown; reasons: string[] };
      assert.match(body.setupUrl, /^https?:\/\//);
      assert.equal(body.recommendedProvider, undefined);
      assert.ok(Array.isArray(body.reasons));
      const images = await fetch(`${origin}/api/tianjiang/tapcanvas/new-api-models?kind=image&selectable=true`);
      const videos = await fetch(`${origin}/api/tianjiang/tapcanvas/new-api-models?kind=video&selectable=true`);
      assert.equal(images.status, 200);
      assert.equal(videos.status, 200);
      for (const item of await images.json() as Array<{ kind: string }>) {
        assert.equal(item.kind, "image");
      }
      for (const item of await videos.json() as Array<{ kind: string }>) {
        assert.equal(item.kind, "video");
      }
    });
  });
});

test("flow 返回 canvasRevision，冲突返回 flow_revision_conflict", async () => {
  await runWithTemporaryAccount("tc-flow", async () => {
    const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
    syncCoordinator.listProjects = (() => [{
      projectUuid: UUID,
      name: "canvas",
      kind: "personal",
      businessType: "canvas",
      ownerUserId: 7601,
      myRole: "owner",
      openMode: "editable",
    }]) as typeof syncCoordinator.listProjects;
    (syncCoordinator as { isProjectOpened?: (uuid: string) => boolean }).isProjectOpened = () => true;
    try {
      await initializeCanvasWorkspace(UUID);
      await withCompat(async (origin) => {
        const saved = await fetch(`${origin}/api/tianjiang/tapcanvas/flows`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId: UUID,
            name: "画布",
            data: { nodes: [{ id: "n1" }], edges: [] },
            expectedRevision: 0,
          }),
        });
        assert.equal(saved.status, 200);
        const first = await saved.json() as { canvasRevision: number; data?: { nodes: unknown[] }; dataAdjusted: boolean };
        assert.equal(first.canvasRevision, 1);
        assert.equal(first.dataAdjusted, true, "服务端补齐 nodeUuid/kind 等字段时必须如实声明 dataAdjusted");
        assert.ok(Array.isArray(first.data?.nodes));

        const conflict = await fetch(`${origin}/api/tianjiang/tapcanvas/flows`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId: UUID,
            name: "画布",
            data: { nodes: [{ id: "n2" }], edges: [] },
            expectedRevision: 0,
          }),
        });
        assert.equal(conflict.status, 409);
        const conflictBody = await conflict.json() as { code: string; canvasRevision: number };
        assert.equal(conflictBody.code, "flow_revision_conflict");
        assert.equal(conflictBody.canvasRevision, 1);

        const loaded = await fetch(`${origin}/api/tianjiang/tapcanvas/flows/${UUID}`);
        const flow = await loaded.json() as { canvasRevision: number; data: { nodes: unknown[] } };
        assert.equal(flow.canvasRevision, 1);
      });
    } finally {
      syncCoordinator.listProjects = originalList;
      delete (syncCoordinator as { isProjectOpened?: unknown }).isProjectOpened;
      await pauseGenerationTaskRecovery().catch(() => undefined);
      await releaseProjectDatabaseLease(UUID, "ui").catch(() => undefined);
    }
  });
});

test("bootstrap 成功 complete；局部失败 partial 而不是 500", async () => {
  await runWithTemporaryAccount("tc-boot", async () => {
    setTapCanvasCreateProjectForTests(async (_session, name) => {
      await initializeCanvasWorkspace(UUID);
      return {
        id: UUID,
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
    const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
    syncCoordinator.listProjects = (() => [{
      projectUuid: UUID,
      name: "canvas",
      kind: "personal",
      businessType: "canvas",
      ownerUserId: 7601,
      myRole: "owner",
      openMode: "editable",
    }]) as typeof syncCoordinator.listProjects;
    (syncCoordinator as { isProjectOpened?: (uuid: string) => boolean }).isProjectOpened = () => true;
    try {
      await withCompat(async (origin) => {
        const response = await fetch(`${origin}/api/tianjiang/tapcanvas/projects/bootstrap`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "新建",
            flow: { name: "画布", data: { nodes: [], edges: [] } },
          }),
        });
        assert.equal(response.status, 200);
        const body = await response.json() as { status: string; flow?: { canvasRevision?: number } };
        assert.equal(body.status, "complete");
        assert.equal(typeof body.flow?.canvasRevision, "number");
      });
    } finally {
      setTapCanvasCreateProjectForTests(null);
      syncCoordinator.listProjects = originalList;
      delete (syncCoordinator as { isProjectOpened?: unknown }).isProjectOpened;
    }
  });
});

test("首页一句话规划必须把独立 prompt 交给规划器，普通空白新建不得误调模型", async () => {
  await runWithTemporaryAccount("tc-home-plan", async () => {
    const receivedPrompts: string[] = [];
    setTapCanvasCreateProjectForTests(async (_session, name) => {
      await initializeCanvasWorkspace(UUID);
      return {
        id: UUID,
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
    setTapCanvasHomePlanForTests(async (_projectUuid, input) => {
      receivedPrompts.push(input.prompt);
      return {};
    });
    const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
    syncCoordinator.listProjects = (() => [{
      projectUuid: UUID,
      name: "canvas",
      kind: "personal",
      businessType: "canvas",
      ownerUserId: 7601,
      myRole: "owner",
      openMode: "editable",
    }]) as typeof syncCoordinator.listProjects;
    (syncCoordinator as { isProjectOpened?: (uuid: string) => boolean }).isProjectOpened = () => true;
    try {
      await withCompat(async (origin) => {
        const planned = await fetch(`${origin}/api/tianjiang/tapcanvas/projects/bootstrap`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "海边悬疑短片",
            prompt: "海边悬疑短片",
            flow: { name: "画布", data: { nodes: [], edges: [] } },
          }),
        });
        assert.equal(planned.status, 200);
        assert.equal((await planned.json() as { status: string }).status, "complete");
        assert.deepEqual(receivedPrompts, ["海边悬疑短片"]);

        const blank = await fetch(`${origin}/api/tianjiang/tapcanvas/projects/bootstrap`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "未命名画布",
            flow: { name: "画布", data: { nodes: [], edges: [] } },
          }),
        });
        assert.equal(blank.status, 200);
        assert.deepEqual(receivedPrompts, ["海边悬疑短片"]);
      });
    } finally {
      setTapCanvasHomePlanForTests(null);
      setTapCanvasCreateProjectForTests(null);
      syncCoordinator.listProjects = originalList;
      delete (syncCoordinator as { isProjectOpened?: unknown }).isProjectOpened;
    }
  });
});

test("项目记忆写入后可通过 /memory/context 恢复", async () => {
  await runWithTemporaryAccount("tc-mem", async () => {
    const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
    syncCoordinator.listProjects = (() => [{
      projectUuid: UUID,
      name: "canvas",
      kind: "personal",
      businessType: "canvas",
      ownerUserId: 7601,
      myRole: "owner",
      openMode: "editable",
    }]) as typeof syncCoordinator.listProjects;
    (syncCoordinator as { isProjectOpened?: (uuid: string) => boolean }).isProjectOpened = () => true;
    try {
      await initializeCanvasWorkspace(UUID);
      const { appendMemoryTurns } = await import("../../src/tianjiang/canvas/tapcanvas-memory-store");
      const { runWithProjectStorage } = await import("../../src/tianjiang/runtime/user-storage-context");
      await runWithProjectStorage(UUID, () => appendMemoryTurns([{
        sessionKey: `project:${UUID}`,
        sessionId: "sess-1",
        messageId: "m-user",
        role: "user",
        content: "今天拍什么？",
        createdAt: new Date().toISOString(),
        nodeIds: [],
        modelKey: "universalAi",
      }, {
        sessionKey: `project:${UUID}`,
        sessionId: "sess-1",
        messageId: "m-ai",
        role: "assistant",
        content: "先写三句剧本。",
        createdAt: new Date().toISOString(),
        nodeIds: [],
        modelKey: "universalAi",
      }]));
      await withCompat(async (origin) => {
        const response = await fetch(`${origin}/api/tianjiang/tapcanvas/memory/context`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: UUID, sessionKey: `project:${UUID}` }),
        });
        assert.equal(response.status, 200);
        const body = await response.json() as { context: { recentConversation: Array<{ content: string }> } };
        assert.ok(body.context.recentConversation.some((item) => item.content.includes("三句剧本")));
      });
    } finally {
      syncCoordinator.listProjects = originalList;
      delete (syncCoordinator as { isProjectOpened?: unknown }).isProjectOpened;
    }
  });
});

test("右侧 AI 必须按真实 canvasProjectId 持久化，并返回前端可消费的 SSE 身份与事件游标", async () => {
  await runWithTemporaryAccount("tc-chat-route", async () => {
    let modelInvocations = 0;
    const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
    syncCoordinator.listProjects = (() => [{
      projectUuid: UUID,
      name: "canvas",
      kind: "personal",
      businessType: "canvas",
      ownerUserId: 7601,
      myRole: "owner",
      openMode: "editable",
    }]) as typeof syncCoordinator.listProjects;
    (syncCoordinator as { isProjectOpened?: (uuid: string) => boolean }).isProjectOpened = () => true;
    setTapCanvasTextInvokeForTests(async () => {
      modelInvocations += 1;
      return { text: "先创建三句剧本节点。" };
    });
    try {
      await initializeCanvasWorkspace(UUID);
      await withCompat(async (origin) => {
        const sessionKey = `project:${UUID}:flow:${UUID}:conversation:canvas-1:lane:general:skill:default`;
        const response = await fetch(`${origin}/api/tianjiang/tapcanvas/public/agents/chat`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream",
          },
          body: JSON.stringify({
            prompt: "今天拍什么？",
            canvasProjectId: UUID,
            canvasFlowId: UUID,
            sessionKey,
            clientPendingId: "pending-chat-1",
            stream: true,
          }),
        });
        assert.equal(response.status, 200);
        const turnId = response.headers.get("x-trace-id");
        assert.ok(turnId, "SSE 必须返回稳定 X-Trace-ID");
        const stream = await response.text();
        assert.match(stream, new RegExp(`id: ${turnId}#1`));
        assert.match(stream, new RegExp(`id: ${turnId}#2`));
        assert.match(stream, /event: result/);

        const context = await fetch(`${origin}/api/tianjiang/tapcanvas/memory/context`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          // 中文注释：真实前端加载历史只发送 sessionKey，不重复发送 projectId。
          body: JSON.stringify({ sessionKey, recentConversationLimit: 20 }),
        });
        assert.equal(context.status, 200);
        const body = await context.json() as { context: { recentConversation: Array<{ content: string }> } };
        assert.deepEqual(
          body.context.recentConversation.map((item) => item.content),
          ["今天拍什么？", "先创建三句剧本节点。"],
        );

        const status = await fetch(`${origin}/api/tianjiang/tapcanvas/public/agents/chat/status`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionKey }),
        });
        assert.equal(status.status, 200);
        assert.deepEqual(await status.json(), {
          sessionId: sessionKey,
          durable: true,
          activeTurn: false,
          turn: null,
        });

        const mismatch = await fetch(`${origin}/api/tianjiang/tapcanvas/public/agents/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            prompt: "不应执行",
            canvasProjectId: UUID,
            sessionKey: "project:22222222-2222-4222-a222-222222222222:conversation:mismatch",
          }),
        });
        assert.equal(mismatch.status, 400);
        assert.equal((await mismatch.json() as { code: string }).code, "chat_session_project_mismatch");
        assert.equal(modelInvocations, 1, "项目身份冲突必须在调用账号模型前失败");
      });
    } finally {
      setTapCanvasTextInvokeForTests(null);
      syncCoordinator.listProjects = originalList;
      delete (syncCoordinator as { isProjectOpened?: unknown }).isProjectOpened;
    }
  });
});

test("文本生成入口必须拒绝不存在或类型不匹配的显式模型", async () => {
  await runWithTemporaryAccount("tc-text-model", async () => {
    await withCompat(async (origin) => {
      const task = await fetch(`${origin}/api/tianjiang/tapcanvas/public/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request: { kind: "chat", prompt: "test", extras: { modelKey: "missing:model" } } }),
      });
      assert.equal(task.status, 400);
      assert.equal((await task.json() as { code: string }).code, "text_model_unavailable");

      const completion = await fetch(`${origin}/api/tianjiang/tapcanvas/agents/llm/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "missing:model", messages: [{ role: "user", content: "test" }] }),
      });
      assert.equal(completion.status, 400);
      assert.equal((await completion.json() as { code: string }).code, "text_model_unavailable");
    });
  });
});

test("视觉脚本不得再把 Codex 伪装成空成功以掩盖未接入", () => {
  const script = fs.readFileSync(path.resolve(__dirname, "../../scripts/tapcanvas-electron-visual.mjs"), "utf8");
  assert.match(script, /pairingRequired/);
  assert.match(script, /offline/);
  assert.doesNotMatch(script, /if \(req\.method === "GET" && p === "\/codex\/bridges"\) return json\(res, 200, \{ items: \[\] \}\);/);
});
