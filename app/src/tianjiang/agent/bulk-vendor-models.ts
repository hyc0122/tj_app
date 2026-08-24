/**
 * 一键配置：在账号库事务内列举供应商模型候选。
 * 所有 SQL 必须使用传入的 trx；模板合并只读文件系统，禁止 accountDb / getModelList。
 */
import {
  type KnexLike,
  type VendorModelCandidate,
} from "@/tianjiang/agent/bulk-agent-config";
import { buildMergedVendorModelList } from "@/utils/vendor";

/**
 * 在给定 Knex/事务连接上枚举供应商模型（模板 − excluded + custom）。
 * 与历史 getModelList 语义对齐，但绝不二次申请连接池连接。
 */
export async function listEnabledVendorModelsForBulk(
  db: KnexLike,
): Promise<VendorModelCandidate[]> {
  const rows = (await db("o_vendorConfig").select(
    "id",
    "enable",
    "models",
  )) as Array<{
    id?: unknown;
    enable?: unknown;
    models?: unknown;
  }>;

  const out: VendorModelCandidate[] = [];
  for (const row of rows) {
    const vendorId = String(row.id ?? "").trim();
    if (!vendorId) continue;
    const enable = row.enable === 1 || row.enable === true;
    const modelsRaw =
      row.models == null ? "" : typeof row.models === "string" ? row.models : String(row.models);
    // 仅 FS 模板 + 本行 models 列；禁止 u.vendor.getModelList / accountDb
    const models = buildMergedVendorModelList(vendorId, modelsRaw);
    for (const m of models) {
      const modelName = String(m?.modelName ?? "").trim();
      if (!modelName) continue;
      out.push({
        vendorId,
        vendorName: vendorId,
        model: String(m?.name ?? modelName),
        modelName,
        type: String(m?.type ?? "text"),
        enable,
      });
    }
  }
  return out;
}
