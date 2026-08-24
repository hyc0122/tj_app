import express from "express";
import u from "@/utils";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { decodeTransientMedia } from "@/tianjiang/media/transient-media";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    name: z.string(),
    fileUrl: z.string(),
    prompt: z.string(),
  }),
  async (req, res) => {
    const { name, fileUrl, prompt } = req.body;
    const media = decodeTransientMedia(fileUrl, "image");
    const imagePath = `/artStyle/${uuidv4()}.${media.extension}`;
    await u.oss.writeFile(imagePath, media.bytes);
    await u.db("o_artStyle").insert({
      name,
      fileUrl: imagePath,
      label: name,
      prompt,
    });
    res.status(200).send(success("艺术风格添加成功"));
  },
);
