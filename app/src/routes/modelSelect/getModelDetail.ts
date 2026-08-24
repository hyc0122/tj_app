import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { buildNativeDreaminaVideoDetail } from "@/tianjiang/model-providers/native-provider-registry";
import { toSafeDreaminaSettingsError } from "@/tianjiang/model-providers/dreamina-cli/safe-settings-error";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    modelId: z.string(),
  }),
  async (req, res) => {
    const { modelId } = req.body;
    const { awaitSettingsDependentRead } = await import("@/tianjiang/sync/profile-settings-adapter");
    await awaitSettingsDependentRead();
    if (String(modelId).startsWith("dreamina-cli:")) {
      const detail = buildNativeDreaminaVideoDetail(String(modelId));
      if (!detail) {
        return res.status(400).send({
          code: "DREAMINA_CLI_MODEL_UNSUPPORTED",
          message: "当前即梦模型不支持",
        });
      }
      return res.status(200).send(success(detail));
    }
    try {
      const [id, name] = modelId.split(/:(.+)/);
      const models = await u.vendor.getModelList(id);
      const findData = models.find((i: { modelName?: string }) => i.modelName == name);
      res.status(200).send(success(findData));
    } catch (err) {
      const safe = toSafeDreaminaSettingsError(err, "DREAMINA_CLI_GET_STATUS_FAILED", "读取模型详情失败");
      return res.status(safe.status).send({ code: safe.code, message: safe.message });
    }
  },
);
