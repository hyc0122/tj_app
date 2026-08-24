import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { db } from "@/utils/db";
import oss from "@/utils/oss";
import { buildRelatedAudioDtos, loadBoundRoleAudioInputs } from "@/tianjiang/storyboard/related-audio-dto";
import { currentUserStorage } from "@/tianjiang/runtime/user-storage-context";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    type: z.array(z.string()).optional(),
  }),
  async (req, res) => {
    const { projectId, type } = req.body;
    const data = await db("o_assets")
      .leftJoin("o_image", "o_assets.imageId", "o_image.id")
      .select(
        "o_assets.*",
        "o_image.filePath",
        "o_image.state",
        "o_image.model",
        "o_image.resolution",
        "o_image.errorReason",
        "o_image.id as imageId",
      )
      .where("o_assets.projectId", projectId)
      .andWhere("o_assets.type", "<>", "clip")
      .andWhere("o_assets.type", "<>", "audio")
      .andWhere("o_assets.assetsId", null)
      .modify((qb) => {
        if (type && type.length > 0) qb.whereIn("o_assets.type", type);
      })
      .orderByRaw(`CASE o_assets.type WHEN 'role' THEN 1 WHEN 'scene' THEN 2 WHEN 'tool' THEN 3 ELSE 4 END`);
    const roleIds = data.map((item: { id?: number }) => Number(item.id)).filter((id: number) => Number.isInteger(id) && id > 0);
    // 中文注释：父音频可能没有 imageId，必须经子资产再取 o_image.filePath。
    const repleAssets = await loadBoundRoleAudioInputs(db, roleIds);
    const projectUuid = currentUserStorage()?.projectUuid ?? "";
    const result = await Promise.all(
      data.map(async (parent: any) => {
        const historyImages = await db("o_image").where("assetsId", parent.id).andWhere("state", "已完成").select("id", "filePath");
        const historyImagesWithUrl = await Promise.all(
          historyImages.map(async (img: any) => ({
            id: img.id,
            filePath: img.filePath && (await oss.getSmallImageUrl(img.filePath)),
          })),
        );
        return {
          ...parent,
          filePath: parent.filePath && (await oss.getSmallImageUrl(parent.filePath!)),
          historyImages: historyImagesWithUrl,
          relepedAudio: await buildRelatedAudioDtos(repleAssets[parent.id] ?? [], {
            projectUuid,
            getFileUrl: (logicalPath) => oss.getFileUrl(logicalPath),
          }),
        };
      }),
    );
    res.status(200).send(success(result));
  },
);
