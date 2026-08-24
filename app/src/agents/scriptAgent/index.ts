import { Socket } from "socket.io";
import { tool, jsonSchema } from "ai";
import { z } from "zod";
import u from "@/utils";
import {
  currentAccountSkillsRoot,
  resolveAccountSkillFile,
} from "@/tianjiang/skills/account-skills";
import Memory from "@/utils/agent/memory";
import useTools from "@/agents/scriptAgent/tools";
import ResTool from "@/socket/resTool";
import type { AdvancedDeploymentKey } from "@/tianjiang/model/deployment-keys";
import * as fs from "fs";
import {
  SCRIPT_AGENT_DECISION_TOOL_NAMES,
  SCRIPT_AGENT_STAGE_TOOL_WHITELIST,
  ScriptAgentOutputError,
  type ScriptAgentExecutionStage,
} from "./script-agent-output-contract";
import {
  consumeFullStreamForExecution,
  finalizeScriptExecutionOutput,
  toPartialCommitFail,
} from "./script-agent-execution";
import type { DecisionRunResult } from "./script-agent-decision-result";

export interface AgentContext {
  socket: Socket;
  isolationKey: string;
  text: string;
  userMessageTime?: number;
  abortSignal?: AbortSignal;
  resTool: ResTool;
  msg: ReturnType<ResTool["newMessage"]>;
  thinkConfig: {
    think: boolean;
    thinlLevel: 0 | 1 | 2 | 3;
  };
  /** 本轮是否已有 plan 事务提交（供 route markLegacyMutation） */
  planCommitted?: boolean;
  /**
   * 项目事务提交后立即调用（route 注入幂等 markOnce）。
   * 不得等待整轮 runDecisionAI 结束。
   */
  onPlanCommitted?: () => void;
}

function buildMemPrompt(mem: Awaited<ReturnType<Memory["get"]>>): string {
  let memoryContext = "";
  if (mem.rag.length) {
    memoryContext += `[相关记忆]\n${mem.rag.map((r) => r.content).join("\n")}`;
  }
  if (mem.summaries.length) {
    if (memoryContext) memoryContext += "\n\n";
    memoryContext += `[历史摘要]\n${mem.summaries.map((s, i) => `${i + 1}. ${s.content}`).join("\n")}`;
  }
  if (mem.shortTerm.length) {
    if (memoryContext) memoryContext += "\n\n";
    memoryContext += `[近期对话]\n${mem.shortTerm.map((m) => `${m.role}: ${m.content}`).join("\n")}`;
  }
  return `## Memory\n以下是你对用户的记忆，可作为参考但不要主动提及：\n${memoryContext}`;
}

/**
 * 决策层 tools：真正的五项 allowlist（非 denylist）。
 * 最终 Object.keys 必须严格等于 SCRIPT_AGENT_DECISION_TOOL_NAMES。
 * Memory.getTools 若出现额外键也不会暴露。
 */
export function buildDecisionTools(ctx: AgentContext): Record<string, unknown> {
  const memory = new Memory("scriptAgent", ctx.isolationKey);
  const candidates: Record<string, unknown> = {
    ...memory.getTools(),
    ...createSubAgent(ctx),
  };
  const tools: Record<string, unknown> = {};
  for (const name of SCRIPT_AGENT_DECISION_TOOL_NAMES) {
    if (candidates[name] != null) {
      tools[name] = candidates[name];
    }
  }
  return tools;
}

export async function runDecisionAI(ctx: AgentContext): Promise<DecisionRunResult> {
  const { isolationKey, text, userMessageTime, abortSignal, resTool } = ctx;
  // 可变追踪器：避免 `= false` 后控制流把 planCommitted 收窄为字面量 false
  const commitTracker: { planCommitted: boolean } = { planCommitted: false };
  ctx.planCommitted = false;
  const memory = new Memory("scriptAgent", isolationKey);
  await memory.add("user", text, { createTime: userMessageTime });

  const skill = resolveAccountSkillFile(currentAccountSkillsRoot(u.getPath()), "script_agent_decision.md");
  const prompt = await fs.promises.readFile(skill, "utf-8");

  const mem = buildMemPrompt(await memory.get(text));

  const projectData = await u.db("o_project").where("id", resTool.data.projectId).first();

  const novelData = await u.db("o_novel").where("projectId", resTool.data.projectId).select("chapterIndex");

  const projectInfo = [
    "## 项目信息",
    `小说名称：${projectData?.name ?? "未知"}`,
    `小说类型：${projectData?.type ?? "未知"}`,
    `小说简介：${projectData?.intro ?? "无"}`,
    `目标改编影视视觉手册|画风：${projectData?.artStyle ?? "无"}`,
    `目标改编视频画幅：${projectData?.videoRatio ?? "16:9"}`,
    `章节数量：${novelData.length}章`,
  ].join("\n");

  // 将 tracker 挂到 ctx，供 subAgent 成功提交后回写
  (ctx as AgentContext & { __commitTracker?: { planCommitted: boolean } }).__commitTracker = commitTracker;
  const decisionTools = buildDecisionTools(ctx);

  const { fullStream } = await u.Ai.Text("scriptAgent:decisionAgent", ctx.thinkConfig.think, ctx.thinkConfig.thinlLevel).stream({
    messages: [
      { role: "system", content: prompt },
      { role: "assistant", content: projectInfo + "\n" + mem },
      { role: "user", content: text },
    ],
    abortSignal,
    tools: decisionTools as any,
    onFinish: async (completion) => {
      await memory.add("assistant:decision", stripAllXmlForMemory(completion.text));
    },
  });

  let currentMsg = ctx.msg;
  await consumeFullStreamForExecution(fullStream, currentMsg, { abortSignal }, () => {
    if (ctx.msg === currentMsg) return currentMsg;
    currentMsg.complete();
    currentMsg = ctx.msg;
    return currentMsg;
  });

  return { planCommitted: commitTracker.planCommitted };
}

function createSubAgent(parentCtx: AgentContext) {
  const { resTool, abortSignal } = parentCtx;
  const memory = new Memory("scriptAgent", parentCtx.isolationKey);
  const commitTracker =
    (parentCtx as AgentContext & { __commitTracker?: { planCommitted: boolean } }).__commitTracker;

  async function runAgent({
    key,
    prompt,
    system,
    name,
    memoryKey,
    stage,
    messages,
  }: {
    key: AdvancedDeploymentKey;
    prompt: string;
    system: string;
    name: string;
    memoryKey: string;
    stage: ScriptAgentExecutionStage;
    /** 禁止 extraTools 覆盖阶段白名单，参数已移除 */
    messages?: { role: "user" | "assistant" | "system"; content: string }[];
  }) {
    parentCtx.msg.complete();
    const subMsg = resTool.newMessage("assistant", name);

    const whitelist = SCRIPT_AGENT_STAGE_TOOL_WHITELIST[stage];
    // 冻结白名单：仅 stageTools，禁止 extraTools 覆盖
    const stageTools = useTools({
      resTool,
      msg: subMsg,
      toolsNames: [...whitelist],
    });

    const streamResult = await u.Ai.Text(key, parentCtx.thinkConfig.think, parentCtx.thinkConfig.thinlLevel).stream({
      system,
      messages: messages ?? [{ role: "user", content: prompt }],
      abortSignal,
      tools: stageTools,
    });

    let collected;
    try {
      collected = await consumeFullStreamForExecution(streamResult.fullStream, subMsg, {
        deferComplete: true,
        abortSignal,
      });
    } catch (err: any) {
      if (err?.name === "AbortError") throw err;
      throw err;
    }

    let finishReason: string | null | undefined = collected.streamFinishReason;
    try {
      // AI SDK：finishReason 为 PromiseLike<FinishReason>
      const fr = (streamResult as unknown as { finishReason?: PromiseLike<string> | string }).finishReason;
      if (fr != null && typeof fr === "object" && typeof (fr as PromiseLike<string>).then === "function") {
        finishReason = await Promise.resolve(fr as PromiseLike<string>);
      } else if (typeof fr === "string") {
        finishReason = fr;
      }
    } catch {
      // 忽略 finishReason 读取失败，依赖流内 finish 块
    }

    try {
      const finalized = await finalizeScriptExecutionOutput({
        stage,
        collected,
        subMsg,
        memory,
        memoryKey,
        name,
        deploymentKey: key,
        finishReason,
        aborted: abortSignal?.aborted === true,
        projectId: Number(resTool.data.projectId),
        socket: parentCtx.socket,
        priorPlanCommitted: parentCtx.planCommitted === true,
        onPlanCommitted: () => {
          // 先记事实，再立即 markOnce（route 注入）
          parentCtx.planCommitted = true;
          if (commitTracker) commitTracker.planCommitted = true;
          parentCtx.onPlanCommitted?.();
        },
      });
      if (finalized.planCommitted) {
        parentCtx.planCommitted = true;
        if (commitTracker) commitTracker.planCommitted = true;
      }
      // 仅成功后创建后续「视频策划」消息；失败不得残留 pending 空消息
      parentCtx.msg = resTool.newMessage("assistant", "视频策划");
      return finalized.fullResponse;
    } catch (err) {
      // 失败：不创建空的「视频策划」消息
      if (err instanceof ScriptAgentOutputError) {
        // 已有提交且非 PARTIAL/ABORT：升级为 PARTIAL（子消息应已由 finalize 发出 PARTIAL）
        if (
          parentCtx.planCommitted &&
          err.code !== "SCRIPT_AGENT_OUTPUT_PARTIAL_COMMIT" &&
          err.code !== "SCRIPT_AGENT_ABORTED"
        ) {
          throw new ScriptAgentOutputError(
            toPartialCommitFail(err.stage, err.responseChars, err.finishReason ?? null),
          );
        }
        throw err;
      }
      // generic tool-error / provider：已有提交 → PARTIAL_COMMIT（首条可见 error）
      if (parentCtx.planCommitted) {
        const partial = toPartialCommitFail(stage, 0, null);
        try {
          subMsg.error(partial.message, { errorCode: partial.code, stage: partial.stage });
        } catch {
          // ignore
        }
        throw new ScriptAgentOutputError(partial);
      }
      throw err;
    }
  }

  const promptInput = z
    .object({
      prompt: z.string().describe("交给子Agent的任务简约描述，100字以内"),
    })
    .toJSONSchema();

  const run_sub_agent_storySkeleton = tool({
    description: "运行执行subAgent来完成故事骨架相关任务",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const skill = resolveAccountSkillFile(currentAccountSkillsRoot(u.getPath()), "script_execution_skeleton.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");

      const formatPrompt = "\n你必须使用如下XML格式写入工作区：\n<storySkeleton>故事骨架内容</storySkeleton>";

      return runAgent({
        key: "scriptAgent:storySkeletonAgent",
        prompt,
        system: systemPrompt + formatPrompt,
        name: "编剧",
        memoryKey: "assistant:execution:storySkeleton",
        stage: "storySkeleton",
        messages: [{ role: "user", content: prompt + formatPrompt }],
      });
    },
  });

  const run_sub_agent_adaptationStrategy = tool({
    description: "运行执行subAgent来完成改编策略相关任务",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const skill = resolveAccountSkillFile(currentAccountSkillsRoot(u.getPath()), "script_execution_adaptation.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");

      const formatPrompt = "\n你必须使用如下XML格式写入工作区：\n<adaptationStrategy>改编策略内容</adaptationStrategy>";

      return runAgent({
        key: "scriptAgent:adaptationStrategyAgent",
        prompt,
        system: systemPrompt + formatPrompt,
        name: "编剧",
        memoryKey: "assistant:execution:adaptationStrategy",
        stage: "adaptationStrategy",
        messages: [{ role: "user", content: prompt + formatPrompt }],
      });
    },
  });

  const run_sub_agent_script = tool({
    description: "运行执行subAgent来完成剧本相关任务",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const skill = resolveAccountSkillFile(currentAccountSkillsRoot(u.getPath()), "script_execution_script.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");

      const scriptList = await u.db("o_script").where("projectId", resTool.data.projectId).select("id", "name");
      const scriptPrompt = ["## 可用剧本(ID:名称)", scriptList.map((s: any) => `${s.id}:${(s.name || "").replace(/[,:]/g, "")}`).join(","), ""].join(
        "\n",
      );

      const novelData = await u.db("o_novel").where("projectId", resTool.data.projectId).select("chapterIndex");

      const formatPrompt = `\n你必须使用如下XML格式写入工作区：\nXML不得添加任何额外标签<scriptItem name="剧本名称">剧本内容</scriptItem><scriptItem name="剧本名称">剧本内容</scriptItem><scriptItem name="剧本名称">剧本内容</scriptItem>`;

      return runAgent({
        key: "scriptAgent:scriptAgent",
        prompt,
        system: systemPrompt + formatPrompt,
        messages: [
          { role: "assistant", content: scriptPrompt + `章节数量：${novelData.length}章` },
          { role: "user", content: prompt + formatPrompt },
        ],
        name: "编剧",
        memoryKey: "assistant:execution:script",
        stage: "script",
      });
    },
  });

  const run_supervision_agent = tool({
    description: "运行监督层subAgent执行独立任务，完成后返回结果",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const skill = resolveAccountSkillFile(currentAccountSkillsRoot(u.getPath()), "script_agent_supervision.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");

      return runAgent({
        key: "scriptAgent:supervisionAgent",
        prompt,
        system: systemPrompt,
        name: "编辑",
        memoryKey: "assistant:supervision",
        stage: "supervision",
      });
    },
  });

  return {
    run_sub_agent_storySkeleton,
    run_sub_agent_adaptationStrategy,
    run_sub_agent_script,
    run_supervision_agent,
  };
}

function stripAllXmlForMemory(text: string): string {
  let out = text.replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?>([\s\S]*?)<\/\1>/g, "$3");
  out = out.replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?\/>/g, "");
  out = out.replace(/<\/?[a-zA-Z][\w-]*(\s+[^>]*)?>/g, "");
  return out.trim();
}

export { ScriptAgentOutputError };
export {
  validateScriptAgentOutput,
  SCRIPT_AGENT_STAGE_TOOL_WHITELIST,
  SCRIPT_AGENT_DECISION_TOOL_NAMES,
} from "./script-agent-output-contract";
export {
  shouldMarkLegacyMutationAfterDecision,
  type DecisionRunResult,
} from "./script-agent-decision-result";
