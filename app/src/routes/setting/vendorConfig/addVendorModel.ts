import express from "express";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import {
  parseVendorModelsState,
  serializeVendorModelsState,
  upsertCustomVendorModel,
} from "@/utils/vendor-models-store";
import { z } from "zod";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.string(),
    model: z.discriminatedUnion("type", [
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
  }),
  async (req, res) => {
    const { id, model } = req.body;

    const models = await u.accountDb("o_vendorConfig").where("id", id).first("models");
    const { afterVendorConfigWrite, commitVendorConfigMutation } = await import("@/tianjiang/sync/profile-settings-adapter");
    await commitVendorConfigMutation(u.accountDb, { op: "upsert", id }, async (trx) => {
      if (models) {
        // 写入自定义并取消同名 excluded，避免「删后再加」仍被排除。
        const next = upsertCustomVendorModel(parseVendorModelsState(models.models), model);
        await trx("o_vendorConfig")
          .where("id", id)
          .update({
            models: serializeVendorModelsState(next),
          });
      }
    });
    await afterVendorConfigWrite({ op: "upsert", id });
    res.status(200).send(success("更新成功"));
  },
);
