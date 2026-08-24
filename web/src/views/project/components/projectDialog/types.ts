export interface ProjectData {
  /** 中央项目 UUID；本地遗留项目使用空字符串。 */
  projectUuid: string;
  /** 中央归属；编辑时只展示，不允许迁移。 */
  kind: "personal" | "team";
  teamUuid: string;
  teamName?: string;
  accessMode: "readwrite" | "readonly" | "recovery";
  id: string;
  name: string;
  intro: string;
  type: string;
  artStyle: string | null;
  directorManual: string | null;
  videoRatio: string | null;
  imageModel: string;
  videoModel: string;
  projectType: string;
  imageQuality: "1K" | "2K" | "4K" | "";
  visualManual?: string;
  mode: string;
  defaultLanguage?: string;
  assetSourceProjectUuid?: string;
}

export interface ProjectFormData {
  id: number | string;
  projectType: string;
  name: string;
  intro: string;
  type: string;
  artStyle: string;
  directorManual: string;
  videoRatio: string;
  imageModel: string;
  videoModel: string;
  imageQuality: "1K" | "2K" | "4K" | "";
  mode: string;
  era: string;
  createTime: number;
  userId: number;
  /** 创建时归属：个人/团队 */
  scope: "personal" | "team";
  /** 仅团队项目 */
  teamUuid: string;
  defaultLanguage: string;
  assetMode: "independent" | "shared";
  assetSourceProjectUuid: string;
}

/** 编辑保存时的完整业务字段；排除仅由本地数据库维护的审计字段。 */
export type ProjectEditPayload = Omit<
  ProjectFormData,
  "era" | "createTime" | "userId" | "id"
> & { id: string };

export interface ManualTab {
  label: string;
  value: string;
  data: string;
}

export interface VisualManualItem {
  id?: string | number;
  name: string;
  images?: string[];
  data?: ManualTab[];
  stylePath: string;
}

export interface DirectorManualItem {
  id?: string | number;
  name: string;
  images?: string[];
  data?: ManualTab[];
  directorManual: string;
}

export type VideoMode =
  | "singleImage"
  | "startEndRequired"
  | "endFrameOptional"
  | "startFrameOptional"
  | "text"
  | (
      | `videoReference:${number}`
      | `imageReference:${number}`
      | `audioReference:${number}`
    )[];
