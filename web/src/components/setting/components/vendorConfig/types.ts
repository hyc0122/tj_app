export interface TextModel {
  name: string;
  modelName: string;
  type: "text";
  think: boolean;
}

export interface ImageModel {
  name: string;
  modelName: string;
  type: "image";
  mode: ("text" | "singleImage" | "multiReference")[];
}

export type VideoReference =
  | `videoReference:${number}`
  | `imageReference:${number}`
  | `audioReference:${number}`;

export interface VideoModel {
  name: string;
  modelName: string;
  type: "video";
  mode: (
    | "singleImage"
    | "startEndRequired"
    | "endFrameOptional"
    | "startFrameOptional"
    | "text"
    | VideoReference[]
  )[];
  audio: "optional" | false | true;
  durationResolutionMap: {
    duration: number[];
    resolution: string[];
  }[];
}

export type VendorModel = TextModel | ImageModel | VideoModel;

export interface RemoteVendorModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
}

export interface VendorInput {
  key: string;
  label: string;
  type: "text" | "password" | "url";
  required: boolean;
  placeholder?: string;
  /** 模板可禁用固定基地址等字段，界面必须原样投影 */
  disabled?: boolean;
}

export type VendorLoadState = {
  state: "idle" | "loading" | "loaded" | "error";
  generation: number;
  message?: string;
};

export const NATIVE_DREAMINA_ID = "native:dreamina-cli" as const;

export type ProviderWorkspaceItem =
  | { kind: "configured-vendor"; id: string; vendor: VendorItem }
  | { kind: "native-dreamina"; id: typeof NATIVE_DREAMINA_ID; label: string };

export interface VendorItem {
  id: string;
  author: string;
  description?: string;
  name: string;
  icon?: string;
  /** 列表接口不再返回源码；编辑时通过 getVendorCode 单独加载。 */
  code?: string;
  inputs: VendorInput[];
  inputValues: Record<string, string>;
  enabled?: boolean;
  apiKey?: string;
  baseUrl?: string;
  modelName?: string;
  model?: VendorModel[];
  models?: VendorModel[];
  enable: number;
  version?: string;
  configured?: boolean;
}

export interface DrmRow {
  duration: string[];
  resolution: string[];
}

export interface VendorModelForm {
  name: string;
  modelName: string;
  type: "text" | "image" | "video";
  think: boolean;
  mode: string[];
  mixedMode: string[];
  mixedModeCount: Record<string, number>;
  audio: "optional" | false | true;
  durationResolutionMap: DrmRow[];
}
