export interface CornerScapeImage {
  filePath: string;
  id: number;
}

export interface CornerScapeItem {
  id: number;
  assetUuid?: string;
  imageId: number;
  type: string;
  name: string;
  remark?: string;
  imageRatio?: string;
  prompt: string;
  filePath: string | null;
  state: string;
  model: string;
  resolution: string;
  describe: string;
  promptState: string;
  historyImages: CornerScapeImage[];
  errorReason: string;
  promptErrorReason: string;
  relepedAudio: Array<{ id: number; name: string; src?: string }>;
  audioBindState: string;
}
