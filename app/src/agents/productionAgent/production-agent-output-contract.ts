/**
 * Production Agent 导演规划输出契约。
 * 流结束不代表业务成功；只有校验后的完整 scriptPlan 才能进入权威提交。
 */

export type ProductionAgentExecutionStage = "directorPlan";

export type ProductionAgentOutputErrorCode =
  | "PRODUCTION_AGENT_OUTPUT_INCOMPLETE"
  | "PRODUCTION_AGENT_OUTPUT_EMPTY_XML"
  | "PRODUCTION_AGENT_OUTPUT_TRUNCATED"
  | "PRODUCTION_AGENT_ABORTED";

export interface ProductionAgentParsedArtifact {
  kind: "scriptPlan";
  content: string;
}

export interface ProductionAgentOutputSuccess {
  ok: true;
  stage: ProductionAgentExecutionStage;
  artifact: ProductionAgentParsedArtifact;
  memoryText: string;
  responseChars: number;
  finishReason: string | null;
}

export interface ProductionAgentOutputFail {
  ok: false;
  stage: ProductionAgentExecutionStage;
  code: ProductionAgentOutputErrorCode;
  message: string;
  responseChars: number;
  finishReason: string | null;
}

export type ProductionAgentOutputResult =
  | ProductionAgentOutputSuccess
  | ProductionAgentOutputFail;

export interface ProductionAgentOutputMeta {
  finishReason?: string | null;
  aborted?: boolean;
}

export class ProductionAgentOutputError extends Error {
  readonly name = "ProductionAgentOutputError";
  readonly code: ProductionAgentOutputErrorCode;
  readonly stage: ProductionAgentExecutionStage;
  readonly finishReason: string | null;
  readonly responseChars: number;

  constructor(fail: ProductionAgentOutputFail) {
    super(fail.message);
    this.code = fail.code;
    this.stage = fail.stage;
    this.finishReason = fail.finishReason;
    this.responseChars = fail.responseChars;
  }
}

interface CompleteBlock {
  contentStart: number;
  contentEnd: number;
}

/**
 * 使用同名标签栈寻找真实闭合块。
 * 模型可能在标题或结束语中用反引号提到 `<scriptPlan>`；这些未配对引用不能覆盖产物。
 */
function findCompleteBlocks(text: string, tag: string): CompleteBlock[] {
  const tokenRegex = new RegExp(`<(/?)${tag}(?:\\s[^>]*)?>`, "g");
  const opens: Array<{ contentStart: number }> = [];
  const complete: CompleteBlock[] = [];
  let token: RegExpExecArray | null;

  while ((token = tokenRegex.exec(text)) !== null) {
    if (token[1] === "/") {
      const open = opens.pop();
      if (open) {
        complete.push({
          contentStart: open.contentStart,
          contentEnd: token.index,
        });
      }
      continue;
    }
    opens.push({ contentStart: tokenRegex.lastIndex });
  }

  return complete;
}

function fail(
  stage: ProductionAgentExecutionStage,
  code: ProductionAgentOutputErrorCode,
  message: string,
  responseChars: number,
  finishReason: string | null,
): ProductionAgentOutputFail {
  return {
    ok: false,
    stage,
    code,
    message,
    responseChars,
    finishReason,
  };
}

export function validateProductionAgentOutput(
  stage: ProductionAgentExecutionStage,
  fullResponse: string,
  meta: ProductionAgentOutputMeta = {},
): ProductionAgentOutputResult {
  const finishReason = meta.finishReason ?? null;
  const responseChars = fullResponse.length;

  if (meta.aborted) {
    return fail(
      stage,
      "PRODUCTION_AGENT_ABORTED",
      "导演规划已停止，工作区未修改",
      responseChars,
      finishReason,
    );
  }

  const normalizedFinishReason = String(finishReason ?? "").toLowerCase();
  if (["length", "max-tokens", "max_tokens"].includes(normalizedFinishReason)) {
    return fail(
      stage,
      "PRODUCTION_AGENT_OUTPUT_TRUNCATED",
      "导演规划输出被截断，工作区未修改，请重试",
      responseChars,
      finishReason,
    );
  }

  const completeBlocks = findCompleteBlocks(fullResponse, "scriptPlan");
  if (completeBlocks.length !== 1) {
    return fail(
      stage,
      "PRODUCTION_AGENT_OUTPUT_INCOMPLETE",
      "导演规划输出不完整，工作区未修改，请重试",
      responseChars,
      finishReason,
    );
  }

  const block = completeBlocks[0];
  const content = fullResponse.slice(block.contentStart, block.contentEnd).trim();
  if (!content) {
    return fail(
      stage,
      "PRODUCTION_AGENT_OUTPUT_EMPTY_XML",
      "导演规划产物为空，工作区未修改，请重试",
      responseChars,
      finishReason,
    );
  }

  return {
    ok: true,
    stage,
    artifact: {
      kind: "scriptPlan",
      content,
    },
    // 记忆只保留权威产物正文，禁止把外围自检或标签引用重新喂给决策层。
    memoryText: content,
    responseChars,
    finishReason,
  };
}
