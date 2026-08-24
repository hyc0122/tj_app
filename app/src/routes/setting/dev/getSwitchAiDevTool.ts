import express from "express";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";

const router = express.Router();

export default router.get("/", async (_req, res) => {
    const { awaitSettingsDependentRead } = await import("@/tianjiang/sync/profile-settings-adapter");
    await awaitSettingsDependentRead();
    const switchAiDevTool = await u.accountDb("o_setting").where("key", "switchAiDevTool").first();
    res.status(200).send(success(switchAiDevTool?.value || "0"));
});
