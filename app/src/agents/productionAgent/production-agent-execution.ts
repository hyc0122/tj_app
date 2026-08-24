/**
 * Production Agent 导演规划执行生命周期。
 * 流结束不等于业务成功：完整产物校验通过后才能事务提交并完成消息。
 */
import type { Socket } from "socket.io";

import type ResTool from "@/socket/resTool";
import type Memory from "@/utils/agent/memory";
import {
  ProductionAgentOutputError,
  type ProductionAgentOutputFail,
  validateProductionAgentOutput,
} from "./production-agent-output-contract";
import {
  commitProductionDirectorPlan,
  type CommitProductionDirectorPlanInput,
} from "./production-agent-plan-commit";

type Msg = ReturnType<ResTool["newMessage"]>;

export interface CollectedProductionExecutionStream {
  fullResponse: string;
  toolCallCount: number;
  stepCount: number;
  streamFinishReason?: string | null;
  aborted: boolean;
}

export interface FinalizeProductionDirectorPlanInput {
  collected: CollectedProductionExecutionStream;
  subMsg: Msg;
  projectId: number;
  episodesId: number;
  memory: Memory;
  memoryKey: string;
  name: string;
  finishReason?: string | null;
  aborted?: boolean;
  socket?: Socket | null;
  /** 权威事务成功后立即登记 dirty/intent；失败由 route finally 补偿。 */
  onArtifactCommitted?: () => void;
  /** 测试注入点；生产默认使用真实 project.sqlite 提交服务。 */
  commitArtifact?: (input: CommitProductionDirectorPlanInput) => Promise<void>;
}

export interface FinalizeProductionDirectorPlanResult {
  fullResponse: string;
  artifactCommitted: true;
  memoryAuxFailed?: boolean;
}

function buildCommitFailure(
  responseChars: number,
  finishReason: string | null,
): ProductionAgentOutputFail {
  return {
    ok: false,
    stage: "directorPlan",
    code: "PRODUCTION_AGENT_OUTPUT_INCOMPLETE",
    message: "保存导演规划失败，工作区未修改，请重试",
    responseChars,
    finishReason,
  };
}

/**
 * 校验原始输出 → 事务提交 → dirty/Socket 通知 → memory 辅助写入 → complete。
 */
export async function finalizeProductionDirectorPlanOutput(
  input: FinalizeProductionDirectorPlanInput,
): Promise<FinalizeProductionDirectorPlanResult> {
  const finishReason = input.finishReason ?? input.collected.streamFinishReason ?? null;
  const validation = validateProductionAgentOutput("directorPlan", input.collected.fullResponse, {
    finishReason,
    aborted: input.aborted === true || input.collected.aborted,
  });

  if (!validation.ok) {
    input.subMsg.error(validation.message, {
      errorCode: validation.code,
      stage: validation.stage,
    });
    throw new ProductionAgentOutputError(validation);
  }

  try {
    await (input.commitArtifact ?? commitProductionDirectorPlan)({
      projectId: input.projectId,
      episodesId: input.episodesId,
      content: validation.artifact.content,
    });
  } catch (error) {
    console.error(
      "[productionAgent:directorPlan] workspace commit failed",
      (error as Error)?.name ?? "Error",
    );
    const fail = buildCommitFailure(validation.responseChars, finishReason);
    input.subMsg.error(fail.message, {
      errorCode: fail.code,
      stage: fail.stage,
    });
    throw new ProductionAgentOutputError(fail);
  }

  // 中文注释：事务成功是权威提交点；后续辅助步骤失败不得回滚产物。
  try {
    input.onArtifactCommitted?.();
  } catch {
    // route 中的幂等 marker 会保留 pendingRetry，并在 finally 补偿。
  }
  try {
    input.socket?.emit("artifactCommitted", {
      stage: "directorPlan",
      messageId: input.subMsg.id,
      projectId: input.projectId,
      episodesId: input.episodesId,
    });
  } catch {
    // 客户端通知失败不影响已经提交的项目事务。
  }

  let memoryAuxFailed = false;
  try {
    await input.memory.add(input.memoryKey, validation.memoryText, {
      name: input.name,
      createTime: new Date(input.subMsg.datetime).getTime(),
    });
  } catch (error) {
    memoryAuxFailed = true;
    console.error(
      "[productionAgent:directorPlan] memory aux failed after commit",
      (error as Error)?.name ?? "Error",
    );
  }

  input.subMsg.complete();
  return {
    fullResponse: input.collected.fullResponse,
    artifactCommitted: true,
    memoryAuxFailed,
  };
}
