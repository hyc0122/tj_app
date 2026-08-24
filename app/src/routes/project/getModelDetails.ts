import express from "express";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    key: z.enum(["scriptAgent", "productionAgent"]),
  }),
  async (req, res) => {
    const { key } = req.body;
    // Agent 部署配置与供应商模型列表均属账号级，项目 ALS 下不得读空白种子
    const { getAccountAgentDeployRow, getAccountVendorModelList } = await import(
      "@/utils/account-model-resolver"
    );
    const data = await getAccountAgentDeployRow(key);
    const [id, modelName] = data?.modelName ? data.modelName.split(/:(.+)/) : [];
    if (!id || !modelName) return res.status(400).send(error("未找到模型"));
    const models = await getAccountVendorModelList(id);
    const model = models.find((m) => m.modelName === modelName);
    if (!model) return res.status(400).send(error("未找到模型"));
    res.status(200).send(success(model));
  },
);
