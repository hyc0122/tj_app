import type { MediaClip, TransitionClip } from "vue-clip-track";
import type { TransitionInfo, VideoPreviewContext } from "./videoPreviewTypes";

export function findClipById(context: VideoPreviewContext, clipId: string) {
  for (const track of context.tracksStore.tracks) {
    const clip = track.clips.find((item) => item.id === clipId);
    if (clip) return clip;
  }
  return null;
}

export function detectTransitions(context: VideoPreviewContext) {
  context.transitionInfoMap.clear();
  context.clipTransitionsMap.clear();
  for (const track of context.tracksStore.tracks) {
    if (track.visible === false) continue;
    const transitions = track.clips.filter((clip) => clip.type === "transition") as TransitionClip[];
    const videos = track.clips.filter((clip) => clip.type === "video") as MediaClip[];
    for (const transitionClip of transitions) {
      const start = transitionClip.startTime;
      const end = transitionClip.endTime;
      const midpoint = (start + end) / 2;
      const before = bestMatchingClip(videos, (clip) => clip.endTime, start, end, midpoint);
      const after = bestMatchingClip(videos, (clip) => clip.startTime, start, end, midpoint);
      if (!before || !after || before.id === after.id) continue;
      const info: TransitionInfo = {
        transitionClip,
        beforeClipId: before.id,
        afterClipId: after.id,
        transitionType: transitionClip.transitionType || "fade",
        startTime: start,
        endTime: end,
        duration: end - start,
      };
      context.transitionInfoMap.set(transitionClip.id, info);
      for (const clipId of [before.id, after.id]) {
        const related = context.clipTransitionsMap.get(clipId) ?? [];
        related.push(info);
        context.clipTransitionsMap.set(clipId, related);
      }
    }
  }
}

function bestMatchingClip(
  clips: MediaClip[],
  getTime: (clip: MediaClip) => number,
  start: number,
  end: number,
  midpoint: number,
) {
  let best: MediaClip | null = null;
  let bestScore = -Infinity;
  for (const clip of clips) {
    const time = getTime(clip);
    if (time < start - 1 || time > end + 1) continue;
    const score = -Math.abs(time - midpoint);
    if (score > bestScore) {
      best = clip;
      bestScore = score;
    }
  }
  return best;
}

export function getActiveTransitionAtTime(
  context: VideoPreviewContext,
  time: number,
  clipId: string,
): { transition: TransitionInfo; progress: number; isBeforeClip: boolean } | null {
  const transitions = context.clipTransitionsMap.get(clipId) ?? [];
  for (const transition of transitions) {
    const before = findClipById(context, transition.beforeClipId);
    const after = findClipById(context, transition.afterClipId);
    if (!before || !after) continue;
    const isBeforeClip = transition.beforeClipId === clipId;
    if (isBeforeClip && time >= transition.startTime && time <= before.endTime) {
      const length = before.endTime - transition.startTime;
      const progress = length > 0 ? (time - transition.startTime) / length : 0;
      return { transition, progress: Math.min(1, progress), isBeforeClip };
    }
    if (!isBeforeClip && time >= after.startTime && time <= transition.endTime) {
      const length = transition.endTime - after.startTime;
      const progress = length > 0 ? (time - after.startTime) / length : 0;
      return { transition, progress: Math.min(1, progress), isBeforeClip };
    }
  }
  return null;
}
