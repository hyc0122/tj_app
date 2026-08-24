import express from "express";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    key: z.string().optional(),
  }),
  async (req, res) => {
    const { key } = req.body;
    const vendorConfigData = await u.accountDb("o_vendorConfig").where("id", "tianjiang").first();
    if (!vendorConfigData) return res.status(500).send(error("未找到该供应商配置"));
    if (!vendorConfigData.inputValues) return res.status(500).send(error("未找到模型配置数据"));
    const previousInputValues = JSON.parse(vendorConfigData.inputValues) as Record<string, string>;
    const inputValue = { ...previousInputValues };
    inputValue.apiKey = key ?? "";
    await u.accountDb("o_vendorConfig")
      .where("id", "tianjiang")
      .update({
        inputValues: JSON.stringify(inputValue),
      });
    try {
      const resText = await u.Ai.Text(`tianjiang:claude-haiku-4-5-20251001`).invoke({
        prompt: "1+1等于几？,请直接回答2，不要解释",
      });
      if (resText.text) {
        await u.accountDb("o_agentDeploy").where("key", "scriptAgent").update({
          model: "claude-sonnet-4-6",
          modelName: "tianjiang:claude-sonnet-4-6",
          vendorId: "tianjiang",
        });
        await u.accountDb("o_agentDeploy").where("key", "productionAgent").update({
          model: "claude-sonnet-4-6",
          modelName: "tianjiang:claude-sonnet-4-6",
          vendorId: "tianjiang",
        });
        await u.accountDb("o_agentDeploy").where("key", "universalAi").update({
          model: "claude-haiku-4-5",
          modelName: "tianjiang:claude-haiku-4-5-20251001",
          vendorId: "tianjiang",
        });
        const { afterAccountSettingsWrite } = await import("@/tianjiang/sync/profile-settings-adapter");
        await afterAccountSettingsWrite();
        res.status(200).send(success("一键填入成功"));
      }
    } catch {
      // 校验失败恢复原密钥，错误日志不得携带供应商请求或凭据。
      await u.accountDb("o_vendorConfig")
        .where("id", "tianjiang")
        .update({
          inputValues: JSON.stringify(previousInputValues),
        });
      res.status(400).send(error("KEY无效，请重新输入"));
    }
  },
);
