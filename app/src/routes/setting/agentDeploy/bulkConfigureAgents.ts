/**
 * 账号级一键配置全部 Agent 模型。
 * - 强制使用账号 db2（accountDatabase / u.accountDb），禁止项目 ALS 下的 u.db。
 * - 请求仅 mode + vendorId + modelName；展示名与目标键由服务端计算。
 * - 供应商/模型/部署读写在同一事务内完成，且事务内 SQL 全部走 trx（pool max=1 安全）。
 */
import express from "express";
import { z } from "zod";

import { success, error as errorResponse } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import {
  BulkAgentConfigError,
  executeBulkAgentConfig,
  safeBulkAgentErrorMessage,
  type BulkAgentConfigInput,
  type BulkAgentConfigResult,
  type KnexLike,
} from "@/tianjiang/agent/bulk-agent-config";
import { listEnabledVendorModelsForBulk } from "@/tianjiang/agent/bulk-vendor-models";
import { accountDatabase } from "@/utils/db";

const router = express.Router();

/**
 * 路由与行为测试共用的执行入口：调用方传入已解析的账号库连接。
 * 事务内 listVendorModels 固定使用 listEnabledVendorModelsForBulk(trx)。
 */
export async function executeBulkConfigureAgentsRequest(
  body: BulkAgentConfigInput,
  accountDb: KnexLike,
): Promise<BulkAgentConfigResult> {
  return executeBulkAgentConfig(
    accountDb,
    {
      mode: body.mode,
      vendorId: body.vendorId,
      modelName: body.modelName,
    },
    {
      listVendorModels: (trx) => listEnabledVendorModelsForBulk(trx),
    },
  );
}

export default router.post(
  "/",
  validateFields({
    mode: z.enum(["simple", "advanced"]),
    vendorId: z.string().min(1).max(128),
    modelName: z.string().min(1).max(256),
  }),
  async (req, res) => {
    try {
      // 显式账号库：即使当前请求落在项目 ALS，也不使用 u.db。
      const accountDb = accountDatabase();
      const result = await executeBulkConfigureAgentsRequest(
        {
          mode: req.body.mode,
          vendorId: req.body.vendorId,
          modelName: req.body.modelName,
        },
        accountDb as unknown as KnexLike,
      );
      res.status(200).send(
        success({
          updatedCount: result.updatedCount,
          keys: result.keys,
          vendorId: result.vendorId,
          model: result.model,
          modelName: result.modelName,
        }),
      );
    } catch (err) {
      const message = safeBulkAgentErrorMessage(err);
      // 中文注释：只有可预期的业务校验错误属于 400；数据库、文件系统等异常必须保留 500 语义。
      const status = err instanceof BulkAgentConfigError ? 400 : 500;
      res.status(status).send(errorResponse(message, null, status));
    }
  },
);
