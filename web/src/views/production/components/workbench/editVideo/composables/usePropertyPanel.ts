import { computed, ref, watch } from "vue";
import { useTracksStore, useHistoryStore } from "vue-clip-track";
import { DialogPlugin } from "tdesign-vue-next";
import { getClipIcon, getClipTypeName } from "../utils/clipMeta";
import { calculateCenteredTransitionRange, readVideoPropertyValues } from "./propertyPanelLogic";

export function usePropertyPanel() {
  const tracksStore = useTracksStore();
  const historyStore = useHistoryStore();
  const selectedClip = computed(() => {
    const selected = tracksStore.selectedClips;
    return selected.length === 1 ? selected[0] : null;
  });

  const clipName = ref("");
  const videoOpacity = ref(100);
  const videoVolume = ref(100);
  const videoSpeed = ref(1);
  const audioVolume = ref(100);
  const audioFadeIn = ref(0);
  const audioFadeOut = ref(0);
  const transitionType = ref("fade");
  const transitionDuration = ref(1);
  const subtitleText = ref("");
  const subtitleFontSize = ref(24);

  watch(
    selectedClip,
    (clip) => {
      if (!clip) return;
      clipName.value = clip.name || "";

      if (clip.type === "video") {
        const values = readVideoPropertyValues(clip);
        videoOpacity.value = values.opacity;
        videoVolume.value = values.volume;
        videoSpeed.value = values.playbackRate;
      }
      if (clip.type === "audio") {
        audioVolume.value = Math.round(((clip as any).volume ?? 1) * 100);
        audioFadeIn.value = (clip as any).fadeIn ?? 0;
        audioFadeOut.value = (clip as any).fadeOut ?? 0;
      }
      if (clip.type === "transition") {
        transitionType.value = (clip as any).transitionType ?? "fade";
        transitionDuration.value = (clip as any).transitionDuration ?? 1;
      }
      if (clip.type === "subtitle") {
        subtitleText.value = (clip as any).text ?? "";
        subtitleFontSize.value = (clip as any).fontSize ?? 24;
      }
    },
    { immediate: true },
  );

  function handleUpdateClip(key: string, value: any) {
    if (!selectedClip.value) return;
    tracksStore.updateClip(selectedClip.value.id, { [key]: value });
    historyStore.pushSnapshot($t("workbench.production.editVideo.updateClip", { key }));
  }

  function handleUpdatePlaybackRate(newRate: number) {
    if (!selectedClip.value) return;
    if (newRate < 0.1 || newRate > 10) {
      console.warn($t("workbench.production.editVideo.playbackRateRange"));
      return;
    }

    const result = tracksStore.setClipPlaybackRate(selectedClip.value.id, newRate, {
      allowShrink: true,
      allowExpand: true,
      handleCollision: true,
      keepStartTime: true,
    });
    if (result.success) {
      historyStore.pushSnapshot($t("workbench.production.editVideo.updatePlaybackRate", { rate: newRate }));
    } else {
      console.warn($t("workbench.production.editVideo.updatePlaybackRateFailed"), result.message);
    }
  }

  function handleUpdateTransitionDuration() {
    const clip = selectedClip.value;
    if (!clip || clip.type !== "transition") return;
    // 时长变化以原中心点为锚，避免转场在两段素材之间发生视觉漂移。
    tracksStore.updateClip(
      clip.id,
      calculateCenteredTransitionRange(clip.startTime, clip.endTime, transitionDuration.value),
    );
    historyStore.pushSnapshot($t("workbench.production.editVideo.updateTransitionDuration"));
  }

  function handleDeleteClip() {
    if (!selectedClip.value) return;
    const dialog = DialogPlugin.confirm({
      header: $t("workbench.production.editVideo.deleteConfirm"),
      body: $t("workbench.production.editVideo.deleteClipConfirm"),
      onConfirm: () => {
        tracksStore.removeClips([selectedClip.value!.id]);
        historyStore.pushSnapshot($t("workbench.production.editVideo.deleteClip"));
        dialog.destroy();
      },
      onClose: () => dialog.destroy(),
    });
  }

  function handleDuplicateClip() {
    const clip = selectedClip.value;
    if (!clip) return;
    const track = tracksStore.tracks.find((item) => item.id === clip.trackId);
    if (!track) return;
    tracksStore.addClip(track.id, {
      ...clip,
      id: `clip-${Date.now()}`,
      startTime: clip.endTime,
      endTime: clip.endTime + (clip.endTime - clip.startTime),
      selected: false,
    });
    historyStore.pushSnapshot($t("workbench.production.editVideo.duplicateClip"));
  }

  return {
    selectedClip,
    clipName,
    videoOpacity,
    videoVolume,
    videoSpeed,
    audioVolume,
    audioFadeIn,
    audioFadeOut,
    transitionType,
    transitionDuration,
    subtitleText,
    subtitleFontSize,
    getClipIcon,
    getClipTypeName,
    handleUpdateClip,
    handleUpdatePlaybackRate,
    handleUpdateTransitionDuration,
    handleDeleteClip,
    handleDuplicateClip,
  };
}
