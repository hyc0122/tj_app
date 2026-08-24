import express from "express";
import u from "@/utils";
import { success, error } from "@/lib/responseFormat";

const router = express.Router();

export default router.post("/", async (req, res) => {
  const { awaitSettingsDependentRead } = await import("@/tianjiang/sync/profile-settings-adapter");
  await awaitSettingsDependentRead();
  const list = await u.accountDb("o_prompt").select("*");
  const data = await Promise.all(
    list.map(async (item) => {
      return {
        ...item,
        data: item.useData ? item.useData : item.data,
      };
    }),
  );
  res.status(200).send(success(data));
});
