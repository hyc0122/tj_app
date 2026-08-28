import express from "express";
import { error, success } from "@/lib/responseFormat";

import u from "@/utils";
import { sanitizeVendorRouteError } from "@/utils/vendor-source-path";

const router = express.Router();

export default router.post("/", async (req, res) => {
  try {
    if (String(req.body?.id ?? "") !== "tianjiang") {
      return res.status(400).send(error("当前供应商不支持在线更新"));
    }
    const result = await u.vendor.checkRemoteVendorUpdate("tianjiang");
    res.status(200).send(success(result));
  } catch (err) {
    res.status(400).send(error(
      sanitizeVendorRouteError(err, "检查佳速配置更新失败，请稍后重试"),
    ));
  }
});
