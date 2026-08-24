import express from "express";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import { z } from "zod";
const router = express.Router();
export default router.post(
  "/",
  validateFields({
    id: z.string(),
    enable: z.number(),
  }),
  async (req, res) => {
    const { id, enable } = req.body;
    const { afterVendorConfigWrite, commitVendorConfigMutation } = await import("@/tianjiang/sync/profile-settings-adapter");
    await commitVendorConfigMutation(u.accountDb, { op: "upsert", id }, async (trx) => {
      await trx("o_vendorConfig").where("id", id).update({ enable });
    });
    await afterVendorConfigWrite({ op: "upsert", id });
    res.status(200).send(success("更新成功"));
  },
);
