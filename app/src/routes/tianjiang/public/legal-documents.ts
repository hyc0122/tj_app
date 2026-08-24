import express from "express";

import u from "@/utils";
import { LegalDocumentCache } from "@/tianjiang/legal/legal-document-cache";
import {
  LegalDocumentClient,
  type LegalDocumentsResult,
} from "@/tianjiang/legal/legal-document-client";

const router = express.Router();

// 默认使用应用数据根目录；测试可注入客户端。
let client: LegalDocumentClient = new LegalDocumentClient(
  new LegalDocumentCache(u.getPath()),
);

function setClientForTest(next: LegalDocumentClient): void {
  client = next;
}

(router as unknown as { __setClientForTest: typeof setClientForTest })
  .__setClientForTest = setClientForTest;

/**
 * renderer 只读代理：GET 固定路径，不接收 body/serverUrl。
 * 始终 200 返回安全投影，网络失败时降级 cache/packaged。
 */
export default router.get("/", async (_req, res) => {
  try {
    // renderer 只能读取服务端选择后的安全公开文档，不能控制上游地址。
    const result: LegalDocumentsResult = await client.getLatest();
    res.status(200).send({
      code: 0,
      data: {
        documents: result.documents,
        source: result.source,
        stale: result.stale,
      },
      message: "协议内容已就绪",
    });
  } catch {
    const fallback = new LegalDocumentCache(u.getPath()).packagedFallback();
    res.status(200).send({
      code: 0,
      data: {
        documents: fallback,
        source: "packaged",
        stale: true,
      },
      message: "协议内容已就绪",
    });
  }
});
