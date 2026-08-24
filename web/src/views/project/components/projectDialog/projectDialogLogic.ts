import type {
  ManualTab,
  ProjectData,
  ProjectFormData,
  VideoMode,
} from "./types";

export const RATIO_OPTIONS = [
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
];

/** 视频生成模式标签集中构造，避免表单编排同时承担展示字典。 */
export function createProjectModeLabels(translate: (key: string) => string) {
  return {
    singleImage: translate("workbench.production.generate.modeSingleImage"),
    startEndRequired: translate("workbench.production.generate.modeStartEnd"),
    endFrameOptional: translate("workbench.production.generate.modeStartEnd"),
    startFrameOptional: translate("workbench.production.generate.modeStartEnd"),
    text: translate("workbench.production.generate.modeText"),
    videoReference: translate("workbench.production.generate.modeVideoRef"),
    imageReference: translate("workbench.production.generate.modeImageRef"),
    audioReference: translate("workbench.production.generate.modeAudioRef"),
  };
}

export const promptToolbars = [
  "bold",
  "italic",
  "strikeThrough",
  "-",
  "unorderedList",
  "orderedList",
  "-",
  "revoke",
  "next",
  "=",
  "preview",
] as const;

export function createVisualManualTabs(): ManualTab[] {
  return [
    { label: "README", value: "README", data: "" },
    { label: "前缀", value: "prefix", data: "" },
    { label: "角色", value: "art_character", data: "" },
    { label: "角色衍生", value: "art_character_derivative", data: "" },
    { label: "道具", value: "art_prop", data: "" },
    { label: "道具衍生", value: "art_prop_derivative", data: "" },
    { label: "场景", value: "art_scene", data: "" },
    { label: "场景衍生", value: "art_scene_derivative", data: "" },
    { label: "分镜", value: "director_storyboard", data: "" },
    { label: "分镜视频", value: "art_storyboard_video", data: "" },
    { label: "技法-导演规划", value: "director_planning_style", data: "" },
    {
      label: "技法-分镜表设计",
      value: "director_storyboard_table_style",
      data: "",
    },
  ];
}

export function createDirectorManualTabs(): ManualTab[] {
  return [
    { label: "README", value: "README", data: "" },
    { label: "导演规划", value: "director_planning_narrative", data: "" },
    { label: "分镜表", value: "director_storyboard_table_narrative", data: "" },
  ];
}

export function createProjectForm(
  project?: ProjectData | null,
): ProjectFormData {
  return {
    id: project?.id ?? 0,
    projectType: project?.projectType || "novel",
    name: project?.name || "",
    intro: project?.intro || "",
    type: project?.type || "",
    artStyle: project?.artStyle || "",
    era: "",
    videoRatio: project?.videoRatio || "16:9",
    createTime: 0,
    userId: 0,
    imageModel: project?.imageModel || "",
    videoModel: project?.videoModel || "",
    imageQuality: project?.imageQuality || "",
    mode: project ? project.mode || "text" : "",
    directorManual: project?.directorManual || "",
    scope: project?.kind === "team" ? "team" : "personal",
    teamUuid: project?.teamUuid || "",
    defaultLanguage: project?.defaultLanguage || "zh-CN",
    assetMode: project?.assetSourceProjectUuid ? "shared" : "independent",
    assetSourceProjectUuid: project?.assetSourceProjectUuid || "",
  };
}

const requiredFields = [
  "name",
  "type",
  "imageModel",
  "videoModel",
  "artStyle",
  "directorManual",
  "videoRatio",
  "intro",
  "imageQuality",
  "mode",
] as const;

export type RequiredProjectField = (typeof requiredFields)[number];

export function findMissingProjectField(
  form: ProjectFormData,
): RequiredProjectField | "defaultLanguage" | "assetSourceProjectUuid" | null {
  if (form.projectType === "storyboard") {
    if (!form.name) return "name";
    if (!form.intro) return "intro";
    if (!form.artStyle) return "artStyle";
    if (!form.videoRatio) return "videoRatio";
    if (!form.defaultLanguage) return "defaultLanguage";
    if (form.assetMode === "shared" && !form.assetSourceProjectUuid) {
      return "assetSourceProjectUuid";
    }
    return null;
  }
  return requiredFields.find((field) => !form[field]) ?? null;
}

export function mergeManualTabs(
  defaults: ManualTab[],
  existing: ManualTab[] | undefined,
) {
  const source = Array.isArray(existing) ? existing : [];
  return defaults.map((tab) => {
    const found = source.find((item) => item.value === tab.value);
    return found ? { ...tab, data: found.data } : { ...tab };
  });
}

export function normalizeManualImages(item: {
  image?: string | string[];
  images?: string[];
}) {
  return (
    item.images ??
    (Array.isArray(item.image)
      ? item.image
      : item.image
        ? [item.image]
        : [])
  );
}

export function modeToKey(mode: VideoMode): string {
  return Array.isArray(mode) ? JSON.stringify(mode) : mode;
}

export function getModeLabel(
  mode: VideoMode | undefined,
  labels: Record<string, string>,
): string {
  if (!mode) return "";
  if (Array.isArray(mode)) {
    return mode
      .map((reference) => labels[reference.replace(/:.*$/, "")] ?? reference)
      .join("、");
  }
  return labels[mode] ?? mode;
}
