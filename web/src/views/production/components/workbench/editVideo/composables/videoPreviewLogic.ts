export interface PreviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function calculatePreviewRect(
  mediaWidth: number,
  mediaHeight: number,
  canvasWidth: number,
  canvasHeight: number,
): PreviewRect {
  const scale = Math.min(canvasWidth / mediaWidth, canvasHeight / mediaHeight);
  const width = mediaWidth * scale;
  const height = mediaHeight * scale;
  return {
    x: (canvasWidth - width) / 2,
    y: (canvasHeight - height) / 2,
    width,
    height,
  };
}

export function calculateTrackZIndex(trackOrder: number, isSubtitleTrack = false): number {
  // 字幕必须覆盖所有普通媒体轨道，普通轨道按顺序反向叠放。
  const baseZIndex = (100 - trackOrder) * 10;
  return isSubtitleTrack ? baseZIndex + 1000 : baseZIndex;
}

const MICROSECONDS_PER_SECOND = 1_000_000;

export function secondsToMicroseconds(seconds: number): number {
  return seconds * MICROSECONDS_PER_SECOND;
}

export function microsecondsToSeconds(microseconds: number): number {
  return microseconds / MICROSECONDS_PER_SECOND;
}

export function assertExportReady<T>(
  canvas: T | null,
  spriteCount: number,
  translate: (key: string) => string,
): T {
  if (!canvas) throw new Error(translate("workbench.production.editVideo.avCanvasNotInit"));
  if (spriteCount <= 0) {
    throw new Error(translate("workbench.production.editVideo.noExportContent"));
  }
  return canvas;
}

interface PreviewTimeSyncState {
  currentTime: { value: number };
  isPlaying: { value: boolean };
  flags: { updatingFromCanvas: boolean; updatingFromStore: boolean };
  debugData: { currentTime: number };
  seekTo: (time: number) => void;
  canvas: { previewFrame: (time: number) => unknown } | null;
}

export function syncCanvasTimeToStore(microseconds: number, state: PreviewTimeSyncState) {
  state.currentTime.value = microseconds;
  state.debugData.currentTime = microseconds;
  state.flags.updatingFromCanvas = true;
  state.seekTo(microsecondsToSeconds(microseconds));
  setTimeout(() => (state.flags.updatingFromCanvas = false), 0);
}

export function syncStoreTimeToCanvas(seconds: number, state: PreviewTimeSyncState) {
  if (state.flags.updatingFromCanvas) return;
  state.currentTime.value = secondsToMicroseconds(seconds);
  if (state.canvas && !state.isPlaying.value) {
    state.flags.updatingFromStore = true;
    state.canvas.previewFrame(state.currentTime.value);
    setTimeout(() => (state.flags.updatingFromStore = false), 0);
  }
}

export function pausePreviewForExport(
  isPlaying: { value: boolean },
  pauseCanvas: () => void,
  pauseStore: () => void,
) {
  if (!isPlaying.value) return;
  pauseCanvas();
  isPlaying.value = false;
  pauseStore();
}
