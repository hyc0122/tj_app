import express from "express";
import u from "@/utils";
import { ClientConfigCache } from "@/tianjiang/client-config/cache";
import { PublicClientConfigClient } from "@/tianjiang/client-config/client";

const router = express.Router();
let client = new PublicClientConfigClient(new ClientConfigCache(u.getPath()));

(router as unknown as { __setClientForTest: (c: PublicClientConfigClient) => void })
  .__setClientForTest = (next) => { client = next; };

/** renderer 只读公开配置代理：固定中央主机，不可覆盖 URL。 */
export default router.get("/", async (_req, res) => {
  const result = await client.getLatest();
  res.status(200).send({
    code: 0,
    data: {
      config: result.config,
      source: result.source,
      stale: result.stale,
    },
    message: "客户端配置已就绪",
  });
});
