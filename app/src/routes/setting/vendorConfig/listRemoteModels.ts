import express from "express";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import { z } from "zod";
import {
  assertSafeVendorId,
  sanitizeVendorRouteError,
} from "@/utils/vendor-source-path";

const router = express.Router();

export default router.post(
  "/",
  validateFields({ id: z.string().min(1).max(64) }),
  async (req, res) => {
    try {
      const id = assertSafeVendorId(req.body.id);
      const row = await u.accountDb("o_vendorConfig").where("id", id).select("id").first();
      if (!row) return res.status(404).send(error("未找到该供应商配置", null, 404));

      // API Key 只在本地后端注入沙盒；响应只包含模型公开元数据。
      const models = await u.vendor.listRemoteModels(id);
      return res.status(200).send(success({ models }));
    } catch (err) {
      return res.status(502).send(error(
        sanitizeVendorRouteError(err, "获取远端模型列表失败"),
        null,
        502,
      ));
    }
  },
);
