import express from "express";
import { success, error as errorResponse } from "@/lib/responseFormat";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { commitScriptAgentPlanData } from "@/agents/scriptAgent/script-agent-plan-commit";

const router = express.Router();

const scriptItemSchema = z.object({
  // 可选：有 id 时必须属于当前 projectId
  id: z.number().int().positive().safe().optional(),
  name: z.string().min(1),
  content: z.string(),
});

/**
 * 原子保存故事骨架/改编策略与剧本列表。
 * 事务实现见 script-agent-plan-commit 共享服务。
 */
export default router.post(
  "/",
  validateFields({
    projectId: z.number().int().positive().safe(),
    agentType: z.enum(["scriptAgent"]),
    data: z.object({
      storySkeleton: z.string(),
      adaptationStrategy: z.string(),
      script: z.array(scriptItemSchema).default([]),
    }),
  }),
  async (req, res) => {
    try {
      const { projectId, agentType, data } = req.body as {
        projectId: number;
        agentType: "scriptAgent";
        data: {
          storySkeleton: string;
          adaptationStrategy: string;
          script: Array<{ id?: number; name: string; content: string }>;
        };
      };

      await commitScriptAgentPlanData({
        projectId,
        agentType,
        data,
      });

      return res.status(200).send(success());
    } catch (err) {
      const safe = err && typeof err === "object" && (err as { safe?: boolean }).safe;
      return res.status(safe ? 400 : 500).json(
        errorResponse(safe ? "剧本不属于当前项目，保存已取消" : "保存剧本计划失败", null, safe ? 400 : 500),
      );
    }
  },
);
