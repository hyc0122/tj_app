import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number(),
  }),
  async (req, res) => {
    const { id, data } = req.body;
    await u.accountDb("o_prompt").where("id", id).update({
      useData: data,
    });
    const { notifyAccountSettingsMutated } = await import("@/tianjiang/sync/profile-settings-adapter");
    await notifyAccountSettingsMutated();
    res.status(200).send(success(123));
  },
);
