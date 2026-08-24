import express from "express";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";

const router = express.Router();

export default router.get("/", async (_req, res) => {
  const { awaitSettingsDependentRead } = await import("@/tianjiang/sync/profile-settings-adapter");
  await awaitSettingsDependentRead();
  const useMode = await u.accountDb("o_setting").where("key", "agentUseMode").first();
  res.status(200).send(success(useMode?.value || "0"));
});
