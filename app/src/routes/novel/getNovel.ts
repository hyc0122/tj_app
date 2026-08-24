import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

function toNonNegativeInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  if (typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return Math.trunc(n);
  }
  return 0;
}

// 获取原文数据：与 addNovel 使用同一正安全整数 projectId 与当前项目库。
export default router.post(
  "/",
  validateFields({
    projectId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    page: z.number().int().positive(),
    limit: z.number().int().positive().max(200),
    search: z.string().optional(),
  }),
  async (req, res) => {
    const { projectId, page, limit, search } = req.body as {
      projectId: number;
      page: number;
      limit: number;
      search?: string;
    };
    const offset = (page - 1) * limit;
    const data = await u
      .db("o_novel")
      .where("projectId", projectId)
      .select("id", "chapterIndex as index", "reel", "chapter", "chapterData", "event", "eventState", "errorReason")
      .andWhere((qb) => {
        if (search) {
          qb.where("chapter", "like", `%${search}%`);
        }
      })
      .orderBy("chapterIndex", "asc")
      .limit(limit)
      .offset(offset);

    const totalQuery = (await u
      .db("o_novel")
      .where("projectId", projectId)
      .andWhere((qb) => {
        if (search) {
          qb.where("chapter", "like", `%${search}%`);
        }
      })
      .count("* as total")
      .first()) as { total?: unknown } | undefined;

    const total = toNonNegativeInt(totalQuery?.total);
    // 固定形状：{ data: Row[], total: number }，前端不得再猜 list/rows。
    res.status(200).send(success({ data, total }));
  },
);
