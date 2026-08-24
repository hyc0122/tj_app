import express from "express";
import { success } from "@/lib/responseFormat";
// 中文注释：直接使用项目库 Proxy，避免 `import u from "@/utils"` 在 tsx 测试/ESM 下双重 default 导致 u.db 不可调用
import { db } from "@/utils/db";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";

const router = express.Router();

/**
 * 纯读取：无数据时不插入 o_agentWorkData。
 * readonly/recovery 可调用；写门由 isLegacyProjectMutation 排除。
 */
export default router.post(
  "/",
  validateFields({
    projectId: z.number().int().positive().safe(),
    agentType: z.enum(["scriptAgent"]),
  }),
  async (req, res) => {
    try {
      const { projectId, agentType } = req.body as {
        projectId: number;
        agentType: "scriptAgent";
      };
      const row = await db("o_agentWorkData").where({ projectId, key: agentType }).first();

      if (!row) {
        // 中文注释：GET 语义的 POST 读取不得副作用写库
        return res.status(200).send(
          success({
            data: {
              storySkeleton: "",
              adaptationStrategy: "",
              script: [] as Array<{ id: number; name: string; content: string }>,
            },
            id: null,
          }),
        );
      }

      const data = JSON.parse(row.data ?? "{}") as {
        storySkeleton?: string;
        adaptationStrategy?: string;
      };
      const script = await db("o_script").where({ projectId }).select("id", "name", "content");

      return res.status(200).send(
        success({
          data: {
            storySkeleton: data.storySkeleton ?? "",
            adaptationStrategy: data.adaptationStrategy ?? "",
            script: script ?? [],
          },
          id: row.id ?? null,
        }),
      );
    } catch {
      return res.status(500).json({
        code: 500,
        data: null,
        message: "读取剧本计划失败",
      });
    }
  },
);
