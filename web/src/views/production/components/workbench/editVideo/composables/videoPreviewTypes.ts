import type { AVCanvas } from "@webav/av-canvas";
import type { VisibleSprite } from "@webav/av-cliper";
import type { Clip, TransitionClip } from "vue-clip-track";
import type { ComputedRef, Ref, ShallowRef } from "vue";

export interface VideoPreviewProps {
  canvasWidth: number;
  canvasHeight: number;
}

export interface TransitionInfo {
  transitionClip: TransitionClip;
  beforeClipId: string;
  afterClipId: string;
  transitionType: string;
  startTime: number;
  endTime: number;
  duration: number;
}

export type ExtendedClip = Clip & {
  rect?: {
    x: number;
    y: number;
    w: number;
    h: number;
    angle: number;
    fixedAspectRatio?: boolean;
    fixedScaleCenter?: boolean;
  };
  visible?: boolean;
  opacity?: number;
  flip?: "horizontal" | "vertical" | null;
  zIndex?: number;
};

export interface AVCanvasDebugData {
  initialized: boolean;
  canvasWidth: number;
  canvasHeight: number;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  playbackSpeed: number;
  spriteCount: number;
  sprites: Array<{
    clipId: string;
    type: string;
    offset: number;
    duration: number;
    visible: boolean;
    opacity: number;
    rect: { x: number; y: number; w: number; h: number; angle: number };
    zIndex: number;
  }>;
}

export interface VideoPreviewContext {
  props: VideoPreviewProps;
  playbackStore: ReturnType<typeof import("vue-clip-track")["usePlaybackStore"]>;
  tracksStore: ReturnType<typeof import("vue-clip-track")["useTracksStore"]>;
  playbackSpeed: Ref<number>;
  canvasContainer: Ref<HTMLElement | null>;
  avCanvas: ShallowRef<AVCanvas | null>;
  hasSprites: Ref<boolean>;
  isPlaying: Ref<boolean>;
  currentTime: Ref<number>;
  duration: Ref<number>;
  currentTimeInSeconds: ComputedRef<number>;
  durationInSeconds: ComputedRef<number>;
  canvasWidth: ComputedRef<number>;
  canvasHeight: ComputedRef<number>;
  flags: {
    updatingFromCanvas: boolean;
    updatingFromStore: boolean;
    syncing: boolean;
    pendingSync: boolean;
  };
  clipSpriteMap: Map<string, VisibleSprite>;
  spriteListenerMap: Map<string, () => void>;
  clipSnapshotMap: Map<string, {
    trimStart: number;
    trimEnd: number;
    playbackRate: number;
    sourceUrl: string;
    text?: string;
    volume: number;
  }>;
  clipTrackMap: Map<string, { trackId: string; trackOrder: number }>;
  transitionInfoMap: Map<string, TransitionInfo>;
  clipTransitionsMap: Map<string, TransitionInfo[]>;
  clipFrameCache: Map<string, ImageBitmap>;
  avCanvasDebugData: AVCanvasDebugData;
}
