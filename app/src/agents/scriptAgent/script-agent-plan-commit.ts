/**
 * 剧本计划事务提交服务：从 setPlanData 路由抽取的共享实现。
 * 执行层校验通过后与 HTTP 手动保存共用同一事务语义。
 *
 * commitScriptAgentArtifact：读取/合并/写入必须在同一 project.sqlite transaction 内；
 * 只更新目标字段，禁止用事务外旧快照覆盖并发手动编辑。
 */
import { db } from "@/utils/db";
import type { Knex } from "knex";
import type { ScriptAgentParsedArtifact } from "./script-agent-output-contract";
import { upsertPendingMutationJournalInTrx } from "@/tianjiang/runtime/legacy-mutation-journal";

export interface ScriptAgentPlanDataPayload {
  storySkeleton: string;
  adaptationStrategy: string;
  script: Array<{ id?: number; name: string; content: string }>;
}

export interface CommitScriptAgentPlanInput {
  projectId: number;
  agentType: "scriptAgent";
  data: ScriptAgentPlanDataPayload;
  /** 可选外部事务；未传则自行开启 */
  trx?: Knex.Transaction;
}

/**
 * 原子保存故事骨架/改编策略与剧本列表。
 * 骨架与剧本必须同事务；禁止 Promise.all 并发写同一 SQLite 连接。
 */
export async function commitScriptAgentPlanData(input: CommitScriptAgentPlanInput): Promise<void> {
  const { projectId, agentType, data } = input;
  const run = async (trx: Knex.Transaction) => {
    await upsertWorkData(trx, projectId, agentType, {
      storySkeleton: data.storySkeleton,
      adaptationStrategy: data.adaptationStrategy,
    });
    for (const s of data.script) {
      await upsertScriptItem(trx, projectId, s);
    }
  };

  if (input.trx) {
    await run(input.trx);
  } else {
    await db.transaction(async (trx: Knex.Transaction) => {
      await run(trx);
    });
  }
}

async function upsertWorkData(
  trx: Knex.Transaction,
  projectId: number,
  agentType: string,
  fields: { storySkeleton: string; adaptationStrategy: string },
): Promise<void> {
  const workPayload = JSON.stringify(fields);
  const existing = await trx("o_agentWorkData").where({ projectId, key: agentType }).first();
  if (existing) {
    await trx("o_agentWorkData").where({ id: existing.id }).update({ data: workPayload });
  } else {
    await trx("o_agentWorkData").insert({
      projectId,
      key: agentType,
      data: workPayload,
    });
  }
}

async function upsertScriptItem(
  trx: Knex.Transaction,
  projectId: number,
  s: { id?: number; name: string; content: string },
): Promise<void> {
  if (s.id != null) {
    const row = await trx("o_script").where({ id: s.id }).first();
    if (!row || Number(row.projectId) !== Number(projectId)) {
      throw Object.assign(new Error("SCRIPT_CROSS_PROJECT"), { safe: true });
    }
    await trx("o_script").where({ id: s.id }).update({
      name: s.name,
      content: s.content,
    });
  } else {
    const byName = await trx("o_script").where({ projectId, name: s.name }).first();
    if (byName) {
      await trx("o_script").where({ id: byName.id }).update({ content: s.content });
    } else {
      await trx("o_script").insert({
        projectId,
        name: s.name,
        content: s.content,
      });
    }
  }
}

/** 在给定事务（或默认连接）内读取计划数据 */
export async function readScriptAgentPlanDataInTrx(
  trx: Knex | Knex.Transaction,
  projectId: number,
  agentType: "scriptAgent" = "scriptAgent",
): Promise<ScriptAgentPlanDataPayload> {
  const row = await trx("o_agentWorkData").where({ projectId, key: agentType }).first();
  if (!row) {
    return { storySkeleton: "", adaptationStrategy: "", script: [] };
  }
  const data = JSON.parse(row.data ?? "{}") as {
    storySkeleton?: string;
    adaptationStrategy?: string;
  };
  const script = await trx("o_script").where({ projectId }).select("id", "name", "content");
  return {
    storySkeleton: data.storySkeleton ?? "",
    adaptationStrategy: data.adaptationStrategy ?? "",
    script: (script ?? []).map((s: { id: number; name: string; content: string }) => ({
      id: s.id,
      name: s.name,
      content: s.content,
    })),
  };
}

/**
 * 读取当前计划数据（无数据时返回空结构，不插入）。
 */
export async function readScriptAgentPlanData(
  projectId: number,
  agentType: "scriptAgent" = "scriptAgent",
): Promise<ScriptAgentPlanDataPayload> {
  return readScriptAgentPlanDataInTrx(db, projectId, agentType);
}

export interface CommitArtifactTestHooks {
  /**
   * 测试用：在权威事务 **开始前** 插入一次手动保存（非“事务读后”并发）。
   * 生产代码不得传入。用于证明事务内重新读取最新行且只更新目标字段。
   * （SQLite pool max=1，不可在持锁事务内再开写事务。）
   */
  beforeAuthoritativeTransaction?: () => Promise<void>;
  /** @deprecated 语义同 beforeAuthoritativeTransaction，保留兼容旧测试名 */
  afterRead?: () => Promise<void>;
}

/**
 * 将结构化 artifact 合并进当前计划并事务提交。
 * - storySkeleton：只更新骨架字段，不写剧本表
 * - adaptationStrategy：只更新策略字段，不写剧本表
 * - script：只 upsert 本次条目，不重写骨架/策略
 * - supervision：不写 planData
 *
 * 读取/合并/写入均在同一 transaction 内完成。
 */
export async function commitScriptAgentArtifact(input: {
  projectId: number;
  artifact: ScriptAgentParsedArtifact;
  testHooks?: CommitArtifactTestHooks;
}): Promise<boolean> {
  const { projectId, artifact } = input;
  if (artifact.kind === "supervision") {
    return false;
  }

  // 测试 barrier：权威事务开始前插入手动保存，随后事务内读取最新行
  const preHook =
    input.testHooks?.beforeAuthoritativeTransaction ?? input.testHooks?.afterRead;
  if (preHook) {
    await preHook();
  }

  await db.transaction(async (trx: Knex.Transaction) => {
    const current = await readScriptAgentPlanDataInTrx(trx, projectId, "scriptAgent");

    if (artifact.kind === "storySkeleton") {
      // 只改骨架；策略取事务内最新值；不触碰剧本表
      await upsertWorkData(trx, projectId, "scriptAgent", {
        storySkeleton: artifact.content,
        adaptationStrategy: current.adaptationStrategy,
      });
    } else if (artifact.kind === "adaptationStrategy") {
      await upsertWorkData(trx, projectId, "scriptAgent", {
        storySkeleton: current.storySkeleton,
        adaptationStrategy: artifact.content,
      });
    } else {
      // script：只 upsert 本次结构化条目；骨架/策略保持事务内最新值
      await upsertWorkData(trx, projectId, "scriptAgent", {
        storySkeleton: current.storySkeleton,
        adaptationStrategy: current.adaptationStrategy,
      });
      for (const item of artifact.items) {
        const existing = current.script.find((s) => s.name === item.name);
        await upsertScriptItem(
          trx,
          projectId,
          existing?.id != null
            ? { id: existing.id, name: item.name, content: item.content }
            : { name: item.name, content: item.content },
        );
      }
    }

    // 与产物同事务：权威 mutation journal（sidecar 仅索引）
    await upsertPendingMutationJournalInTrx(trx, "scriptAgent");
  });

  return true;
}
