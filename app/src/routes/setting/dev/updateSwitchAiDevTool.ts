import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    switchAiDevTool: z.string(),
  }),
  async (req, res) => {
    const { switchAiDevTool } = req.body;
    const exists = await u.accountDb("o_setting").where("key", "switchAiDevTool").first();
    if (exists) {
      await u.accountDb("o_setting").where("key", "switchAiDevTool").update({
        value: switchAiDevTool,
      });
    } else {
      await u.accountDb("o_setting").insert({ key: "switchAiDevTool", value: switchAiDevTool });
    }
    res.status(200).send(success("保存设置成功"));
  },
);
