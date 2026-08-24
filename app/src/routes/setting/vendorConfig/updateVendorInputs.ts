import express from "express";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import { z } from "zod";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.string(),
    inputValues: z.record(z.string(), z.string()),
  }),
  async (req, res) => {
    const { id, inputValues } = req.body;
    const exists = await u.accountDb("o_vendorConfig").where("id", id).first("id");
    if (!exists) return res.status(404).send({ code: 404, message: "供应商不存在" });

    // 最新产品决定允许当前账号隔离的本机 db2 明文保存供应商密钥。
    const { afterVendorConfigWrite, commitVendorConfigMutation } = await import("@/tianjiang/sync/profile-settings-adapter");
    await commitVendorConfigMutation(u.accountDb, { op: "upsert", id }, async (trx) => {
      await trx("o_vendorConfig")
        .where("id", id)
        .update({
          inputValues: JSON.stringify(inputValues),
        });
    });
    await afterVendorConfigWrite({ op: "upsert", id });
    res.status(200).send(success("更新成功"));
  },
);
