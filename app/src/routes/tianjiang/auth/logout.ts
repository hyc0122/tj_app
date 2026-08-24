import express from "express";
import {
  authCredentialStore,
  centralAuthGateway,
  centralSessionStore,
} from "@/tianjiang/auth/auth-runtime";
import { clearSessionCookie } from "@/tianjiang/auth/central-session";
import { syncCoordinator } from "@/tianjiang/runtime/runtime";

const router = express.Router();

export default router.post("/", async (req, res) => {
  const session = (req as any).centralSession;
  try {
    // 中文注释：显式退出/切换账号前必须全部项目中央同步成功；失败保持原会话。
    await syncCoordinator.prepareExplicitLogout(session);
  } catch (error) {
    const message = error instanceof Error ? error.message : "同步失败，已取消退出登录";
    res.status(409).send({
      code: 409,
      message,
      data: { cancelled: true, reason: "central_sync_required" },
    });
    return;
  }
  await syncCoordinator.onSessionInvalid(session);
  centralSessionStore.delete(session.id);
  // 显式退出：清除持久化 token，但保留账号密码供下次自动填入。
  authCredentialStore.clearSessionOnly(session?.user?.username);
  res.setHeader("Set-Cookie", clearSessionCookie(req.secure));
  await centralAuthGateway.logout(session);
  res.status(200).send({ code: 0, data: null, message: "已退出登录" });
});
