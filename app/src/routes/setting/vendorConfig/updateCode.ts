import express from "express";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";

import { applyVendorSourceUpdate } from "@/utils/vendor-source-update";
import { sanitizeVendorRouteError } from "@/utils/vendor-source-path";

const router = express.Router();

export default router.post(
  "/",
  validateFields({ id: z.string(), tsCode: z.string() }),
  async (req, res) => {
    try {
      const vendor = await applyVendorSourceUpdate(req.body.id, req.body.tsCode);
      res.status(200).send(success(vendor));
    } catch (err) {
      // 编译器异常可能携带源码片段，HTTP 响应不得回显下载源码或账号密钥。
      res.status(400).send(error(
        sanitizeVendorRouteError(err, "供应商代码无效或无法安全保存"),
      ));
    }
  },
);
