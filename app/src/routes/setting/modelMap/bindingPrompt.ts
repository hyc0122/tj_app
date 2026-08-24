import express from "express";
import { error, success } from "@/lib/responseFormat";
import u from "@/utils";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    vendorId: z.string(),
    model: z.string(),
    path: z.string(),
    fileName: z.string(),
  }),
  async (req, res) => {
    const { vendorId, model, path, fileName } = req.body;
    const data = await u.accountDb("o_modelPrompt").where("model", model).andWhere("vendorId", vendorId).select("*").first();
    if (data) {
      await u.accountDb("o_modelPrompt").where("model", model).andWhere("vendorId", vendorId).update({ fileName, path });
    } else {
      await u.accountDb("o_modelPrompt").insert({ vendorId, model, path, fileName });
    }
    const { afterAccountSettingsWrite } = await import("@/tianjiang/sync/profile-settings-adapter");
    await afterAccountSettingsWrite();
    res.status(200).send(success("绑定成功"));
  },
);
