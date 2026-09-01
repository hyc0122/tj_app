import type { RequestHandler } from "express";
import { CANVAS_LIMITS } from "../contracts";

export const canvasJsonBodyLimitBytes = CANVAS_LIMITS.MAX_CANVAS_JSON_BODY_BYTES;
export const canvasMultipartFileLimitBytes = CANVAS_LIMITS.MAX_CANVAS_MULTIPART_FILE_BYTES;
export const canvasMultipartTotalLimitBytes = CANVAS_LIMITS.MAX_CANVAS_MULTIPART_TOTAL_BYTES;
export const canvasMultipartPartLimit = CANVAS_LIMITS.MAX_CANVAS_MULTIPART_PARTS;

/** 测试端口只允许 NODE_ENV=test 且显式传入时缩小限额。 */
export function resolveCanvasJsonLimitBytes(override?: number): number {
  if (process.env.NODE_ENV === "test" && Number.isSafeInteger(override) && Number(override) > 0) {
    return Number(override);
  }
  return canvasJsonBodyLimitBytes;
}

export function canvasJsonLimitMiddleware(limitBytes = canvasJsonBodyLimitBytes): RequestHandler {
  return (req, res, next) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limitBytes) {
      res.status(413).send({
        code: 413,
        errorCode: "CANVAS_BODY_TOO_LARGE",
        message: "请求体超过画布上限",
        retryable: false,
      });
      return;
    }
    next();
  };
}
