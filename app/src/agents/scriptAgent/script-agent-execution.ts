/**
 * 剧本 Agent 执行流生命周期：流结束 ≠ 业务成功；
 * 校验通过 → 项目库事务提交 → memory.add / complete / artifactCommitted。
 */
import type Memory from "@/utils/agent/memory";
import type ResTool from "@/socket/resTool";
import type { Socket } from "socket.io";
import {
  buildPartialCommitFail,
  buildScriptAgentOutputLogFields,
  ScriptAgentOutputError,
  type ScriptAgentExecutionStage,
  type ScriptAgentOutputFail,
  validateScriptAgentOutput,
} from "./script-agent-output-contract";
import { commitScriptAgentArtifact } from "./script-agent-plan-commit";

/** 已有项目提交后的失败 → PARTIAL_COMMIT（导出供测试与 route） */
export function toPartialCommitFail(
  stage: ScriptAgentExecutionStage,
  responseChars = 0,
  finishReason: string | null = null,
): ScriptAgentOutputFail {
  return buildPartialCommitFail(stage, responseChars, finishReason);
}

export interface CollectedExecutionStream {
  fullResponse: string;
  toolCallCount: number;
  stepCount: number;
  streamFinishReason?: string | null;
  aborted: boolean;
}

export interface ConsumeExecutionOptions {
  /** 为 true 时流结束后不 msg.complete，留给产物校验 */
  deferComplete?: boolean;
  abortSignal?: AbortSignal;
}

type Msg = ReturnType<ResTool["newMessage"]>;

/** 识别 AI SDK fullStream tool-error / 已抛出的 ScriptAgentOutputError */
export function isScriptAgentToolStreamError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; code?: string };
  if (err instanceof ScriptAgentOutputError) return true;
  if (e.name === "ScriptAgentOutputError") return true;
  if (typeof e.code === "string" && e.code.startsWith("SCRIPT_AGENT_OUTPUT")) return true;
  if (e.code === "SCRIPT_AGENT_ABORTED") return true;
  return false;
}

function coerceScriptAgentOutputError(err: unknown): ScriptAgentOutputError | null {
  if (err instanceof ScriptAgentOutputError) return err;
  if (!err || typeof err !== "object") return null;
  const e = err as {
    name?: string;
    code?: string;
    stage?: ScriptAgentExecutionStage;
    message?: string;
    finishReason?: string | null;
    responseChars?: number;
  };
  if (!isScriptAgentToolStreamError(err)) return null;
  const stage = (e.stage ?? "storySkeleton") as ScriptAgentExecutionStage;
  const code = (e.code ?? "SCRIPT_AGENT_OUTPUT_INCOMPLETE") as ScriptAgentOutputFail["code"];
  const fail: ScriptAgentOutputFail = {
    ok: false,
    stage,
    code,
    message:
      typeof e.message === "string" && /[\u3400-\u9fff]/.test(e.message)
        ? e.message
        : "执行层输出不完整，工作区未修改，请重试",
    artifactPresent: false,
    responseChars: e.responseChars ?? 0,
    finishReason: e.finishReason ?? null,
  };
  return new ScriptAgentOutputError(fail);
}

/**
 * 消费 fullStream：收集文本与元数据。
 * 识别 tool-error；若为 ScriptAgentOutputError 立即终止并传播，禁止继续模型步。
 * deferComplete 时仅 complete 文本内容块，消息状态待校验后设定。
 */
export async function consumeFullStreamForExecution(
  fullStream: AsyncIterable<any>,
  initialMsg: Msg,
  options: ConsumeExecutionOptions = {},
  syncMsg?: () => Msg,
): Promise<CollectedExecutionStream> {
  let msg = initialMsg;
  let text = msg.text();
  let thinking: ReturnType<Msg["thinking"]> | null = null;
  let thinkTime = 0;
  let fullResponse = "";
  let toolCallCount = 0;
  let stepCount = 0;
  let streamFinishReason: string | null | undefined;
  let aborted = false;

  const onAbort = () => {
    aborted = true;
  };
  options.abortSignal?.addEventListener("abort", onAbort, { once: true });
  if (options.abortSignal?.aborted) aborted = true;

  try {
    for await (const chunk of fullStream) {
      if (options.abortSignal?.aborted) {
        aborted = true;
        break;
      }
      if (syncMsg) {
        const newMsg = syncMsg();
        if (newMsg !== msg) {
          msg = newMsg;
          text = msg.text();
        }
      }
      if (chunk.type === "reasoning-start") {
        thinkTime = Date.now();
        thinking = msg.thinking("思考中...");
      } else if (chunk.type === "reasoning-delta") {
        thinking?.append(chunk.text);
      } else if (chunk.type === "reasoning-end") {
        thinkTime = Date.now() - thinkTime;
        thinking?.updateTitle(`思考完毕（${(thinkTime / 1000).toFixed(1)} 秒）`);
        thinking?.complete();
        thinking = null;
      } else if (chunk.type === "text-delta") {
        text.append(chunk.text);
        fullResponse += chunk.text;
      } else if (chunk.type === "tool-call" || chunk.type === "tool-call-streaming-start") {
        toolCallCount += 1;
      } else if (chunk.type === "finish-step" || chunk.type === "step-finish") {
        stepCount += 1;
      } else if (chunk.type === "finish") {
        streamFinishReason = chunk.finishReason ?? streamFinishReason;
      } else if (chunk.type === "tool-error") {
        // AI SDK 6：工具执行失败以 tool-error 进入 fullStream
        const coerced = coerceScriptAgentOutputError(chunk.error);
        if (coerced) {
          thinking?.complete();
          // 子消息通常已 error；此处直接传播，禁止进入下一次模型调用
          throw coerced;
        }
        throw chunk.error instanceof Error ? chunk.error : new Error(String(chunk.error ?? "tool-error"));
      } else if (chunk.type === "error") {
        const coerced = coerceScriptAgentOutputError(chunk.error);
        if (coerced) throw coerced;
        throw chunk.error;
      }
    }

    if (aborted || options.abortSignal?.aborted) {
      thinking?.complete();
      text.complete();
      msg.stop();
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }

    text.complete();
    if (!options.deferComplete) {
      msg.complete();
    }
  } catch (err: any) {
    thinking?.complete();
    if (err instanceof ScriptAgentOutputError || isScriptAgentToolStreamError(err)) {
      const coerced = coerceScriptAgentOutputError(err) ?? err;
      throw coerced;
    }
    if (err?.name === "AbortError" || options.abortSignal?.aborted) {
      try {
        msg.stop();
      } catch {
        // ignore
      }
      const abortErr = new Error("aborted");
      abortErr.name = "AbortError";
      throw abortErr;
    }
    // 不把供应商英文异常直接当正文；仅标记 error
    text.error();
    msg.error("执行失败，请重试");
    throw err;
  } finally {
    options.abortSignal?.removeEventListener("abort", onAbort);
  }

  return {
    fullResponse,
    toolCallCount,
    stepCount,
    streamFinishReason,
    aborted: false,
  };
}

export interface FinalizeExecutionInput {
  stage: ScriptAgentExecutionStage;
  collected: CollectedExecutionStream;
  subMsg: Msg;
  memory: Memory;
  memoryKey: string;
  name: string;
  deploymentKey: string;
  finishReason?: string | null;
  aborted?: boolean;
  /** 本地项目 number id；有值时校验通过后事务提交 plan */
  projectId?: number;
  /** 提交成功后通知客户端重新 getPlanData */
  socket?: Socket | null;
  /** 项目事务一旦成功立即回调（route markOnce，幂等） */
  onPlanCommitted?: () => void;
  /** 本轮更早阶段是否已提交：失败时首条 error 必须用 PARTIAL_COMMIT */
  priorPlanCommitted?: boolean;
}

export interface FinalizeExecutionResult {
  fullResponse: string;
  planCommitted: boolean;
  /** 记忆为提交后辅助步骤；失败不回滚产物 */
  memoryAuxFailed?: boolean;
}

/**
 * 校验产物 → 项目库事务（权威）→ artifactCommitted / complete → memory.add（辅助）。
 * 项目事务成功后：即使 memory 失败也保留产物、complete 消息、planCommitted=true。
 * 禁止自动重试收费模型；禁止把已提交产物回滚为「工作区未修改」。
 */
export async function finalizeScriptExecutionOutput(
  input: FinalizeExecutionInput,
): Promise<FinalizeExecutionResult> {
  const finishReason = input.finishReason ?? input.collected.streamFinishReason ?? null;
  const validation = validateScriptAgentOutput(input.stage, input.collected.fullResponse, {
    finishReason,
    stepCount: input.collected.stepCount,
    toolCallCount: input.collected.toolCallCount,
    aborted: input.aborted === true || input.collected.aborted,
  });

  const logFields = buildScriptAgentOutputLogFields({
    deploymentKey: input.deploymentKey,
    stage: input.stage,
    finishReason,
    stepCount: input.collected.stepCount,
    toolCallCount: input.collected.toolCallCount,
    responseChars: input.collected.fullResponse.length,
    artifactPresent: validation.ok,
    aborted: input.aborted === true,
    code: validation.ok ? undefined : validation.code,
  });
  console.log("[scriptAgent:execution]", JSON.stringify(logFields));

  if (!validation.ok) {
    // 前一阶段已提交：首条 error 必须 PARTIAL_COMMIT，禁止先发 INCOMPLETE
    if (input.priorPlanCommitted) {
      const partial = toPartialCommitFail(input.stage, validation.responseChars, finishReason);
      input.subMsg.error(partial.message, {
        errorCode: partial.code,
        stage: partial.stage,
      });
      throw new ScriptAgentOutputError(partial);
    }
    input.subMsg.error(validation.message, {
      errorCode: validation.code,
      stage: validation.stage,
    });
    throw new ScriptAgentOutputError(validation);
  }

  let planCommitted = false;
  if (input.projectId != null && Number.isFinite(input.projectId) && input.projectId > 0) {
    try {
      planCommitted = await commitScriptAgentArtifact({
        projectId: input.projectId,
        artifact: validation.artifact,
      });
    } catch (dbErr) {
      console.error("[scriptAgent:execution] plan commit failed", (dbErr as Error)?.name ?? "Error");
      if (input.priorPlanCommitted) {
        const partial = toPartialCommitFail(input.stage, input.collected.fullResponse.length, finishReason);
        input.subMsg.error(partial.message, {
          errorCode: partial.code,
          stage: partial.stage,
        });
        throw new ScriptAgentOutputError(partial);
      }
      input.subMsg.error("保存剧本计划失败，工作区未修改，请重试", {
        errorCode: "SCRIPT_AGENT_OUTPUT_INCOMPLETE",
        stage: input.stage,
      });
      throw new ScriptAgentOutputError({
        ok: false,
        stage: input.stage,
        code: "SCRIPT_AGENT_OUTPUT_INCOMPLETE",
        message: "保存剧本计划失败，工作区未修改，请重试",
        artifactPresent: false,
        responseChars: input.collected.fullResponse.length,
        finishReason,
      });
    }
  }

  // 权威提交点：事务成功后立即 markOnce（onPlanCommitted），再 artifactCommitted，再 memory
  if (planCommitted) {
    try {
      // mark 失败时 marker 置 pendingRetry；此处不中断产物路径，由 route finally 补偿
      input.onPlanCommitted?.();
    } catch {
      // 不得仅 console.error 后丢弃 pendingRetry——状态在 marker 内
    }
    if (input.socket) {
      try {
        input.socket.emit("artifactCommitted", {
          stage: input.stage,
          messageId: input.subMsg.id,
          projectId: input.projectId,
        });
      } catch {
        // 通知失败不影响已提交事务
      }
    }
  }

  // 记忆是提交后辅助步骤，失败不得回滚产物语义
  let memoryAuxFailed = false;
  try {
    await input.memory.add(input.memoryKey, validation.memoryText, {
      name: input.name,
      createTime: new Date(input.subMsg.datetime).getTime(),
    });
  } catch (memErr) {
    memoryAuxFailed = true;
    console.error(
      "[scriptAgent:execution] memory aux failed after plan commit",
      (memErr as Error)?.name ?? "Error",
    );
  }

  // 产物已权威提交（或无 projectId 的校验成功路径）：消息不得残留 pending
  input.subMsg.complete();

  return {
    fullResponse: input.collected.fullResponse,
    planCommitted,
    memoryAuxFailed,
  };
}
