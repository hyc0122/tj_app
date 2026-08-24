export type StoryboardAssetType = "role" | "scene" | "tool" | "clip" | "audio";

export type StoryboardMediaType = "image" | "video";

export const STORYBOARD_VIDEO_RESOLUTIONS = ["480p", "720p", "1080p"] as const;

export type StoryboardVideoResolution = typeof STORYBOARD_VIDEO_RESOLUTIONS[number];

export const DEFAULT_STORYBOARD_VIDEO_RESOLUTION: StoryboardVideoResolution = "720p";

export function normalizeStoryboardVideoResolution(value: unknown): StoryboardVideoResolution | "" {
  const raw = String(value ?? "").trim().toLowerCase();
  // 中文注释：旧项目没有保存该字段时按 720p 展示；未知值必须交给调用方明确拒绝。
  if (!raw) return DEFAULT_STORYBOARD_VIDEO_RESOLUTION;
  return STORYBOARD_VIDEO_RESOLUTIONS.includes(raw as StoryboardVideoResolution)
    ? raw as StoryboardVideoResolution
    : "";
}

export type StoryboardGenerationMode =
  | "auto"
  | "text2image"
  | "image2image"
  | "text2video"
  | "image2video"
  | "frames2video"
  | "multiframe2video"
  | "multimodal2video";

export interface WorkspaceBinding {
  sourceProjectUuid: string;
  assetUuid: string;
  assetType: StoryboardAssetType;
  relationRole: string;
  voiceEnabled?: boolean;
}

export interface WorkspaceCandidate {
  candidateUuid: string;
  mediaType: StoryboardMediaType;
  relativePath: string;
  selected: boolean;
  createdAt: string;
}

export interface WorkspaceGenerationTask {
  taskUuid: string;
  mediaType: StoryboardMediaType;
  providerId: string;
  modelName: string;
  status: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceShot {
  shotUuid: string;
  displayOrder: number;
  sourceText: string | null;
  visualDescription: string | null;
  imagePrompt?: string | null;
  videoPrompt?: string | null;
  negativePrompt?: string | null;
  shotSize?: string | null;
  cameraMovement?: string | null;
  composition?: string | null;
  era?: string | null;
  durationMs?: number | null;
  aspectRatio?: string | null;
  bindings?: WorkspaceBinding[];
  candidates?: WorkspaceCandidate[];
  generationTasks?: WorkspaceGenerationTask[];
}

export interface WorkspaceAsset {
  assetUuid: string;
  name: string;
  assetType: StoryboardAssetType;
  description?: string;
  coverUrl?: string;
  sourceProjectUuid: string;
  hasAudio?: boolean;
}

export interface StoryboardQueueState {
  paused: boolean;
  maxConcurrency: number;
  queued: number;
  active: number;
  unknown: number;
}

export interface AutoMatchAssetsResult {
  selectedCount: number;
  processedCount: number;
  matchedCount: number;
  createdBindingCount: number;
  existingBindingCount: number;
  emptyPromptCount: number;
  conflictCount: number;
  conflictAssetNames?: readonly string[];
  shots?: readonly (Partial<WorkspaceShot> & { shotUuid: string })[];
}

export interface BatchReplacePromptResult {
  selectedCount: number;
  affectedShotCount: number;
  replacementCount: number;
  shots?: readonly (Partial<WorkspaceShot> & { shotUuid: string })[];
}

export const STORYBOARD_FIND_TEXT_MAX = 4000;
export const STORYBOARD_REPLACE_TEXT_MAX = 8000;

export interface StoryboardGenerationSettings {
  mediaType: StoryboardMediaType;
  providerModel: string;
  mode: StoryboardGenerationMode;
  durationMs?: number;
  aspectRatio?: string;
  resolution?: StoryboardVideoResolution | string;
}

export interface BindStoryboardAssetInput {
  assetUuid: string;
  assetType: StoryboardAssetType;
  relationRole: string;
  sourceProjectUuid?: string;
}

export interface StoryboardGenerationItem {
  shotUuid: string;
  mediaType: StoryboardMediaType;
  providerModel: string;
  /** 预览确认的执行路由；服务端会再次与 providerModel 做一致性校验。 */
  routeKind?: "dreamina-cli" | "vendor";
  mode: StoryboardGenerationSettings["mode"];
  durationMs?: number;
  aspectRatio?: string;
  resolution?: StoryboardVideoResolution | string;
  /** 服务端 preview 返回的 SHA-256 摘要；正式生成必须携带并由后端原子复核。 */
  expectedPreviewDigest?: string;
}
