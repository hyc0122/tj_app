import crypto from "node:crypto";
import type { Request, Response } from "express";

import {
  API_CONTRACT,
  ERROR_DEFINITIONS,
  type ErrorCode,
} from "../contracts";

export interface PublicContractError {
  code: ErrorCode;
  data: null;
  msg: string;
  request_id: string;
  retryable: boolean;
}

export function resolveRequestID(req: Request): string {
  return req.get(API_CONTRACT.requestIdHeader) || crypto.randomUUID();
}

// writePublicContractError 统一 Node 本地失败与 Gin 公共错误结构，确保请求追踪不在异常分支丢失。
export function writePublicContractError(
  req: Request,
  res: Response,
  code: ErrorCode,
  options: {
    status?: number;
    message?: string;
    requestId?: string;
    retryable?: boolean;
  } = {},
): Response {
  const definition = ERROR_DEFINITIONS.find((item) => item.code === code);
  const requestId = options.requestId || resolveRequestID(req);
  const status = options.status ?? definition?.httpStatus ?? 500;
  const body: PublicContractError = {
    code,
    data: null,
    msg: options.message ?? definition?.message ?? "中央业务请求失败",
    request_id: requestId,
    retryable: options.retryable ?? definition?.retryable ?? false,
  };
  res.set(API_CONTRACT.requestIdHeader, requestId);
  return res.status(status).send(body);
}
