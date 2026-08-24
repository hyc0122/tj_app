/**
 * 剧本 Agent 执行层输出契约：在 complete / memory.add / 事务提交之前验证阶段产物。
 * 禁止先 removeAllXmlTags 再验证；必须在原始 fullResponse 上检查。
 * 成功时返回结构化 artifact，供事务提交使用（禁止入库时松散二次正则解析）。
 */

export type ScriptAgentExecutionStage =
  | "storySkeleton"
  | "adaptationStrategy"
  | "script"
  | "supervision";

export type ScriptAgentOutputErrorCode =
  | "SCRIPT_AGENT_OUTPUT_INCOMPLETE"
  | "SCRIPT_AGENT_OUTPUT_TRUNCATED"
  | "SCRIPT_AGENT_OUTPUT_EMPTY_XML"
  | "SCRIPT_AGENT_OUTPUT_INVALID_SCRIPT"
  | "SCRIPT_AGENT_OUTPUT_PARTIAL_COMMIT"
  | "SCRIPT_AGENT_ABORTED";

export interface ScriptAgentOutputMeta {
  finishReason?: string | null;
  stepCount?: number;
  toolCallCount?: number;
  aborted?: boolean;
}

/** 校验通过后的结构化产物（入库唯一来源） */
export type ScriptAgentParsedArtifact =
  | { kind: "storySkeleton"; content: string }
  | { kind: "adaptationStrategy"; content: string }
  | { kind: "script"; items: Array<{ name: string; content: string }> }
  | { kind: "supervision"; content: string };

export interface ScriptAgentOutputOk {
  ok: true;
  stage: ScriptAgentExecutionStage;
  artifactPresent: true;
  /** 去标签后的正文（可写入记忆） */
  memoryText: string;
  responseChars: number;
  artifact: ScriptAgentParsedArtifact;
}

export interface ScriptAgentOutputFail {
  ok: false;
  stage: ScriptAgentExecutionStage;
  code: ScriptAgentOutputErrorCode;
  /** 安全中文，禁止英文堆栈/供应商原文 */
  message: string;
  artifactPresent: false;
  responseChars: number;
  finishReason?: string | null;
}

export type ScriptAgentOutputResult = ScriptAgentOutputOk | ScriptAgentOutputFail;

/** 各阶段工具白名单：来自对应 Skill 工具表，禁止共用全部 useTools */
export const SCRIPT_AGENT_STAGE_TOOL_WHITELIST: Readonly<
  Record<ScriptAgentExecutionStage, readonly string[]>
> = {
  storySkeleton: ["get_planData", "get_novel_events"],
  adaptationStrategy: ["get_planData", "get_novel_events"],
  script: ["get_planData", "get_novel_events", "get_novel_text", "get_script_content"],
  // 监督层 Skill：get_planData + get_novel_events
  supervision: ["get_planData", "get_novel_events"],
};

/**
 * 决策层工具白名单：仅 memory tools + 四个 subAgent 编排工具。
 * 禁止 get_planData / get_novel_events / get_novel_text / get_script_content。
 */
export const SCRIPT_AGENT_DECISION_TOOL_NAMES: readonly string[] = [
  "deepRetrieve",
  "run_sub_agent_storySkeleton",
  "run_sub_agent_adaptationStrategy",
  "run_sub_agent_script",
  "run_supervision_agent",
] as const;

export const SCRIPT_AGENT_DECISION_FORBIDDEN_TOOLS: readonly string[] = [
  "get_planData",
  "get_novel_events",
  "get_novel_text",
  "get_script_content",
] as const;

export class ScriptAgentOutputError extends Error {
  readonly code: ScriptAgentOutputErrorCode;
  readonly stage: ScriptAgentExecutionStage;
  readonly finishReason?: string | null;
  readonly responseChars: number;

  constructor(fail: ScriptAgentOutputFail) {
    super(fail.message);
    this.name = "ScriptAgentOutputError";
    this.code = fail.code;
    this.stage = fail.stage;
    this.finishReason = fail.finishReason;
    this.responseChars = fail.responseChars;
  }
}

/** Web/日志可用的安全文案映射 */
export function scriptAgentOutputUserMessage(code: ScriptAgentOutputErrorCode, stage: ScriptAgentExecutionStage): string {
  switch (code) {
    case "SCRIPT_AGENT_OUTPUT_TRUNCATED":
      return "模型输出被截断，工作区未修改，请调整模型输出上限后重试";
    case "SCRIPT_AGENT_ABORTED":
      return "已停止生成";
    case "SCRIPT_AGENT_OUTPUT_EMPTY_XML":
      return stageUserIncomplete(stage);
    case "SCRIPT_AGENT_OUTPUT_INVALID_SCRIPT":
      return "执行层未生成有效剧本条目，工作区未修改，请重试";
    case "SCRIPT_AGENT_OUTPUT_PARTIAL_COMMIT":
      return "后续阶段未完成，已保存的产物仍保留，请查看工作区后重试";
    case "SCRIPT_AGENT_OUTPUT_INCOMPLETE":
    default:
      return stageUserIncomplete(stage);
  }
}

/** 本轮已有项目事务提交后的失败：统一 PARTIAL_COMMIT 语义 */
export function buildPartialCommitFail(
  stage: ScriptAgentExecutionStage,
  responseChars = 0,
  finishReason: string | null = null,
): ScriptAgentOutputFail {
  return {
    ok: false,
    stage,
    code: "SCRIPT_AGENT_OUTPUT_PARTIAL_COMMIT",
    message: scriptAgentOutputUserMessage("SCRIPT_AGENT_OUTPUT_PARTIAL_COMMIT", stage),
    artifactPresent: false,
    responseChars,
    finishReason,
  };
}

function stageUserIncomplete(stage: ScriptAgentExecutionStage): string {
  switch (stage) {
    case "storySkeleton":
      return "执行层未生成完整故事骨架，工作区未修改，请重试";
    case "adaptationStrategy":
      return "执行层未生成完整改编策略，工作区未修改，请重试";
    case "script":
      return "执行层未生成完整剧本，工作区未修改，请重试";
    case "supervision":
      return "监督层未生成完整审核报告，请重试";
    default:
      return "执行层输出不完整，工作区未修改，请重试";
  }
}

/**
 * 在原始 fullResponse 上验证阶段产物。
 */
export function validateScriptAgentOutput(
  stage: ScriptAgentExecutionStage,
  fullResponse: string,
  meta: ScriptAgentOutputMeta = {},
): ScriptAgentOutputResult {
  const responseChars = fullResponse.length;
  const finishReason = meta.finishReason ?? null;

  if (meta.aborted) {
    return fail(stage, "SCRIPT_AGENT_ABORTED", responseChars, finishReason);
  }

  // finishReason=length/max-tokens 始终失败，即使前面已有完整标签
  const truncated = finishReason === "length" || finishReason === "max-tokens";
  if (truncated) {
    return fail(stage, "SCRIPT_AGENT_OUTPUT_TRUNCATED", responseChars, finishReason);
  }

  switch (stage) {
    case "storySkeleton":
      return validateExactlyOneNamedBlock(stage, fullResponse, "storySkeleton", finishReason, responseChars);
    case "adaptationStrategy":
      return validateExactlyOneNamedBlock(stage, fullResponse, "adaptationStrategy", finishReason, responseChars);
    case "script":
      return validateScriptItemsStrict(fullResponse, finishReason, responseChars);
    case "supervision":
      return validateSupervision(fullResponse, finishReason, responseChars);
    default:
      return fail(stage, "SCRIPT_AGENT_OUTPUT_INCOMPLETE", responseChars, finishReason);
  }
}

/**
 * 目标标签必须恰好一个完整非空开闭对。
 * 额外未闭合、重复目标标签、孤立关闭标签均失败。
 */
function validateExactlyOneNamedBlock(
  stage: ScriptAgentExecutionStage,
  fullResponse: string,
  tag: string,
  finishReason: string | null,
  responseChars: number,
): ScriptAgentOutputResult {
  const openRe = new RegExp(`<${tag}\\b[^>]*>`, "gi");
  const closeRe = new RegExp(`</${tag}\\s*>`, "gi");
  const opens = [...fullResponse.matchAll(openRe)];
  const closes = [...fullResponse.matchAll(closeRe)];

  if (opens.length !== 1 || closes.length !== 1) {
    return fail(stage, "SCRIPT_AGENT_OUTPUT_INCOMPLETE", responseChars, finishReason);
  }

  const openIndex = opens[0].index ?? -1;
  const closeIndex = closes[0].index ?? -1;
  if (openIndex < 0 || closeIndex < 0 || closeIndex <= openIndex) {
    return fail(stage, "SCRIPT_AGENT_OUTPUT_INCOMPLETE", responseChars, finishReason);
  }

  const openMatch = opens[0][0];
  const innerStart = openIndex + openMatch.length;
  const inner = fullResponse.slice(innerStart, closeIndex);
  if (!inner.trim()) {
    return fail(stage, "SCRIPT_AGENT_OUTPUT_EMPTY_XML", responseChars, finishReason);
  }

  return {
    ok: true,
    stage,
    artifactPresent: true,
    memoryText: stripXmlTags(fullResponse),
    responseChars,
    artifact: {
      kind: stage === "adaptationStrategy" ? "adaptationStrategy" : "storySkeleton",
      content: inner.trim(),
    },
  };
}

/**
 * script：全部 scriptItem 开标签必须逐一闭合，数量一致；
 * 任一残缺、空 name、空 content、重复 name 均整体失败。
 */
function validateScriptItemsStrict(
  fullResponse: string,
  finishReason: string | null,
  responseChars: number,
): ScriptAgentOutputResult {
  const openRe = /<scriptItem\b[^>]*>/gi;
  const closeRe = /<\/scriptItem\s*>/gi;
  const opens = [...fullResponse.matchAll(openRe)];
  const closes = [...fullResponse.matchAll(closeRe)];

  if (opens.length === 0) {
    return fail("script", "SCRIPT_AGENT_OUTPUT_INCOMPLETE", responseChars, finishReason);
  }
  if (opens.length !== closes.length) {
    return fail("script", "SCRIPT_AGENT_OUTPUT_INCOMPLETE", responseChars, finishReason);
  }

  // 顺序配对：第 i 个 open 必须在第 i 个 close 之前，且与 next open 不交叉混乱
  const items: Array<{ name: string; content: string }> = [];
  for (let i = 0; i < opens.length; i++) {
    const open = opens[i];
    const close = closes[i];
    const openIndex = open.index ?? -1;
    const closeIndex = close.index ?? -1;
    if (openIndex < 0 || closeIndex < 0 || closeIndex <= openIndex) {
      return fail("script", "SCRIPT_AGENT_OUTPUT_INCOMPLETE", responseChars, finishReason);
    }
    // 下一个 open 不得插在当前 open 与 close 之间（防止嵌套/错位）
    if (i + 1 < opens.length) {
      const nextOpenIndex = opens[i + 1].index ?? -1;
      if (nextOpenIndex >= 0 && nextOpenIndex < closeIndex) {
        return fail("script", "SCRIPT_AGENT_OUTPUT_INCOMPLETE", responseChars, finishReason);
      }
    }
    // 当前 close 不得早于前一个 close 之后的合理区间已由顺序保证
    if (i > 0) {
      const prevCloseIndex = closes[i - 1].index ?? -1;
      if (openIndex < prevCloseIndex) {
        return fail("script", "SCRIPT_AGENT_OUTPUT_INCOMPLETE", responseChars, finishReason);
      }
    }

    const openTag = open[0];
    const attrs = openTag.replace(/^<scriptItem\b/i, "").replace(/>$/, "");
    const nameMatch = attrs.match(/\bname\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const name = (nameMatch?.[2] ?? nameMatch?.[3] ?? nameMatch?.[4] ?? "").trim();
    const content = fullResponse.slice(openIndex + openTag.length, closeIndex).trim();
    if (!name || !content) {
      return fail("script", "SCRIPT_AGENT_OUTPUT_INVALID_SCRIPT", responseChars, finishReason);
    }
    items.push({ name, content });
  }

  const names = items.map((i) => i.name);
  if (new Set(names).size !== names.length) {
    return fail("script", "SCRIPT_AGENT_OUTPUT_INVALID_SCRIPT", responseChars, finishReason);
  }

  return {
    ok: true,
    stage: "script",
    artifactPresent: true,
    memoryText: stripXmlTags(fullResponse),
    responseChars,
    artifact: { kind: "script", items },
  };
}

function validateSupervision(
  fullResponse: string,
  finishReason: string | null,
  responseChars: number,
): ScriptAgentOutputResult {
  const text = fullResponse.trim();
  if (!text) {
    return fail("supervision", "SCRIPT_AGENT_OUTPUT_INCOMPLETE", responseChars, finishReason);
  }
  // 监督层无强制 XML，但拒绝过短的工具过渡语
  if (text.length < 40 && /let me|checking|now /i.test(text)) {
    return fail("supervision", "SCRIPT_AGENT_OUTPUT_INCOMPLETE", responseChars, finishReason);
  }
  return {
    ok: true,
    stage: "supervision",
    artifactPresent: true,
    memoryText: stripXmlTags(fullResponse),
    responseChars,
    artifact: { kind: "supervision", content: text },
  };
}

function fail(
  stage: ScriptAgentExecutionStage,
  code: ScriptAgentOutputErrorCode,
  responseChars: number,
  finishReason: string | null,
): ScriptAgentOutputFail {
  return {
    ok: false,
    stage,
    code,
    message: scriptAgentOutputUserMessage(code, stage),
    artifactPresent: false,
    responseChars,
    finishReason,
  };
}

/** 去掉 XML 后用于记忆；不得用于验证前预处理 */
export function stripXmlTags(text: string): string {
  let out = text.replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?>([\s\S]*?)<\/\1>/g, "$3");
  out = out.replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?\/>/g, "");
  out = out.replace(/<\/?[a-zA-Z][\w-]*(\s+[^>]*)?>/g, "");
  return out.trim();
}

/**
 * 安全执行层诊断日志字段（禁止 Prompt/正文/密钥）。
 */
export function buildScriptAgentOutputLogFields(input: {
  deploymentKey: string;
  stage: ScriptAgentExecutionStage;
  finishReason?: string | null;
  stepCount?: number;
  toolCallCount?: number;
  responseChars: number;
  artifactPresent: boolean;
  aborted?: boolean;
  code?: string;
}): Record<string, string | number | boolean | null> {
  return {
    deploymentKey: input.deploymentKey,
    stage: input.stage,
    finishReason: input.finishReason ?? null,
    stepCount: input.stepCount ?? 0,
    toolCallCount: input.toolCallCount ?? 0,
    responseChars: input.responseChars,
    artifactPresent: input.artifactPresent,
    aborted: input.aborted === true,
    code: input.code ?? null,
  };
}
