import express from "express";

import { error, success } from "@/lib/responseFormat";
import { recoverDreaminaSlots } from "@/tianjiang/model-providers/dreamina-cli/recovery";

const router = express.Router();

export default router.post("/", async (_req, res) => {
  try {
    res.status(200).send(success(await recoverDreaminaSlots()));
  } catch (err) {
    res.status(400).send(error(err instanceof Error ? err.message : "对账失败"));
  }
});
