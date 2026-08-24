export interface InsertShotInput {
  afterShotUuid: string | null;
  sourceText?: string;
  visualDescription?: string;
  imagePrompt?: string;
  videoPrompt?: string;
  negativePrompt?: string;
  durationMs?: number | null;
}

export interface ReorderShotsInput {
  orderedShotUuids: readonly string[];
}

export interface StoryboardAssetBindingInput {
  sourceProjectUuid: string;
  assetUuid: string;
  assetType: "role" | "scene" | "tool" | "clip" | "audio";
  relationRole: string;
  voiceEnabled?: boolean;
}

export interface StoryboardShotPatch {
  sourceText?: string | null;
  visualDescription?: string | null;
  imagePrompt?: string | null;
  videoPrompt?: string | null;
  negativePrompt?: string | null;
  shotSize?: string | null;
  cameraMovement?: string | null;
  composition?: string | null;
  era?: string | null;
  durationMs?: number | null;
  aspectRatio?: string | null;
  overrideJson?: string | null;
}

export interface StoryboardCandidateDto {
  candidateUuid: string;
  mediaType: "image" | "video";
  relativePath: string;
  selected: boolean;
  createdAt: string;
}

export interface StoryboardGenerationTaskDto {
  taskUuid: string;
  mediaType: "image" | "video";
  providerId: string;
  modelName: string;
  status: string;
  createdAt: number;
  updatedAt: number;
}

export interface StoryboardShotDto {
  shotUuid: string;
  displayOrder: number;
  sourceText: string | null;
  visualDescription: string | null;
  imagePrompt: string | null;
  videoPrompt: string | null;
  negativePrompt: string | null;
  shotSize: string | null;
  cameraMovement: string | null;
  composition: string | null;
  era: string | null;
  durationMs?: number | null;
  aspectRatio: string | null;
  bindings: readonly StoryboardAssetBindingInput[];
  candidates: readonly StoryboardCandidateDto[];
  generationTasks: readonly StoryboardGenerationTaskDto[];
}

export interface AutoMatchAssetsInput {
  shotUuids: readonly string[];
}

export type AutoMatchShotResult = StoryboardShotDto & {
  matchedCount: number;
  createdBindingCount: number;
  existingBindingCount: number;
  emptyPrompt: boolean;
  conflictCount: number;
};

export interface AutoMatchAssetsResult {
  selectedCount: number;
  processedCount: number;
  matchedCount: number;
  createdBindingCount: number;
  existingBindingCount: number;
  emptyPromptCount: number;
  conflictCount: number;
  conflictAssetNames: readonly string[];
  shots: readonly AutoMatchShotResult[];
}

export interface BatchReplacePromptInput {
  shotUuids: readonly string[];
  findText: string;
  replaceText: string;
}

export type BatchReplaceShotResult = StoryboardShotDto & {
  replacementCount: number;
};

export interface BatchReplacePromptResult {
  selectedCount: number;
  affectedShotCount: number;
  replacementCount: number;
  shots: readonly BatchReplaceShotResult[];
}
