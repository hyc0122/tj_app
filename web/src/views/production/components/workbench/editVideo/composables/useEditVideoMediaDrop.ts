import {
  generateId,
  normalizeTime,
  type Clip,
} from "vue-clip-track";
import { getDefaultDuration, findOrCreateTrackWithSpace } from "../utils/trackHelper";
import { loadVideoClipThumbnails, loadAudioClipWaveform } from "../utils/mediaLoader";
import { findAdjacentClipsAtTime, addTransitionBetweenClips } from "../utils/transitionHelper";
import { createMediaClip } from "./editVideoClipFactory";

interface MediaDropDependencies {
  tracksStore: any;
  historyStore: any;
  playbackStore: any;
  videoTrackRef: any;
}

export function useEditVideoMediaDrop(dependencies: MediaDropDependencies) {
  const { tracksStore, historyStore, playbackStore, videoTrackRef } = dependencies;

  function applyTransition(beforeClipId: string, afterClipId: string, transitionType = "fade") {
    const result = addTransitionBetweenClips(tracksStore, historyStore, beforeClipId, afterClipId, transitionType);
    if (result && videoTrackRef.value) {
      videoTrackRef.value.emitTransitionAdded(result.transitionClip, result.beforeClip.id, result.afterClip.id);
    }
  }

  function handleDropTransition(transitionData: any, trackId: string, dropTime: number) {
    const track = tracksStore.tracks.find((item: any) => item.id === trackId);
    if (!track) return;

    const clips = track.clips.filter((clip: Clip) => clip.type !== "transition").sort((a: Clip, b: Clip) => a.startTime - b.startTime);
    if (clips.length === 0) {
      window.$message.warning($t("workbench.production.editVideo.transitionBetweenClips"));
      return;
    }

    const result = findAdjacentClipsAtTime(clips, dropTime);
    if (!result) {
      window.$message.warning($t("workbench.production.editVideo.transitionBetweenClips"));
      return;
    }
    applyTransition(result.beforeClip.id, result.afterClip.id, transitionData.subType);
  }

  async function handleDropMedia(mediaData: any, trackId: string, startTime: number) {
    try {
      if (mediaData.type === "transition") {
        handleDropTransition(mediaData, trackId, startTime);
        return;
      }

      const duration = getDefaultDuration(mediaData.type, mediaData);
      const { track } = findOrCreateTrackWithSpace(tracksStore, mediaData.type, startTime, duration, trackId);
      if (!track) return;

      const clip = createMediaClip(mediaData, track.id, startTime, duration, generateId("clip-"), normalizeTime, $t);
      tracksStore.addClip(track.id, clip as Clip);
      historyStore.pushSnapshot($t("workbench.production.editVideo.addClip", { name: mediaData.name }));

      const sourceUrl = mediaData.sourceUrl || mediaData.url || mediaData.id;
      // 缩略图和波形继续异步加载，不能阻塞片段进入时间轴。
      if (mediaData.type === "video" && (!mediaData.thumbnails || mediaData.thumbnails.length === 0)) {
        loadVideoClipThumbnails(tracksStore, clip.id!, sourceUrl);
      }
      if (mediaData.type === "audio" && (!mediaData.waveformData || mediaData.waveformData.length === 0)) {
        loadAudioClipWaveform(tracksStore, clip.id!, sourceUrl);
      }
    } catch (error: any) {
      alert(error.message);
    }
  }

  function handleAddTransitionFromClick(beforeClipId: string, afterClipId: string) {
    applyTransition(beforeClipId, afterClipId, "fade");
  }

  function onTransitionAdded(transitionClip: any) {
    window.$message.success($t("workbench.production.editVideo.transitionAdded", { name: transitionClip.name }));
    playbackStore.seekTo(transitionClip.startTime);
  }

  return { handleDropMedia, handleAddTransitionFromClick, onTransitionAdded };
}
