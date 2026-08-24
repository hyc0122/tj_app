import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    agentUseMode: z.string(),
  }),
  async (req, res) => {
    const { agentUseMode } = req.body;
    const exists = await u.accountDb("o_setting").where("key", "agentUseMode").first();
    if (exists) await u.accountDb("o_setting").where("key", "agentUseMode").update({ value: agentUseMode });
    else await u.accountDb("o_setting").insert({ key: "agentUseMode", value: agentUseMode });
    const { afterAccountSettingsWrite } = await import("@/tianjiang/sync/profile-settings-adapter");
    await afterAccountSettingsWrite();
    res.status(200).send(success("保存设置成功"));
  },
);
