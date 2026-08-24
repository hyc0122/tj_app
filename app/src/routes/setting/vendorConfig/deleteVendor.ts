import express from "express";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import fs from "fs";
import u from "@/utils";
import { z } from "zod";
import {
  assertSafeVendorId,
  resolveVendorSourceFile,
  sanitizeVendorRouteError,
} from "@/utils/vendor-source-path";

const router = express.Router();
export default router.post(
  "/",
  validateFields({
    id: z.string(),
  }),
  async (req, res) => {
    try {
      // 中文注释：先校验 ID 再删库与源码，防止路径逃逸。
      const id = assertSafeVendorId(req.body.id);
      const { afterVendorConfigWrite, commitVendorConfigMutation } = await import("@/tianjiang/sync/profile-settings-adapter");
      await commitVendorConfigMutation(u.accountDb, { op: "delete", id }, async (trx) => {
        await trx("o_vendorConfig").where("id", id).del();
        await trx("o_agentDeploy").where("vendorId", id).update({
          model: null,
          vendorId: null,
        });
      });
      const target = resolveVendorSourceFile(u.getPath("vendor"), id);
      if (fs.existsSync(target)) fs.rmSync(target, { force: true });
      await afterVendorConfigWrite({ op: "delete", id });
      res.status(200).send(success("删除成功"));
    } catch (err) {
      res.status(400).send(error(sanitizeVendorRouteError(err, "删除供应商失败")));
    }
  },
);
