import type {
  DrmRow,
  VendorItem,
  VendorModel,
  VendorModelForm,
  VideoModel,
} from "./types";

export const TYPE_LABEL_MAP: Record<string, string> = {
  text: "settings.vendor.textModel",
  image: "settings.vendor.imageModel",
  video: "settings.vendor.videoModel",
};

export const MODE_LABEL_MAP: Record<string, string> = {
  singleImage: "settings.vendor.singleImage",
  multiReference: "settings.vendor.multiReference",
  startEndRequired: "settings.vendor.startEndRequired",
  endFrameOptional: "settings.vendor.endFrameOptional",
  startFrameOptional: "settings.vendor.startFrameOptional",
  audioReference: "settings.vendor.audioRef",
  videoReference: "settings.vendor.videoRef",
  imageReference: "settings.vendor.imageRef",
};

export function isValidBase64(value?: string): boolean {
  if (!value) return false;
  const base64Regex = /^(?:data:[^;]+;base64,)?[A-Za-z0-9+/]*={0,2}$/;
  return base64Regex.test(value);
}

export function needsVendorUpdate(vendor: Pick<VendorItem, "version">): boolean {
  if (!vendor.version) return true;
  const version = Number.parseFloat(vendor.version);
  return Number.isNaN(version) || version < 2;
}

export function buildVendorUpdatePayload(
  vendor: Pick<VendorItem, "id" | "inputValues">,
) {
  return {
    id: vendor.id,
    inputValues: vendor.inputValues,
  };
}

export function buildVideoModes(
  mode: string[],
  mixedMode: string[],
  mixedModeCount: Record<string, number>,
): VideoModel["mode"] {
  const result = mode.filter((item) => item !== "multiReference") as VideoModel["mode"];
  if (mixedMode.length > 0) {
    result.push(
      mixedMode.map((reference) => {
        const count = mixedModeCount[reference] ?? 1;
        return `${reference}:${count}` as `${string}:${number}`;
      }) as VideoModel["mode"][number],
    );
  }
  return result;
}

export function parseVideoModes(mode: VideoModel["mode"]) {
  const flatMode: string[] = [];
  const mixedMode: string[] = [];
  const mixedModeCount: Record<string, number> = {};

  for (const item of mode) {
    if (!Array.isArray(item)) {
      flatMode.push(item);
      continue;
    }
    for (const reference of item) {
      const match = String(reference).match(
        /^(videoReference|imageReference|audioReference):(\d+)$/,
      );
      if (!match) continue;
      mixedMode.push(match[1]);
      mixedModeCount[match[1]] = Number(match[2]);
    }
  }

  return {
    mode: mixedMode.length > 0 ? [...flatMode, "multiReference"] : flatMode,
    mixedMode,
    mixedModeCount,
  };
}

export function normalizeDurationResolutionRows(rows: DrmRow[]):
  | { ok: true; rows: VideoModel["durationResolutionMap"] }
  | { ok: false; rowIndex: number; field: "duration" | "resolution" } {
  const normalized: VideoModel["durationResolutionMap"] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const duration = row.duration
      .map(Number)
      .filter((value) => Number.isFinite(value) && value > 0);
    const resolution = row.resolution.filter(Boolean);
    if (duration.length === 0) return { ok: false, rowIndex: index, field: "duration" };
    if (resolution.length === 0) {
      return { ok: false, rowIndex: index, field: "resolution" };
    }
    normalized.push({ duration, resolution });
  }
  return { ok: true, rows: normalized };
}

export function createEmptyModelForm(
  type: VendorModelForm["type"] = "text",
): VendorModelForm {
  return {
    name: "",
    modelName: "",
    type,
    think: false,
    mode: [],
    mixedMode: [],
    mixedModeCount: {},
    audio: "optional",
    durationResolutionMap: [{ duration: [], resolution: [] }],
  };
}

export function createModelForm(model: VendorModel): VendorModelForm {
  if (model.type === "text") {
    return {
      ...createEmptyModelForm("text"),
      name: model.name,
      modelName: model.modelName,
      think: model.think,
    };
  }
  if (model.type === "image") {
    return {
      ...createEmptyModelForm("image"),
      name: model.name,
      modelName: model.modelName,
      mode: [...model.mode],
    };
  }

  const parsed = parseVideoModes(model.mode);
  return {
    ...createEmptyModelForm("video"),
    name: model.name,
    modelName: model.modelName,
    ...parsed,
    audio: model.audio,
    durationResolutionMap:
      model.durationResolutionMap?.map((row) => ({
        duration: row.duration.map(String),
        resolution: [...row.resolution],
      })) ?? [{ duration: [], resolution: [] }],
  };
}

export function getTypeLabel(type: string) {
  return TYPE_LABEL_MAP[type] || type;
}

export function getModeLabel(
  mode: string,
  type: string,
  translate: (key: string) => string,
) {
  if (mode === "text") {
    return translate(
      type === "image"
        ? "settings.vendor.textToImage"
        : "settings.vendor.textToVideo",
    );
  }
  const reference = String(mode).match(
    /^(videoReference|imageReference|audioReference):(\d+)$/,
  );
  if (reference) {
    const label = MODE_LABEL_MAP[reference[1]];
    return label ? `${translate(label)} ×${reference[2]}` : mode;
  }
  return MODE_LABEL_MAP[mode] ? translate(MODE_LABEL_MAP[mode]) : mode;
}
