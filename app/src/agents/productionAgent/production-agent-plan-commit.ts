/**
 * 导演规划权威提交服务。
 *
 * 关键不变量：
 * 1. 只更新当前剧集 productionAgent 数据中的 scriptPlan；
 * 2. 读取、合并、写入与 mutation journal 必须在同一 project.sqlite 事务内；
 * 3. 既有工作区 JSON 损坏时 fail-closed，禁止用默认值覆盖用户数据。
 */
import type { Knex } from "knex";

import { upsertPendingMutationJournalInTrx } from "@/tianjiang/runtime/legacy-mutation-journal";
import { db } from "@/utils/db";

export type ProductionAgentPlanCommitCode =
  | "PRODUCTION_AGENT_PROJECT_MISMATCH"
  | "PRODUCTION_AGENT_WORKSPACE_CORRUPT"
  | "PRODUCTION_AGENT_PLAN_INVALID";

export class ProductionAgentPlanCommitError extends Error {
  readonly safe = true;

  constructor(
    public readonly code: ProductionAgentPlanCommitCode,
    message: string,
  ) {
    super(message);
    this.name = "ProductionAgentPlanCommitError";
  }
}

export interface CommitProductionDirectorPlanInput {
  projectId: number;
  episodesId: number;
  content: string;
  /** 测试或上层已有事务时可注入；生产默认自行开启事务。 */
  trx?: Knex.Transaction;
}

type ProductionFlowRecord = Record<string, unknown> & {
  scriptPlan?: string;
};

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ProductionAgentPlanCommitError(
      "PRODUCTION_AGENT_PLAN_INVALID",
      `${label}无效，导演规划未写入工作区`,
    );
  }
}

function parseExistingFlowData(raw: unknown): ProductionFlowRecord {
  try {
    const parsed = JSON.parse(typeof raw === "string" ? raw : "") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("工作区数据不是对象");
    }
    return parsed as ProductionFlowRecord;
  } catch {
    throw new ProductionAgentPlanCommitError(
      "PRODUCTION_AGENT_WORKSPACE_CORRUPT",
      "导演规划工作区数据损坏，已停止写入以保护现有内容",
    );
  }
}

function createInitialFlowData(script: string): ProductionFlowRecord {
  return {
    script,
    scriptPlan: "",
    assets: [],
    storyboardTable: "",
    storyboard: [],
    workbench: { videoList: [] },
  };
}

/**
 * 将已通过输出契约校验的导演规划提交到当前剧集工作区。
 */
export async function commitProductionDirectorPlan(
  input: CommitProductionDirectorPlanInput,
): Promise<void> {
  const { projectId, episodesId } = input;
  const content = input.content.trim();
  assertPositiveSafeInteger(projectId, "项目 ID");
  assertPositiveSafeInteger(episodesId, "剧集 ID");
  if (!content) {
    throw new ProductionAgentPlanCommitError(
      "PRODUCTION_AGENT_PLAN_INVALID",
      "导演规划内容为空，未写入工作区",
    );
  }

  const run = async (trx: Knex.Transaction): Promise<void> => {
    // 中文注释：先在同一项目内确认剧集归属，禁止跨项目 episode ID 写入。
    const episode = await trx("o_script").where({ id: episodesId, projectId }).first();
    if (!episode) {
      throw new ProductionAgentPlanCommitError(
        "PRODUCTION_AGENT_PROJECT_MISMATCH",
        "当前剧本集不属于当前项目，导演规划未写入",
      );
    }

    const existing = await trx("o_agentWorkData")
      .where({ projectId, episodesId, key: "productionAgent" })
      .first();
    const current = existing
      ? parseExistingFlowData(existing.data)
      : createInitialFlowData(String(episode.content ?? ""));

    // 中文注释：事务内基于最新行合并，只替换 scriptPlan，保留人工编辑和其他阶段产物。
    const next: ProductionFlowRecord = { ...current, scriptPlan: content };
    const now = Date.now();
    if (existing) {
      await trx("o_agentWorkData").where({ id: existing.id }).update({
        data: JSON.stringify(next),
        updateTime: now,
      });
    } else {
      await trx("o_agentWorkData").insert({
        projectId,
        episodesId,
        key: "productionAgent",
        data: JSON.stringify(next),
        createTime: now,
        updateTime: now,
      });
    }

    // 中文注释：journal 与产物共用事务，进程崩溃后仍可恢复 dirty 事实。
    await upsertPendingMutationJournalInTrx(trx, "productionAgent");
  };

  if (input.trx) {
    await run(input.trx);
  } else {
    await db.transaction(run);
  }
}
