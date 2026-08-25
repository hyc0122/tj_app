import type { NextFunction, Request, RequestHandler, Response } from "express";

import {
  type CentralAuthGateway,
  type CentralSession,
  type MemoryCentralSessionStore,
  readSessionCookie,
} from "./central-session";
import { isDefinitiveSessionAuthFailure } from "./session-auth-failure";
import { writePublicContractError } from "../http/contract-error";

/**
 * 登录前必须可访问的生产路由。
 * 更新检查与下载不读取账号数据，Stable 强制更新也必须在建立中央会话前完成。
 */
export const TIANJIANG_PRE_AUTH_PUBLIC_PATHS: ReadonlySet<string> = new Set([
  "/api/tianjiang/auth/captcha",
  "/api/tianjiang/auth/register",
  "/api/tianjiang/auth/login",
  "/api/tianjiang/auth/bootstrap",
  "/api/tianjiang/auth/clear-saved-account",
  "/api/tianjiang/public/legal-documents",
  "/api/tianjiang/public/client-config",
  "/api/setting/about/checkUpdate",
  "/api/setting/about/downloadApp",
  "/api/login/login",
]);

export interface CentralSessionMiddlewareOptions {
  gateway: CentralAuthGateway;
  sessionStore: MemoryCentralSessionStore;
  publicPaths?: ReadonlySet<string>;
  onSessionInvalid(session: CentralSession | string): Promise<void>;
  isOfflineRequest?(path: string, method: string): boolean;
  runOffline?(next: NextFunction): Promise<unknown> | unknown;
  runAuthenticated?(
    session: CentralSession,
    next: NextFunction,
  ): Promise<unknown> | unknown;
}

// createCentralSessionMiddleware 是生产 app 与集成测试共用的唯一 Cookie→中央会话边界。
export function createCentralSessionMiddleware(
  options: CentralSessionMiddlewareOptions,
): RequestHandler {
  const publicPaths = options.publicPaths ?? new Set<string>();
  return async (req: Request, res: Response, next: NextFunction) => {
    if (publicPaths.has(req.path)) return next();

    const sessionID = readSessionCookie(req.headers.cookie);
    // 无 Cookie：返回 AUTH_REQUIRED，禁止调用 onSessionInvalid("")。
    if (!sessionID.trim()) {
      if (options.isOfflineRequest?.(req.path, req.method) && options.runOffline) {
        try {
          return await options.runOffline(next);
        } catch {
          return writePublicContractError(req, res, "PERMISSION_DENIED", {
            message: "本机离线授权无效",
          });
        }
      }
      return writePublicContractError(req, res, "AUTH_REQUIRED", {
        message: "中央会话不存在或已过期",
      });
    }
    const knownSession = options.sessionStore.has(sessionID);
    const session = options.sessionStore.get(sessionID);
    if (!session) {
      // 曾存在于 store 但 get 时已过期：仅当 id 匹配当前运行时才清理（由 coordinator 自行判断）。
      if (knownSession) await options.onSessionInvalid(sessionID);
      if (options.isOfflineRequest?.(req.path, req.method) && options.runOffline) {
        try {
          return await options.runOffline(next);
        } catch {
          return writePublicContractError(req, res, "PERMISSION_DENIED", {
            message: "本机离线授权无效",
          });
        }
      }
      return writePublicContractError(req, res, "AUTH_REQUIRED", {
        message: "中央会话不存在或已过期",
      });
    }

    try {
      if (Date.now() - session.validatedAt > 30_000) {
        await options.gateway.validate(session);
        session.validatedAt = Date.now();
        options.sessionStore.update(session);
      }
      (req as Request & { centralSession: CentralSession }).centralSession = session;
      (req as Request & { user: CentralSession["user"] }).user = session.user;
      if (options.runAuthenticated) return await options.runAuthenticated(session, next);
      return next();
    } catch (error) {
      // 网络/503/DB：本请求失败，不得删除会话或清空 coordinator。
      if (!isDefinitiveSessionAuthFailure(error)) {
        return writePublicContractError(req, res, "INTERNAL_ERROR", {
          status: 503,
          message: "中央认证服务暂时不可用，请稍后重试",
          retryable: true,
        });
      }
      options.sessionStore.delete(session.id);
      await options.onSessionInvalid(session);
      return writePublicContractError(req, res, "AUTH_REQUIRED", {
        message: "中央会话失效",
      });
    }
  };
}
