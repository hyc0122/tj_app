import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 新增原文数据：事务提交成功后再响应，返回真实写入的 id 列表。
export default router.post(
  "/",
  validateFields({
    projectId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    data: z.array(
      z.object({
        index: z.number(),
        reel: z.string(),
        chapter: z.string(),
        chapterData: z.string(),
      }),
    ).min(1),
  }),
  async (req, res) => {
    const { projectId, data } = req.body as {
      projectId: number;
      data: Array<{ index: number; reel: string; chapter: string; chapterData: string }>;
    };

    const insertedIds: number[] = await u.db.transaction(async (trx) => {
      const ids: number[] = [];
      const getLastChapterIndex = await trx("o_novel")
        .where("projectId", projectId)
        .select("chapterIndex")
        .orderBy("chapterIndex", "desc")
        .first();
      let lastChapterIndex = 0;
      if (getLastChapterIndex) {
        lastChapterIndex = getLastChapterIndex.chapterIndex!;
      }
      for (const item of data) {
        const [id] = await trx("o_novel").insert({
          projectId,
          chapterIndex: ++lastChapterIndex,
          reel: item.reel,
          chapter: item.chapter,
          chapterData: item.chapterData,
          createTime: Date.now(),
          eventState: 0,
        });
        ids.push(id);
      }
      // 事务内回读，确认行已落库且归属同一 projectId。
      const confirmed = await trx("o_novel")
        .where("projectId", projectId)
        .whereIn("id", ids)
        .select("id");
      if (confirmed.length !== ids.length) {
        throw new Error("小说章节写入后未能完整确认，已回滚");
      }
      return ids;
    });

    // 清洗/事件生成在事务外异步进行，失败不得伪装导入未成功。
    try {
      const chapterAllList = await u.db("o_novel").where("projectId", projectId).whereIn("id", insertedIds);
      const novelClass = new u.cleanNovel();
      novelClass.emitter.on("item", async (item) => {
        await u
          .db("o_novel")
          .where("id", item.id)
          .update({ event: item.event, eventState: item.event ? 1 : -1, errorReason: item?.errReason ?? null });
      });
      void novelClass.start(chapterAllList, projectId);
    } catch (error) {
      console.error("小说导入后事件清洗启动失败:", error);
    }

    res.status(200).send(success({
      message: "新增原文成功",
      insertedIds,
      count: insertedIds.length,
      projectId,
    }));
  },
);
