import { Request, Response, NextFunction } from "express";
import { z, ZodTypeAny } from "zod";

import { zhCN } from "zod/locales";
import { error as errorResponse } from "@/lib/responseFormat";

z.config(zhCN());

export function validateFields(
  shape: Record<string, ZodTypeAny>,
  source: "body" | "query" | "params" = "body", // 默认校验 body
) {
  const schema = z.object(shape);
  return validateSchema(schema, source);
}

export function validateSchema(
  schema: ZodTypeAny,
  source: "body" | "query" | "params" = "body",
) {
  return (req: Request, res: Response, next: NextFunction) => {
    const data = req[source];
    const parseResult = schema.safeParse(data);
    if (!parseResult.success) {
      const errors = parseResult.error.issues.map((issue) => `字段 ${issue.path.join(".")} ${issue.message}`);
      console.error(errors);
      // 中文注释：所有失败响应统一使用 code/data/message，便于 Web 层稳定解析。
      return res.status(400).json(errorResponse("参数错误", { errors }, 400));
    }
    // 中文注释：路由必须消费 Zod 已完成的 coerce/default/transform 结果，不能继续读取原始字符串。
    req[source] = parseResult.data as any;
    next();
  };
}
