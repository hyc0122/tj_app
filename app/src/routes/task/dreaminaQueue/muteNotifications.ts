import express from "express";

import { error, success } from "@/lib/responseFormat";
import { accountDb } from "@/utils/db";

const router = express.Router();

export default router.post("/", async (req, res) => {
  try {
    const taskUuid = String(req.body?.taskUuid ?? "");
    await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).update({
      notificationsMuted: 1,
      updatedAt: Date.now(),
    });
    res.status(200).send(success({ muted: true }));
  } catch (err) {
    res.status(400).send(error(err instanceof Error ? err.message : "降低提醒失败"));
  }
});
