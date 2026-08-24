import express from "express";
import { success } from "@/lib/responseFormat";
import { accountDatabase } from "@/utils/db";

const router = express.Router();

export default router.get("/", async (_req, res) => {
  const { awaitSettingsDependentRead } = await import("@/tianjiang/sync/profile-settings-adapter");
  await awaitSettingsDependentRead();
  const db = accountDatabase();
  const themeRow = await db("o_setting").where({ key: "theme" }).first();
  const languageRow = await db("o_setting").where({ key: "language" }).first();
  let theme = { mode: "cyberpunk", primaryColor: "#A855F7", fontSize: 16 };
  if (typeof themeRow?.value === "string") {
    try {
      theme = { ...theme, ...JSON.parse(themeRow.value) };
    } catch {
      // 损坏主题回退默认值，禁止把半截 JSON 当成功。
    }
  }
  res.status(200).send(success({
    theme,
    language: typeof languageRow?.value === "string" ? languageRow.value : "zh-CN",
  }));
});
