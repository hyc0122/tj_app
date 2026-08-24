/**
 * 单供应商源码读取：仅服务当前认证账号的设置页。
 * 不进入 getVendorList 批量响应；不上传中央、不同步团队。
 */
import express from "express";
import { success, error } from "@/lib/responseFormat";
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
  validateFields({
    id: z.string().min(1).max(64),
  }),
  async (req, res) => {
    try {
      // 中文注释：先校验 ID，再查当前账号 db2，最后读 data/vendor。
      const id = assertSafeVendorId(req.body.id);
      const { awaitSettingsDependentRead } = await import("@/tianjiang/sync/profile-settings-adapter");
      await awaitSettingsDependentRead();
      const row = await u.accountDb("o_vendorConfig").where("id", id).select("id").first();
      if (!row) {
        return res.status(404).send(error("未找到该供应商配置"));
      }
      const code = u.vendor.getCode(id);
      if (typeof code !== "string" || !code.trim()) {
        return res.status(404).send(error("供应商源码不存在或为空"));
      }
      // 成功响应只返回 id 与完整源码字符串。
      res.status(200).send(success({ id, code }));
    } catch (err) {
      // 禁止回显绝对路径、源码片段或密钥。
      res.status(400).send(error(sanitizeVendorRouteError(err, "供应商源码读取失败")));
    }
  },
);
