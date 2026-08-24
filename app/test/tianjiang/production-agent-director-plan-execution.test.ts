/**
 * 导演规划执行生命周期：流结束后必须先校验、再提交，记忆失败不得回滚已提交产物。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { finalizeProductionDirectorPlanOutput } from "../../src/agents/productionAgent/production-agent-execution";

class FakeMsg {
  id = "production-msg-1";
  datetime = new Date().toISOString();
  status: "pending" | "complete" | "error" | "stop" = "pending";
  errorCode?: string;
  errorStage?: string;
  errorMessage?: string;

  complete() {
    this.status = "complete";
  }

  error(message?: string, meta?: { errorCode?: string; stage?: string }) {
    this.status = "error";
    this.errorMessage = message;
    this.errorCode = meta?.errorCode;
    this.errorStage = meta?.stage;
  }
}

function collected(fullResponse: string, finishReason: string | null = "stop") {
  return {
    fullResponse,
    toolCallCount: 0,
    stepCount: 1,
    streamFinishReason: finishReason,
    aborted: false,
  };
}

test("完整导演规划：事务提交后通知刷新，memory 失败仍 complete", async () => {
  const msg = new FakeMsg();
  const order: string[] = [];
  const socketEvents: Array<{ event: string; payload: any }> = [];

  const result = await finalizeProductionDirectorPlanOutput({
    collected: collected("前言<scriptPlan>第一场；第二场；第三场。</scriptPlan>结束"),
    subMsg: msg as any,
    projectId: 81001,
    episodesId: 81101,
    memory: {
      async add(_key: string, content: string) {
        order.push(`memory:${content}`);
        throw new Error("summary provider failed");
      },
    } as any,
    memoryKey: "assistant:execution",
    name: "执行导演",
    commitArtifact: async (input) => {
      order.push(`commit:${input.content}`);
    },
    onArtifactCommitted: () => {
      order.push("mark");
    },
    socket: {
      emit(event: string, payload: unknown) {
        socketEvents.push({ event, payload });
        order.push(`socket:${event}`);
      },
    } as any,
  });

  assert.equal(result.artifactCommitted, true);
  assert.equal(result.memoryAuxFailed, true);
  assert.equal(msg.status, "complete");
  assert.deepEqual(order, [
    "commit:第一场；第二场；第三场。",
    "mark",
    "socket:artifactCommitted",
    "memory:第一场；第二场；第三场。",
  ]);
  assert.deepEqual(socketEvents[0]?.payload, {
    stage: "directorPlan",
    messageId: msg.id,
    projectId: 81001,
    episodesId: 81101,
  });
});

test("不完整、截断或提交失败：不得记忆成功，不得 complete", async (t) => {
  for (const scenario of [
    {
      name: "只有完成说明",
      stream: collected("导演规划已完成，可交付下游"),
      code: "PRODUCTION_AGENT_OUTPUT_INCOMPLETE",
    },
    {
      name: "长度截断",
      stream: collected("<scriptPlan>只有一半", "length"),
      code: "PRODUCTION_AGENT_OUTPUT_TRUNCATED",
    },
  ]) {
    await t.test(scenario.name, async () => {
      const msg = new FakeMsg();
      let commitCalls = 0;
      let memoryCalls = 0;
      await assert.rejects(
        finalizeProductionDirectorPlanOutput({
          collected: scenario.stream,
          subMsg: msg as any,
          projectId: 81001,
          episodesId: 81101,
          memory: { async add() { memoryCalls += 1; } } as any,
          memoryKey: "assistant:execution",
          name: "执行导演",
          commitArtifact: async () => { commitCalls += 1; },
        }),
        (error: any) => error?.code === scenario.code,
      );
      assert.equal(commitCalls, 0);
      assert.equal(memoryCalls, 0);
      assert.equal(msg.status, "error");
      assert.equal(msg.errorCode, scenario.code);
      assert.equal(msg.errorStage, "directorPlan");
    });
  }

  await t.test("事务提交失败", async () => {
    const msg = new FakeMsg();
    let memoryCalls = 0;
    await assert.rejects(
      finalizeProductionDirectorPlanOutput({
        collected: collected("<scriptPlan>完整但数据库失败</scriptPlan>"),
        subMsg: msg as any,
        projectId: 81001,
        episodesId: 81101,
        memory: { async add() { memoryCalls += 1; } } as any,
        memoryKey: "assistant:execution",
        name: "执行导演",
        commitArtifact: async () => {
          throw new Error("SQLITE_BUSY");
        },
      }),
      (error: any) =>
        error?.code === "PRODUCTION_AGENT_OUTPUT_INCOMPLETE" &&
        /保存导演规划失败/.test(error?.message ?? ""),
    );
    assert.equal(memoryCalls, 0);
    assert.equal(msg.status, "error");
    assert.equal(msg.errorCode, "PRODUCTION_AGENT_OUTPUT_INCOMPLETE");
  });
});
