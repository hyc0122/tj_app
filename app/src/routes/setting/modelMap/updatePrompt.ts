import express from "express";
import fs from "fs/promises";
import { z } from "zod";

import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import {
  ModelPromptPathError,
  resolveAccountModelPromptFile,
} from "@/tianjiang/prompts/account-model-prompt";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    name: z.string().min(1),
    data: z.string(),
    type: z.enum(["image", "video"]),
  }),
  async (req, res) => {
    try {
      const { name, data, type } = req.body;
      const filePath = resolveAccountModelPromptFile({ type, name });
      try {
        await fs.access(filePath);
      } catch {
        return res.status(404).send(error("文件不存在"));
      }
      await fs.writeFile(filePath, data, "utf-8");
      const { afterAccountSettingsWrite } = await import("@/tianjiang/sync/profile-settings-adapter");
      await afterAccountSettingsWrite();
      res.status(200).send(success("更新成功"));
    } catch (err) {
      if (err instanceof ModelPromptPathError) return res.status(400).send(error(err.message));
      throw err;
    }
  },
);
