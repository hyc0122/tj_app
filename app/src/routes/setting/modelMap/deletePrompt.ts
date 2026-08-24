import express from "express";
import fs from "fs/promises";
import { z } from "zod";

import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import {
  ModelPromptPathError,
  assertSafeRelativePromptPath,
  resolveAccountModelPromptFile,
} from "@/tianjiang/prompts/account-model-prompt";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    path: z.string(),
  }),
  async (req, res) => {
    try {
      const relative = assertSafeRelativePromptPath(String(req.body.path ?? "").replace(/\\/g, "/"));
      const filePath = resolveAccountModelPromptFile({ relativePath: relative });
      try {
        await fs.access(filePath);
      } catch {
        return res.status(404).send(error("文件不存在"));
      }
      await fs.unlink(filePath);
      const { accountDatabase } = await import("@/utils/db");
      await accountDatabase()("o_modelPrompt").where({ path: relative }).del();
      await accountDatabase()("o_modelPrompt").where({ path: relative.replaceAll("/", "\\") }).del();
      const { afterAccountSettingsWrite } = await import("@/tianjiang/sync/profile-settings-adapter");
      await afterAccountSettingsWrite();
      res.status(200).send(success("删除成功"));
    } catch (err) {
      if (err instanceof ModelPromptPathError) return res.status(400).send(error(err.message));
      throw err;
    }
  },
);
