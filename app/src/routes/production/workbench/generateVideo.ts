import express from "express";
import u from "@/utils";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { ReferenceList } from "@/utils/ai";
import { prepareProjectDatabase } from "@/utils/db";
import { runWithProjectStorage } from "@/tianjiang/runtime/user-storage-context";
import {
  enqueueWorkbenchDreaminaVideos,
  isDreaminaCliModel,
  resolveWorkbenchProjectUuid,
  writeWorkbenchDreaminaError,
} from "@/tianjiang/workbench/dreamina-workbench-enqueue";
const router = express.Router();

type Type = "imageReference" | "startImage" | "endImage" | "videoReference" | "audioReference";
interface UploadItem {
  fileType: "image" | "video" | "audio";
  type: Type;
  sources?: "assets" | "storyboard";
  id?: number;
  src?: string;
  label?: string;
  prompt?: string;
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    uploadData: z.array(
      z.object({
        id: z.number(),
        sources: z.string(),
      }),
    ),
    prompt: z.string(),
    model: z.string(),
    mode: z.string(),
    resolution: z.string(),
    duration: z.number(),
    audio: z.boolean().optional(),
    trackId: z.number(),
    clientOperationId: z.string().uuid().optional(),
  }),
  async (req, res) => {
    const { scriptId, projectId, prompt, uploadData, model, duration, resolution, audio, mode, trackId, clientOperationId } = req.body;
    if (isDreaminaCliModel(String(model))) {
      try {
        const projectUuid = await resolveWorkbenchProjectUuid(
          projectId,
          (req as { centralSession?: unknown }).centralSession,
        );
        await prepareProjectDatabase(projectUuid);
        await runWithProjectStorage(projectUuid, async () => {
          const bound = await enqueueWorkbenchDreaminaVideos({
            projectUuid,
            paidBatchConfirmed: false,
            clientOperationId,
            items: [{
              projectId,
              scriptId,
              trackId,
              prompt,
              model,
              mode,
              resolution,
              duration,
              audio,
              uploadData,
            }],
          });
          res.status(200).send(success(bound[0]?.videoId ?? null));
        });
      } catch (error) {
        writeWorkbenchDreaminaError(res, error);
      }
      return;
    }

    try {
        let modeData = [];
        if (Array.isArray(mode)) {
        } else if (typeof mode === "string" && mode.startsWith('["') && mode.endsWith('"]')) {
          try {
            modeData = JSON.parse(mode);
          } catch (e) {}
        }
        const ratio = await u.db("o_project").select("videoRatio").where("id", projectId).first();
        const videoPath = `/${projectId}/video/${uuidv4()}.mp4`;
        const images = await Promise.all(
          uploadData.map(async (item: UploadItem) => {
            if (item.sources === "storyboard") {
              const filePath = await u.db("o_storyboard").where("id", item.id).select("filePath").first();
              return { path: filePath?.filePath, sources: "storyBoard" };
            }
            if (item.sources === "assets") {
              const filePath = await u
                .db("o_assets")
                .where("o_assets.id", item.id)
                .leftJoin("o_image", "o_assets.imageId", "o_image.id")
                .select("o_image.filePath", "o_image.type")
                .first();
              return { path: filePath?.filePath, sources: filePath.type };
            }
          }),
        );
        const base64 = await Promise.all(
          images.map(async (item) => {
            if (!item) return null;
            return { base64: await u.oss.getImageBase64(item.path), type: item.sources == "audio" ? "audio" : "image" };
          }),
        );
        const [videoId] = await u.db("o_video").insert({
          filePath: videoPath,
          time: Date.now(),
          state: "生成中",
          scriptId,
          projectId,
          videoTrackId: trackId,
        });
        res.status(200).send(success(videoId));
        const relatedObjects = {
          projectId,
          videoId,
          scriptId,
          type: "视频",
        };
        const aiVideo = u.Ai.Video(model);
        aiVideo
          .run(
            {
              prompt,
              referenceList: base64.filter(Boolean) as ReferenceList[],
              mode: modeData.length > 0 ? modeData : mode,
              duration,
              aspectRatio: (ratio?.videoRatio as "16:9" | "9:16") || "16:9",
              resolution,
              audio,
            },
            {
              projectId,
              taskClass: "视频生成",
              describe: "根据提示词生成视频",
              relatedObjects: JSON.stringify(relatedObjects),
            },
          )
          .then(async () => await aiVideo.save(videoPath))
          .then(async () => await u.db("o_video").where("id", videoId).update({ state: "生成成功" }))
          .catch(async (error: any) => {
            await u
              .db("o_video")
              .where("id", videoId)
              .update({
                state: "生成失败",
                errorReason: u.error(error).message,
              });
          });
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).send({ code: "500", message: "提交生成失败，请重试" });
      }
    }
  },
);
