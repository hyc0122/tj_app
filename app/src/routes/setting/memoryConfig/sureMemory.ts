import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 获取用户
export default router.post(
  "/",
  validateFields({
    messagesPerSummary: z.number(),
    shortTermLimit: z.number(),
    summaryMaxLength: z.number(),
    summaryLimit: z.number(),
    ragLimit: z.number(),
    deepRetrieveSummaryLimit: z.number(),
    modelOnnxFile: z.array(z.string()),
    modelDtype: z.string(),
  }),
  async (req, res) => {
    const { messagesPerSummary, shortTermLimit, summaryMaxLength, summaryLimit, ragLimit, deepRetrieveSummaryLimit, modelOnnxFile, modelDtype } =
      req.body;

    const upsert = async (key: string, value: string) => {
      const exists = await u.accountDb("o_setting").where("key", key).first();
      if (exists) {
        await u.accountDb("o_setting").where("key", key).update({ value });
      } else {
        await u.accountDb("o_setting").insert({ key, value });
      }
    };

    await upsert("messagesPerSummary", String(messagesPerSummary));
    await upsert("shortTermLimit", String(shortTermLimit));
    await upsert("summaryMaxLength", String(summaryMaxLength));
    await upsert("summaryLimit", String(summaryLimit));
    await upsert("ragLimit", String(ragLimit));
    await upsert("deepRetrieveSummaryLimit", String(deepRetrieveSummaryLimit));
    await upsert("modelOnnxFile", JSON.stringify(modelOnnxFile));
    await upsert("modelDtype", String(modelDtype));
    const { afterAccountSettingsWrite } = await import("@/tianjiang/sync/profile-settings-adapter");
    await afterAccountSettingsWrite();
    res.status(200).send(success("保存设置成功"));
  },
);
