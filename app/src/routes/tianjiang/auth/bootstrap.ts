import express from "express";
import {
  authCredentialStore,
  centralAuthGateway,
  centralSessionStore,
} from "@/tianjiang/auth/auth-runtime";
import {
  buildSessionCookie,
  readSessionCookie,
} from "@/tianjiang/auth/central-session";
import { bootstrapAuthState } from "@/tianjiang/auth/auth-bootstrap";
import { syncCoordinator } from "@/tianjiang/runtime/runtime";
import { activateUserDatabase } from "@/utils/db";
import { disconnectSocketsExceptSession } from "@/tianjiang/auth/socket-session";

const router = express.Router();

/**
 * 公开启动引导：自动登录 / 回填账号密码 / 离线提示。
 * 不依赖已有会话 Cookie。
 */
export default router.get("/", async (req, res) => {
  try {
    const result = await bootstrapAuthState({
      credentialStore: authCredentialStore,
      sessionStore: centralSessionStore,
      gateway: centralAuthGateway,
      readCookieSessionId: () => readSessionCookie(req.headers.cookie),
      onLogin: (session) => syncCoordinator.onLogin(session),
      activateUserDatabase,
    });

    if (result.sessionCookie) {
      centralSessionStore.deleteAllExcept(result.sessionCookie.id);
      disconnectSocketsExceptSession(result.sessionCookie.id);
      res.setHeader(
        "Set-Cookie",
        buildSessionCookie(
          result.sessionCookie.id,
          req.secure,
          result.sessionCookie.maxAgeSeconds,
        ),
      );
    }

    // 响应不得把 token 明文带回；密码仅用于本机表单回填。
    res.status(200).send({
      code: 0,
      data: {
        mode: result.mode,
        user: result.user ?? null,
        username: result.username ?? "",
        password: result.password ?? "",
        keyServiceDegraded: result.keyServiceDegraded === true,
        message: result.message ?? "",
      },
      message: "ok",
    });
  } catch (error) {
    // 凭据解密失败不得静默 mode:none；其它未知错误仍回空表单但不删密钥。
    const { CredentialDecryptionError } = await import("@/tianjiang/crypto/credential-store");
    const { REAUTH_REQUIRED_MESSAGE } = await import("@/tianjiang/auth/auth-bootstrap");
    if (error instanceof CredentialDecryptionError) {
      return res.status(200).send({
        code: 0,
        data: {
          mode: "reauth_required",
          user: null,
          username: "",
          password: "",
          keyServiceDegraded: false,
          message: REAUTH_REQUIRED_MESSAGE,
        },
        message: "ok",
      });
    }
    res.status(200).send({
      code: 0,
      data: {
        mode: "none",
        user: null,
        username: "",
        password: "",
        keyServiceDegraded: false,
        message: "",
      },
      message: "ok",
    });
  }
});
