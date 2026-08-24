import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { currentUserStorage } from "@/tianjiang/runtime/user-storage-context";
import axios from "axios";
const router = express.Router();

/**
 * 从画布返回的受保护 runtime URL 中提取当前项目内的文件路径。
 * 中文注释：必须核对 URL 中的项目 UUID，禁止借当前项目上下文读取其他项目的同名文件。
 */
function projectReferenceLogicalPath(imageUrl: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(imageUrl, "http://tianjiang.local").pathname;
  } catch {
    return undefined;
  }
  const matched = pathname.match(/^\/api\/tianjiang\/runtime\/projects\/([^/]+)\/files\/(.+)$/);
  if (!matched) return undefined;

  let referenceProjectUuid: string;
  let relativePath: string;
  try {
    referenceProjectUuid = decodeURIComponent(matched[1]!);
    relativePath = decodeURIComponent(matched[2]!);
  } catch {
    throw new Error("项目参考图地址无效");
  }

  const context = currentUserStorage();
  if (!context?.projectUuid) throw new Error("缺少当前项目上下文");
  if (referenceProjectUuid.toLowerCase() !== context.projectUuid.toLowerCase()) {
    throw new Error("参考图不属于当前项目");
  }
  return `files/${relativePath.replace(/^\/+/, "")}`;
}

async function urlToBase64(imageUrl: string): Promise<string> {
  const projectLogicalPath = projectReferenceLogicalPath(imageUrl);
  if (projectLogicalPath) {
    // 中文注释：项目参考图直接从当前项目文件目录读取，避免无 Cookie 的本机 HTTP 回环被鉴权为 404。
    return await u.oss.getImageBase64(projectLogicalPath);
  }
  if (imageUrl.startsWith("/oss/")) {
    return await u.oss.getImageBase64(u.replaceUrl(imageUrl).replace("/smallImage", ""));
  }
  imageUrl = await u.oss.getFileUrl(u.replaceUrl(imageUrl));
  const response = await axios.get(imageUrl, { responseType: "arraybuffer" });
  const contentType = response.headers["content-type"] || "image/png";
  const base64 = Buffer.from(response.data, "binary").toString("base64");
  return `data:${contentType};base64,${base64}`;
}
export default router.post(
  "/",
  validateFields({
    model: z.string(),
    references: z.array(z.string()).optional(),
    quality: z.string(),
    ratio: z.string(),
    prompt: z.string(),
    projectId: z.number(),
  }),
  async (req, res) => {
    const { model, references = [], quality, ratio, prompt, projectId } = req.body;
    try {
      const imageClass = await u.Ai.Image(model).run(
        {
          prompt: prompt,
          referenceList: await (async () => {
            const list: { type: "image"; base64: string }[] = [];
            for (const url of references) {
              list.push({ type: "image" as const, base64: await urlToBase64(url) });
            }
            return list;
          })(),
          size: quality,
          aspectRatio: ratio,
        },
        {
          taskClass: "工作流图片生成",
          describe: "工作流图片生成",
          relatedObjects: JSON.stringify(req.body),
          projectId: projectId,
        },
      );
      const savePath = `${projectId}/workFlow/${u.uuid()}.jpg`;
      await imageClass.save(savePath);

      const url = await u.oss.getSmallImageUrl(savePath);
      return res.status(200).send(success({ url }));
    } catch (e) {
      res.status(400).send(error(u.error(e).message));
    }
  },
);
