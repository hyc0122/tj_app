import express from "express";
import { error, success } from "@/lib/responseFormat";

import u from "@/utils";
import { applyVendorSourceUpdate } from "@/utils/vendor-source-update";
import { sanitizeVendorRouteError } from "@/utils/vendor-source-path";

const router = express.Router();

export default router.post("/", async (req, res) => {
  try {
    if (String(req.body?.id ?? "") !== "tianjiang") {
      return res.status(400).send(error("当前供应商不支持在线更新"));
    }
    // 下载、哈希校验全部在模板沙盒中完成；只有校验通过的源码进入原子安装路径。
    const source = await u.vendor.downloadRemoteVendorUpdate("tianjiang");
    const vendor = await applyVendorSourceUpdate("tianjiang", source);
    res.status(200).send(success(vendor));
  } catch (err) {
    res.status(400).send(error(
      sanitizeVendorRouteError(err, "更新佳速配置失败，请稍后重试"),
    ));
  }
});
