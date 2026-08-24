import express from "express";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import { z } from "zod";
import {
  deleteVendorModelFromState,
  parseVendorModelsState,
  serializeVendorModelsState,
} from "@/utils/vendor-models-store";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.string(),
    modelName: z.string(),
  }),
  async (req, res) => {
    const { id, modelName } = req.body;

    // 仅按当前账号 db 行 + 精确 modelName 删除；不改 inputValues/enable。
    const row = await u.accountDb("o_vendorConfig").where("id", id).first("models", "inputValues");
    if (!row) {
      return res.status(400).send(error("模型不存在或已删除"));
    }

    let templateModels: Array<{ modelName: string }> = [];
    try {
      templateModels = u.vendor.getTemplateModels(id);
    } catch {
      templateModels = [];
    }

    const state = parseVendorModelsState(row.models);
    const result = deleteVendorModelFromState(templateModels, state, modelName);
    if (!result.ok) {
      // 产品规则：可见列表外一律「不存在或已删除」，禁止「基本模型不允许删除」。
      return res.status(400).send(error(result.message));
    }

    const { afterVendorConfigWrite, commitVendorConfigMutation } = await import("@/tianjiang/sync/profile-settings-adapter");
    await commitVendorConfigMutation(u.accountDb, { op: "upsert", id }, async (trx) => {
      await trx("o_vendorConfig")
        .where("id", id)
        .update({
          models: serializeVendorModelsState(result.state),
        });
    });
    await afterVendorConfigWrite({ op: "upsert", id });
    res.status(200).send(success("更新成功"));
  },
);
