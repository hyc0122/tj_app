import express from "express";
import u from "@/utils";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { stat } from "original-fs";
import { decodeTransientMedia } from "@/tianjiang/media/transient-media";
const router = express.Router();

// 保存资产图片
export default router.post(
  "/",
  validateFields({
    id: z.number(),
    projectId: z.number(),
    base64: z.string().optional().nullable(),
    type: z.enum(["role", "scene", "tool"]),
    prompt: z.string().optional().nullable(),
    imageId: z.number().optional().nullable(),
  }),
  async (req, res) => {
    const { id, base64, type, prompt, projectId, imageId } = req.body;
    if (base64) {
      const media = decodeTransientMedia(base64, "image");
      // 生成新的图片路径
      const savePath = `/${projectId}/${type}/${uuidv4()}.${media.extension}`;
      // 写入文件
      await u.oss.writeFile(savePath, media.bytes);
      // 插入图片表
      const [idData] = await u.db("o_image").insert({
        assetsId: id,
        filePath: savePath,
        type: type,
        state: "已完成",
      });
      // 更新资产表图片为新图片
      await u
        .db("o_assets")
        .where("id", id)
        .update({
          prompt: prompt ?? "",
          imageId: idData,
        });
    } else {
      await u
        .db("o_assets")
        .where("id", id)
        .update({
          prompt: prompt ?? "",
          imageId: imageId,
        });
    }
    res.status(200).send(success({ message: "保存资产图片成功" }));
  },
);
