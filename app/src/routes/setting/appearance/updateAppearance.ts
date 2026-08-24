import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { accountDatabase } from "@/utils/db";
import { notifyAccountSettingsMutated } from "@/tianjiang/sync/profile-settings-adapter";

const router = express.Router();

async function upsert(key: string, value: string): Promise<void> {
  const db = accountDatabase();
  const exists = await db("o_setting").where({ key }).first();
  if (exists) await db("o_setting").where({ key }).update({ value });
  else await db("o_setting").insert({ key, value });
}

export default router.post(
  "/",
  validateFields({
    theme: z.object({
      mode: z.enum(["auto", "light", "dark", "cyberpunk"]),
      primaryColor: z.string().min(1).max(32),
      fontSize: z.number().min(10).max(32),
    }),
    language: z.string().min(2).max(16),
  }),
  async (req, res) => {
    await upsert("theme", JSON.stringify(req.body.theme));
    await upsert("language", String(req.body.language));
    await notifyAccountSettingsMutated();
    res.status(200).send(success({ ok: true }));
  },
);
