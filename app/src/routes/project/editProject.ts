import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

/** 本地项目主键：正安全整数，拒绝字符串 id 规避。 */
const projectIdSchema = z
  .number()
  .int()
  .positive()
  .refine((value) => Number.isSafeInteger(value), { message: "必须是安全整数" });

// 写入/更新本地 o_project 完整业务字段（中央创建后的本地初始化与编辑共用）
export default router.post(
  "/",
  validateFields({
    id: projectIdSchema,
    name: z.string(),
    intro: z.string(),
    type: z.string(),
    artStyle: z.string(),
    directorManual: z.string(),
    videoRatio: z.string(),
    imageModel: z.string(),
    videoModel: z.string(),
    projectType: z.string(),
    imageQuality: z.string(),
    mode: z.string(),
  }),
  async (req, res) => {
    const {
      id,
      name,
      intro,
      type,
      artStyle,
      videoRatio,
      directorManual,
      imageModel,
      videoModel,
      imageQuality,
      projectType,
      mode,
    } = req.body;

    await u.db("o_project").where("id", id).update({
      name,
      intro,
      type,
      artStyle,
      videoRatio,
      directorManual,
      imageModel,
      videoModel,
      imageQuality,
      projectType,
      mode,
    });

    res.status(200).send(success({ message: "编辑项目成功" }));
  },
);
