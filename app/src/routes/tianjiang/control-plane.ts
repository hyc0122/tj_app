import express from "express";
import { centralAuthGateway, centralSessionStore } from "@/tianjiang/auth/auth-runtime";
import {
  API_CONTRACT,
  ERROR_DEFINITIONS,
  matchAPIEndpoint,
  type ErrorCode,
} from "@/tianjiang/contracts";
import {
  CentralBusinessError,
  type CentralAuthGateway,
  type CentralSession,
  type MemoryCentralSessionStore,
} from "@/tianjiang/auth/central-session";
import {
  resolveRequestID,
  writePublicContractError,
} from "@/tianjiang/http/contract-error";
import {
  matchClientControlPlaneEndpoint,
  validateClientControlPlaneRequest,
} from "@/tianjiang/client-control-plane-contracts";

export function createControlPlaneRouter(
  gateway: CentralAuthGateway,
  sessionStore: MemoryCentralSessionStore,
): express.Router {
  const router = express.Router();
  return router.use(async (req, res) => {
    const session = (req as typeof req & { centralSession?: CentralSession }).centralSession;
    const pathname = `${req.baseUrl}${req.path}`;
    if (!session) {
      return writePublicContractError(req, res, "AUTH_REQUIRED", {
        message: "需要登录",
      });
    }
    const publicEndpoint = matchAPIEndpoint(req.method, pathname);
    const clientEndpoint = matchClientControlPlaneEndpoint(req.method, pathname);
    if (publicEndpoint === null && clientEndpoint === null) {
      return writePublicContractError(req, res, "PROJECT_NOT_FOUND", {
        message: "接口不存在",
      });
    }
    let requestBody = ["GET", "HEAD"].includes(req.method) ? undefined : req.body;
    if (clientEndpoint !== null) {
      try {
        requestBody = validateClientControlPlaneRequest(clientEndpoint, requestBody);
      } catch (error) {
        const coded = (error as { errorCode?: ErrorCode } | null)?.errorCode;
        const code = coded && ERROR_DEFINITIONS.some((item) => item.code === coded)
          ? coded
          : "INVALID_REQUEST";
        return writePublicContractError(req, res, code, {
          message: error instanceof Error ? error.message : "请求参数无效",
        });
      }
    }
    try {
      // 中央 JWT 仅在服务端内存中注入，业务前端只能使用不透明会话 Cookie。
      const result = await gateway.forwardContractRequest(
        session,
        pathname,
        req.method,
        requestBody,
        req.get(API_CONTRACT.requestIdHeader) || undefined,
      );
      sessionStore.update(session);
      const upstreamCode = result.body?.code;
      const validPublicFailure = typeof upstreamCode === "string"
        && ERROR_DEFINITIONS.some((item) => item.code === upstreamCode);
      if (result.status >= 400 && !validPublicFailure) {
        // 上游代理、框架或非 JSON 5xx 不得把私有错误结构泄露给 renderer。
        return writePublicContractError(req, res, "STORAGE_UNAVAILABLE", {
          requestId: result.requestId,
          message: "中央业务请求失败",
        });
      }
      res.set(API_CONTRACT.requestIdHeader, result.requestId);
      return res.status(result.status).send(result.body);
    } catch (error) {
      if (error instanceof CentralBusinessError) {
        const knownCode = typeof error.code === "string"
          && ERROR_DEFINITIONS.some((item) => item.code === error.code)
          ? error.code as ErrorCode
          : "INTERNAL_ERROR";
        return writePublicContractError(req, res, knownCode, {
          status: error.status,
          message: error.message,
          requestId: error.requestId,
          retryable: error.retryable,
        });
      }
      return writePublicContractError(req, res, "STORAGE_UNAVAILABLE", {
        requestId: resolveRequestID(req),
        message: "中央业务请求失败",
      });
    }
  });
}

export default createControlPlaneRouter(centralAuthGateway, centralSessionStore);
