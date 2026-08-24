import type { Ref } from "vue";
import { DialogPlugin } from "tdesign-vue-next";
import axios from "@/utils/axios";
import { localProjectBody, toPositiveSafeInteger } from "@/features/tianjiang/project/local-project-id";
import { selectPromptMedia, selectVideoMedia } from "./generateLogic";
import {
  createPendingOperationIdentity,
  fingerprintWorkbenchRequestIntent,
  safeWorkbenchVideoError,
} from "./workbenchRequestIdentity";
import type { GenerateState } from "./useGenerateState";

export function useGenerateActions(state: GenerateState, episodesId: Ref<number>) {
  const pendingVideoOperations = createPendingOperationIdentity();

  async function genText() {
    const track = state.currentTrack.value;
    if (!track || track.id == null || track.state === "生成中") return;

    const trackId = track.id;
    const media = selectPromptMedia((track.medias ?? []) as UploadItem[], state.modelParmas.value.mode);
    track.state = "生成中";
    try {
      const { data } = await axios.post(
        "/production/workbench/generateVideoPrompt",
        localProjectBody(state.project.value?.id, {
          trackId,
          info: media,
          model: state.modelParmas.value.model,
          mode: state.modelParmas.value.mode,
        }),
      );
      track.prompt = data;
      track.state = "已完成";
    } catch (error) {
      track.state = "生成失败";
      window.$message.error((error as Error)?.message ?? "提示词生成失败");
    }
  }

  function generateVideo() {
    const track = state.currentTrack.value;
    // 中文注释：缺轨道/模型/详情必须在确认框之前可见报错，禁止静默 return。
    if (!track) {
      window.$message.error("请先选择轨道");
      return;
    }
    if (!String(state.modelParmas.value.model || "").trim()) {
      window.$message.error("请先选择模型");
      return;
    }
    if (!state.modeOptions.value?.modelName || state.modelStatus.value) {
      window.$message.error(state.modelStatus.value || "视频模型详情未就绪");
      return;
    }
    const buildRequestIntent = (intentTrack: TrackItem) => localProjectBody(state.project.value?.id, {
      scriptId: toPositiveSafeInteger(episodesId.value),
      uploadData: selectVideoMedia(state.imageList.value, state.modelParmas.value.mode),
      prompt: intentTrack.prompt,
      model: state.modelParmas.value.model,
      mode: state.modelParmas.value.mode,
      resolution: state.modelParmas.value.resolution,
      duration: state.modelParmas.value.duration,
      audio: state.modelParmas.value.audio,
      trackId: intentTrack.id,
    });
    let confirmedIntent: ReturnType<typeof buildRequestIntent>;
    try {
      // 中文注释：确认框打开时冻结完整请求，避免旧轨道与确认后的实时参数拼成混合请求。
      confirmedIntent = buildRequestIntent(track);
    } catch (error) {
      window.$message.error(safeWorkbenchVideoError(error, "视频发起生成请求失败"));
      return;
    }
    const confirmedFingerprint = fingerprintWorkbenchRequestIntent(confirmedIntent);
    let dialog: { destroy: () => void } | undefined;
    dialog = DialogPlugin.confirm({
      header: $t("workbench.generate.generateConfirm"),
      body: $t("workbench.generate.generateConfirmBody"),
      onConfirm: async () => {
        dialog?.destroy();
        const currentTrack = state.currentTrack.value;
        let currentIntent: ReturnType<typeof buildRequestIntent> | null = null;
        try {
          currentIntent = currentTrack ? buildRequestIntent(currentTrack) : null;
        } catch {
          // 中文注释：确认期间项目或剧本身份变成无效值也属于配置变化，必须零请求。
        }
        if (!currentTrack || !currentIntent || fingerprintWorkbenchRequestIntent(currentIntent) !== confirmedFingerprint) {
          window.$message.error("生成配置已变化，请重新确认");
          return;
        }
        try {
          const reservation = pendingVideoOperations.reserve(confirmedIntent);
          const { data } = await axios.post(
            "/production/workbench/generateVideo",
            { ...confirmedIntent, clientOperationId: reservation.clientOperationId },
          );
          // 中文注释：HTTP 成功即代表服务端已接受/重放请求，必须清除本次 pending 身份。
          pendingVideoOperations.complete(reservation);
          window.$message.success($t("workbench.generate.generateStarted"));
          // 中文注释：并发重放会返回同一 videoId；按 ID upsert，避免重复记录与重复轮询。
          if (!currentTrack.videoList.some((item) => item.id === data)) {
            currentTrack.videoList.push({
              id: data,
              state: "生成中",
              src: "",
            });
          }
        } catch (error) {
          window.$message.error(safeWorkbenchVideoError(error, "视频发起生成请求失败"));
        }
      },
      onCancel: () => dialog?.destroy(),
    });
  }

  return {
    genText,
    generateVideo,
  };
}
