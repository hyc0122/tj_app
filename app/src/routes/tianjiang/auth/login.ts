import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import {
  authCredentialStore,
  centralAuthGateway,
  centralSessionStore,
} from "@/tianjiang/auth/auth-runtime";
import {
  buildSessionCookie,
  CentralRequestError,
} from "@/tianjiang/auth/central-session";
import { syncCoordinator } from "@/tianjiang/runtime/runtime";
import { activateUserDatabase } from "@/utils/db";
import { canvasExecutionRuntime } from "@/tianjiang/canvas/canvas-execution-runtime";
import { resumeRawInboxConsumer } from "@/tianjiang/canvas/canvas-provider-raw-inbox";
import { disconnectSocketsExceptSession } from "@/tianjiang/auth/socket-session";
import {
  centralServiceUnavailableResponse,
} from "@/tianjiang/auth/central-service-error";
import {
  CredentialDecryptionError,
} from "@/tianjiang/crypto/credential-store";
import {
  PROFILE_KEY_RECOVERY_FAILED_MESSAGE,
} from "@/tianjiang/crypto/user-key-recovery";

const router = express.Router();

/** 同步初始化失败时对 UI 的安全中文，禁止回显 safeStorage/英文堆栈。 */
export function safeLoginSyncInitMessage(error: unknown): string {
  if (error instanceof CredentialDecryptionError) {
    return "本地加密凭据与当前运行环境不兼容，请重新登录以安全恢复同步";
  }
  if (error instanceof Error) {
    if (error.message === PROFILE_KEY_RECOVERY_FAILED_MESSAGE) {
      return PROFILE_KEY_RECOVERY_FAILED_MESSAGE;
    }
    // 仅透传已知中文业务错误；含 decrypt/safeStorage/路径/token 的一律脱敏
    if (
      /[\u3400-\u9fff]/.test(error.message)
      && !/decrypt|safeStorage|token|secret|stack|E:\\|C:\\|\\\\/i.test(error.message)
    ) {
      return `登录后同步初始化失败: ${error.message}`;
    }
  }
  return "登录后同步初始化失败，请重试登录";
}

export default router.post(
  "/",
  validateFields({
    username: z.string().min(3).max(32),
    password: z.string().min(8).max(72),
    captcha: z.string().max(20),
    captchaId: z.string().max(200),
  }),
  async (req, res) => {
    try {
      // 完整流程：中央认证 → 凭据恢复/设备公钥更新 → 恢复同一 profile key
      // → ProfileStore 可读取 → 保存新的 auth 密文 → 登录成功。
      const result = await centralAuthGateway.login(req.body);
      const session = centralSessionStore.create(result.session);
      try {
        // Cookie 只能在设备、配置和目录初始化后发出；密钥服务降级不阻断登录。
        const loginRuntime = await syncCoordinator.onLogin(session);
        // 新账号同步材料已完整校验后，才关闭旧句柄并原子替换唯一活动数据库目录。
        await activateUserDatabase({ issuer: session.serverUrl, userId: session.user.id });
        await canvasExecutionRuntime.resume();
        resumeRawInboxConsumer();
        // 单用户桌面运行时只允许最新成功登录会话继续访问，旧 Cookie 立即失效。
        centralSessionStore.deleteAllExcept(session.id);
        disconnectSocketsExceptSession(session.id);

        // 默认安全保存账号密码与中央会话（safeStorage 加密，按业务账号隔离）。
        authCredentialStore.saveAfterLogin(
          req.body.username,
          req.body.password,
          {
            serverUrl: session.serverUrl,
            token: session.token,
            expiresAt: session.expiresAt,
            user: result.publicUser,
          },
        );

        const maxAge = Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000));
        res.setHeader("Set-Cookie", buildSessionCookie(session.id, req.secure, maxAge));
        res.status(200).send({
          code: 0,
          data: {
            user: result.publicUser,
            keyServiceDegraded: loginRuntime.keyServiceDegraded === true,
          },
          message: loginRuntime.keyServiceDegraded
            ? "登录成功，个人配置同步暂不可用，恢复后将自动重试"
            : "登录成功",
        });
      } catch (error) {
        // 恢复失败：撤销本会话，不得留下半初始化登录态
        centralSessionStore.delete(session.id);
        const unavailable = centralServiceUnavailableResponse(error);
        if (unavailable) {
          return res.status(unavailable.status).send(unavailable.body);
        }
        res.status(502).send({
          code: 502,
          message: safeLoginSyncInitMessage(error),
        });
      }
    } catch (error) {
      const unavailable = centralServiceUnavailableResponse(error);
      if (unavailable) {
        return res.status(unavailable.status).send(unavailable.body);
      }
      // 已知安全错误透传真实提示；未知错误统一安全回退，禁止回显服务器内部信息。
      if (error instanceof CentralRequestError) {
        return res.status(error.status).send({
          code: error.code,
          message: error.message,
        });
      }
      res.status(401).send({ code: 401, message: "中央认证失败" });
    }
  },
);
