import express from "express";
import { success } from "@/lib/responseFormat";
import fg from "fast-glob";
import fs from "fs/promises";
import path from "path";
import { accountModelPromptRoot } from "@/tianjiang/prompts/account-model-prompt";
const router = express.Router();

export default router.get("/", async (_req, res) => {
  const { awaitSettingsDependentRead } = await import("@/tianjiang/sync/profile-settings-adapter");
  await awaitSettingsDependentRead();
  const modelPromptRoot = accountModelPromptRoot();

  const entries = await fg("**/*.md", {
    cwd: modelPromptRoot.replace(/\\/g, "/"),
    onlyFiles: true,
  });

  const result = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(modelPromptRoot, entry);
      const content = await fs.readFile(fullPath, "utf-8");
      const name = path.basename(entry, ".md");
      const type = entry.includes("/") ? entry.split("/")[0] : "";
      return { path: entry.replace(/\\/g, "/"), name, type, data: content };
    }),
  );

  res.status(200).send(success(result));
});
