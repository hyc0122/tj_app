/**
 * 账号级「一键配置全部 Agent」纯逻辑：
 * - 目标部署键由服务端按库内数据与键规则计算，禁止信任前端提交的部署 id/名称/数量。
 * - 仅更新 vendorId / model / modelName，保留 temperature、maxOutputTokens 等独立参数。
 * - 永不写入 ttsDubbing；禁用部署项一律排除。
 * - 简易/高级键集合必须与 tianjiang/model/deployment-keys 冻结注册表同源。
 */

import {
  ADVANCED_DEPLOYMENT_KEYS,
  SIMPLE_DEPLOYMENT_KEYS,
} from "@/tianjiang/model/deployment-keys";

export type AgentBulkMode = "simple" | "advanced";

export interface AgentDeployRow {
  id: number;
  key: string;
  name?: string | null;
  model?: string | null;
  modelName?: string | null;
  vendorId?: string | null;
  disabled?: boolean | number | null;
  temperature?: number | null;
  maxOutputTokens?: number | null;
}

export interface VendorModelCandidate {
  vendorId: string;
  /** 供应商显示名（可选，仅用于摘要） */
  vendorName?: string;
  /** 模型展示名（写入 o_agentDeploy.model） */
  model: string;
  /** 模型机器名（写入 o_agentDeploy.modelName 的后缀） */
  modelName: string;
  type: string;
  enable: boolean | number;
}

export interface BulkAgentConfigInput {
  mode: AgentBulkMode;
  vendorId: string;
  /** 机器模型名；展示名由候选列表服务端计算，禁止客户端提交 model/modelLabel */
  modelName: string;
}

export interface BulkAgentConfigResult {
  updatedCount: number;
  keys: string[];
  vendorId: string;
  model: string;
  modelName: string;
  /** 写入 modelName 列的完整值：vendorId:modelName */
  storedModelName: string;
}

export class BulkAgentConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BulkAgentConfigError";
    this.code = code;
  }
}

/**
 * 简易模式父级部署键：冻结 SIMPLE 注册表去掉永不批量写入的 ttsDubbing。
 * 与 UI 主列表 / Ai.Text 解析器共用同一来源。
 */
export const SIMPLE_AGENT_KEYS = SIMPLE_DEPLOYMENT_KEYS.filter(
  (key) => key !== "ttsDubbing",
) as readonly string[];

/** 永不批量写入的部署键。 */
export const EXCLUDED_BULK_KEYS = new Set(["ttsDubbing"]);

export function isTruthyDisabled(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

/**
 * 根据模式与库内行计算目标部署键（服务端权威）。
 * 简易：SIMPLE_DEPLOYMENT_KEYS \ ttsDubbing（未禁用且存在）
 * 高级：universalAi + ADVANCED_DEPLOYMENT_KEYS 中启用项（按注册表顺序）
 */
export function resolveBulkTargetKeys(
  mode: AgentBulkMode,
  rows: ReadonlyArray<AgentDeployRow>,
): string[] {
  if (mode !== "simple" && mode !== "advanced") {
    throw new BulkAgentConfigError("INVALID_MODE", "配置模式无效");
  }
  const byKey = new Map<string, AgentDeployRow>();
  for (const row of rows) {
    const key = String(row.key ?? "").trim();
    if (!key) continue;
    byKey.set(key, row);
  }

  const pick = (key: string): boolean => {
    if (EXCLUDED_BULK_KEYS.has(key)) return false;
    const row = byKey.get(key);
    if (!row) return false;
    if (isTruthyDisabled(row.disabled)) return false;
    return true;
  };

  if (mode === "simple") {
    return SIMPLE_AGENT_KEYS.filter((key) => pick(key));
  }

  // 高级：universalAi 优先，再按冻结 ADVANCED 注册表顺序（不扫库内未知键）。
  const advanced: string[] = [];
  if (pick("universalAi")) advanced.push("universalAi");
  for (const key of ADVANCED_DEPLOYMENT_KEYS) {
    if (pick(key)) advanced.push(key);
  }
  return advanced;
}

/**
 * 校验供应商已启用且模型存在且类型为 text。
 * 展示名（model）只来自候选项 hit.model，禁止采用客户端任意 modelLabel。
 */
export function resolveTextModelForBulk(
  candidates: ReadonlyArray<VendorModelCandidate>,
  vendorId: string,
  modelName: string,
): {
  vendorId: string;
  vendorName: string;
  model: string;
  modelName: string;
  storedModelName: string;
} {
  const vid = String(vendorId ?? "").trim();
  const mid = String(modelName ?? "").trim();
  if (!vid || !mid) {
    throw new BulkAgentConfigError("MODEL_REQUIRED", "请选择可用的文本模型");
  }

  const enabledVendor = candidates.some(
    (c) => c.vendorId === vid && (c.enable === true || c.enable === 1),
  );
  if (!enabledVendor) {
    throw new BulkAgentConfigError("VENDOR_DISABLED", "供应商未启用或不可用");
  }

  const hit = candidates.find(
    (c) =>
      c.vendorId === vid
      && c.modelName === mid
      && (c.enable === true || c.enable === 1),
  );
  if (!hit) {
    throw new BulkAgentConfigError("MODEL_NOT_FOUND", "所选模型不存在或已被删除");
  }
  if (String(hit.type ?? "").toLowerCase() !== "text") {
    throw new BulkAgentConfigError("MODEL_NOT_TEXT", "只能选择文本类型模型");
  }

  // 仅用服务端候选展示名
  const model = String(hit.model ?? mid).trim() || mid;
  return {
    vendorId: vid,
    vendorName: String(hit.vendorName ?? vid),
    model,
    modelName: mid,
    storedModelName: `${vid}:${mid}`,
  };
}

/**
 * 在已验证模型后，计算将要更新的行补丁（仅 vendorId/model/modelName）。
 * 不修改 temperature / maxOutputTokens / disabled / name / desc。
 */
export function buildBulkUpdatePatches(
  rows: ReadonlyArray<AgentDeployRow>,
  targetKeys: ReadonlyArray<string>,
  model: { vendorId: string; model: string; storedModelName: string },
): Array<{ id: number; key: string; vendorId: string; model: string; modelName: string }> {
  const keySet = new Set(targetKeys);
  const patches: Array<{
    id: number;
    key: string;
    vendorId: string;
    model: string;
    modelName: string;
  }> = [];
  for (const row of rows) {
    const key = String(row.key ?? "");
    if (!keySet.has(key)) continue;
    if (EXCLUDED_BULK_KEYS.has(key)) continue;
    if (isTruthyDisabled(row.disabled)) continue;
    if (!Number.isSafeInteger(row.id) || row.id <= 0) {
      throw new BulkAgentConfigError("DEPLOY_INVALID", "部署项数据无效");
    }
    patches.push({
      id: row.id,
      key,
      vendorId: model.vendorId,
      model: model.model,
      modelName: model.storedModelName,
    });
  }
  if (patches.length === 0) {
    throw new BulkAgentConfigError("NO_TARGETS", "没有可配置的 Agent 部署项");
  }
  return patches;
}

/** 将错误归一化为安全中文，禁止路径/密钥/SQL/堆栈泄漏。 */
export function safeBulkAgentErrorMessage(error: unknown): string {
  if (error instanceof BulkAgentConfigError) return error.message;
  if (error instanceof Error) {
    const msg = error.message.replace(/\s+/g, " ").trim();
    if (
      !msg
      || /[A-Za-z]:[\\/]|\\\\|\/(?:users|home|var|tmp|etc)\b|https?:\/\/|bearer\b|api[_ -]?key|secret\b|token\b|stack\b|select\s+|insert\s+|update\s+|delete\s+|sqlite/i
        .test(msg)
    ) {
      return "批量配置 Agent 失败，请稍后重试";
    }
    if (/[\u3400-\u9fff]/.test(msg)) return msg.slice(0, 160);
  }
  return "批量配置 Agent 失败，请稍后重试";
}

export type KnexLike = {
  <T extends object = any>(table: string): {
    select: (...args: any[]) => any;
    where: (...args: any[]) => any;
    update: (data: Record<string, unknown>) => Promise<number> | number;
    first: () => Promise<any>;
  };
  transaction: <T>(fn: (trx: KnexLike) => Promise<T>) => Promise<T>;
};

/**
 * 在事务内执行批量配置：供应商/模型校验、部署目标查询与更新处于同一事务快照。
 * db 必须是账号 db2（accountDatabase），禁止项目库。
 * 并发删除/禁用模型时 resolve 失败 → 整体回滚。
 */
export async function executeBulkAgentConfig(
  db: KnexLike,
  input: BulkAgentConfigInput,
  options: {
    /** 在事务内列举供应商模型（传入 trx） */
    listVendorModels: (trx: KnexLike) => Promise<VendorModelCandidate[]>;
  },
): Promise<BulkAgentConfigResult> {
  const mode = input.mode;
  if (mode !== "simple" && mode !== "advanced") {
    throw new BulkAgentConfigError("INVALID_MODE", "配置模式无效");
  }

  return db.transaction(async (trx) => {
    // 同一事务内：读部署行 → 再列举模型（捕获并发删除/禁用）→ 校验 → 写回。
    // 任一步失败则整事务回滚，禁止采用客户端 model/modelLabel。
    const rows = (await trx("o_agentDeploy").select(
      "id",
      "key",
      "name",
      "model",
      "modelName",
      "vendorId",
      "disabled",
      "temperature",
      "maxOutputTokens",
    )) as AgentDeployRow[];

    const candidates = await options.listVendorModels(trx);
    const resolved = resolveTextModelForBulk(
      candidates,
      input.vendorId,
      input.modelName,
    );

    const targetKeys = resolveBulkTargetKeys(mode, rows);
    const patches = buildBulkUpdatePatches(rows, targetKeys, {
      vendorId: resolved.vendorId,
      model: resolved.model,
      storedModelName: resolved.storedModelName,
    });

    for (const patch of patches) {
      await trx("o_agentDeploy").where({ id: patch.id }).update({
        vendorId: patch.vendorId,
        model: patch.model,
        modelName: patch.modelName,
      });
    }

    return {
      updatedCount: patches.length,
      keys: patches.map((p) => p.key),
      vendorId: resolved.vendorId,
      model: resolved.model,
      modelName: resolved.modelName,
      storedModelName: resolved.storedModelName,
    };
  });
}
