import express from "express";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import { z } from "zod";
import { transform } from "sucrase";
import {
  loadVendorPrivateInputs,
  sanitizeVendorSourceSecrets,
} from "@/utils/vendor-private-config";
import {
  assertSafeVendorId,
  assertVendorSourceSize,
  sanitizeVendorRouteError,
} from "@/utils/vendor-source-path";
const router = express.Router();

const vendorConfigSchema = z.object({
  id: z.string(),
  author: z.string(),
  description: z.string().optional(),
  name: z.string(),
  icon: z.string().optional(),
  inputs: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      type: z.enum(["text", "password", "url"]),
      required: z.boolean(),
      placeholder: z.string().optional(),
    }),
  ),
  inputValues: z.record(z.string(), z.string()),
  models: z.array(
    z.discriminatedUnion("type", [
      z.object({
        name: z.string(),
        modelName: z.string(),
        type: z.literal("text"),
        think: z.boolean(),
      }),
      z.object({
        name: z.string(),
        modelName: z.string(),
        type: z.literal("image"),
        mode: z.array(z.enum(["text", "singleImage", "multiReference"])),
      }),
      z.object({
        name: z.string(),
        modelName: z.string(),
        type: z.literal("video"),
        mode: z.array(
          z.union([
            z.enum(["singleImage", "startEndRequired", "endFrameOptional", "startFrameOptional", "text", "audioReference", "videoReference"]),
            z.array(z.string().regex(/^(videoReference|imageReference|audioReference):\d+$/)),
          ]),
        ),
        audio: z.union([z.literal("optional"), z.boolean()]),
        durationResolutionMap: z.array(
          z.object({
            duration: z.array(z.number()),
            resolution: z.array(z.string()),
          }),
        ),
      }),
    ]),
  ),
});

export default router.post(
  "/",
  validateFields({
    id: z.string(),
    tsCode: z.string(),
  }),
  async (req, res) => {
    try {
      const id = assertSafeVendorId(req.body.id);
      const tsCode = String(req.body.tsCode ?? "");
      // 与 getVendorCode 共用大小上限，拒绝超大写盘。
      assertVendorSourceSize(tsCode);
      const exists = await u.accountDb("o_vendorConfig").where("id", id).select("id").first();
      if (!exists) return res.status(404).send(error("未找到该供应商配置"));
      const jsCode = transform(tsCode, { transforms: ["typescript"] }).code;
      const exports = u.vm(jsCode);
      if (!exports) return res.status(400).send(success("脚本文件必须导出对象"));
      if (!exports.textRequest) return res.status(400).send(success("脚本文件必须导出文本请求对象"));
      if (!exports.imageRequest) return res.status(400).send(success("脚本文件必须导出图像请求对象"));
      if (!exports.videoRequest) return res.status(400).send(success("脚本文件必须导出视频请求对象"));
      if (!exports.vendor) return res.status(400).send(success("脚本文件必须导出vendor对象"));
      const vendor = exports.vendor;
      const result = vendorConfigSchema.safeParse(vendor);
      if (!result.success) {
        const errorMsg = result.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
        return res.status(400).send(error(`vendor配置校验失败: ${errorMsg}`));
      }
      const currentInputs = await loadVendorPrivateInputs(id);
      const mergedInputs = { ...currentInputs };
      for (const [key, value] of Object.entries(vendor.inputValues ?? {})) {
        // 源码中的非空值可作为一次性导入，空占位不得意外清掉设置页现有密钥。
        if (typeof value === "string" && value.length > 0) mergedInputs[key] = value;
      }
      await u
        .accountDb("o_vendorConfig")
        .where("id", id)
        .update({
          models: JSON.stringify(vendor.models ?? []),
          inputValues: JSON.stringify(mergedInputs),
        });
      u.vendor.writeCode(
        id,
        sanitizeVendorSourceSecrets(tsCode, vendor.inputs, mergedInputs),
      );
      const { afterAccountSettingsWrite } = await import("@/tianjiang/sync/profile-settings-adapter");
      await afterAccountSettingsWrite();

      const { inputValues: _privateInputs, ...publicVendor } = result.data;
      res.status(200).send(success(publicVendor));
    } catch (err) {
      // 编译器异常可能携带源码片段，响应与日志都不能回显潜在密钥。
      res.status(400).send(error(
        sanitizeVendorRouteError(err, "供应商代码无效或无法安全保存"),
      ));
    }
  },
);
