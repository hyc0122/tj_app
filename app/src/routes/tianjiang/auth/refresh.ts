import express from "express";
import { centralAuthGateway, centralSessionStore } from "@/tianjiang/auth/auth-runtime";
import { syncCoordinator } from "@/tianjiang/runtime/runtime";

const router = express.Router();

export default router.post("/", async (req, res) => {
  const session = (req as any).centralSession;
  try {
    session.validatedAt = Date.now();
    await centralAuthGateway.validate(session);
    centralSessionStore.update(session);
    res.status(200).send({ code: 0, data: { user: session.user }, message: "会话已刷新" });
  } catch {
    await syncCoordinator.onSessionInvalid(session);
    centralSessionStore.delete(session.id);
    res.status(401).send({ code: 401, message: "中央会话失效" });
  }
});
