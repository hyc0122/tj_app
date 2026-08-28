import { DialogPlugin } from "tdesign-vue-next";
import axios from "@/utils/axios";
import type { useVendorCatalog } from "./useVendorCatalog";
import type { VendorModel, VideoModel } from "./types";
import { useVendorRemoteModels } from "./useVendorRemoteModels";
import {
  buildVideoModes,
  createEmptyModelForm,
  createModelForm,
  getModeLabel as resolveModeLabel,
  getTypeLabel,
  normalizeDurationResolutionRows,
} from "./vendorConfigLogic";

export const modelTypeOptions = [
  { value: "text", label: "settings.vendor.textModel" },
  { value: "image", label: "settings.vendor.imageModel" },
  { value: "video", label: "settings.vendor.videoModel" },
];

export const imageModeOptions = [
  { label: "settings.vendor.textToImage", value: "text" },
  { label: "settings.vendor.singleImage", value: "singleImage" },
  { label: "settings.vendor.multiReference", value: "multiReference" },
];

export const videoModeOptions = [
  { label: "settings.vendor.singleImage", value: "singleImage" },
  { label: "settings.vendor.startEndRequired", value: "startEndRequired" },
  { label: "settings.vendor.endFrameOptional", value: "endFrameOptional" },
  { label: "settings.vendor.startFrameOptional", value: "startFrameOptional" },
  { label: "settings.vendor.textToVideo", value: "text" },
  { label: "settings.vendor.multiReferenceMode", value: "multiReference" },
];

export const referenceOptions = [
  { label: "settings.vendor.videoRef", value: "videoReference" },
  { label: "settings.vendor.imageRef", value: "imageReference" },
  { label: "settings.vendor.audioRef", value: "audioReference" },
];

export const audioOptions = [
  { label: "settings.vendor.audioOptional", value: "optional" },
  { label: "settings.vendor.audioOnly", value: true },
  { label: "settings.vendor.noAudio", value: false },
] as const;

export function useVendorModels(
  catalog: Pick<
    ReturnType<typeof useVendorCatalog>,
    "currentVendor" | "getVendorList" | "vendorModels"
  >,
) {
  const modelDialogVisible = ref(false);
  const editingModelIndex = ref<number | null>(null);
  const editingModelName = ref<string | null>(null);
  const modelFormData = ref(createEmptyModelForm());
  const testingModel = ref<VendorModel | null>(null);
  const textTestVisible = ref(false);
  const imageTestVisible = ref(false);
  const videoTestVisible = ref(false);
  const {
    loadRemoteModels,
    remoteModels,
    remoteModelsLoaded,
    remoteModelsLoading,
    resetRemoteModels,
    selectedRemoteModelId,
    selectRemoteModel,
  } = useVendorRemoteModels(catalog, modelFormData);

  function resetModelForm(type: "text" | "image" | "video" = "text") {
    modelFormData.value = createEmptyModelForm(type);
  }

  function ensureVendorModels(): VendorModel[] {
    const vendor = catalog.currentVendor.value;
    if (!vendor) return [];
    if (!Array.isArray(vendor.models)) {
      vendor.models = Array.isArray(vendor.model) ? [...vendor.model] : [];
    }
    vendor.model = vendor.models;
    return vendor.models;
  }

  function buildModelFromForm(): VendorModel | null {
    const name = modelFormData.value.name.trim();
    const modelName = modelFormData.value.modelName.trim();
    if (!name) {
      window.$message.error($t("settings.vendor.msg.fillDisplayName"));
      return null;
    }
    if (!modelName) {
      window.$message.error($t("settings.vendor.msg.fillModelId"));
      return null;
    }
    if (modelFormData.value.type === "text") {
      return {
        name,
        modelName,
        type: "text",
        think: modelFormData.value.think,
      };
    }
    if (modelFormData.value.type === "image") {
      if (modelFormData.value.mode.length === 0) {
        window.$message.error($t("settings.vendor.msg.selectImageMode"));
        return null;
      }
      return {
        name,
        modelName,
        type: "image",
        mode: modelFormData.value.mode as ("text" | "singleImage" | "multiReference")[],
      };
    }

    const mode = buildVideoModes(
      modelFormData.value.mode,
      modelFormData.value.mixedMode,
      modelFormData.value.mixedModeCount,
    );
    if (mode.length === 0) {
      window.$message.error($t("settings.vendor.msg.selectVideoMode"));
      return null;
    }
    const normalized = normalizeDurationResolutionRows(
      modelFormData.value.durationResolutionMap,
    );
    if (!normalized.ok) {
      const detail = normalized.field === "duration"
        ? $t("settings.vendor.msg.addDuration")
        : $t("settings.vendor.msg.addResolution");
      window.$message.error(
        `${$t("settings.vendor.msg.groupPrefix", {
          n: normalized.rowIndex + 1,
        })}${detail}`,
      );
      return null;
    }
    return {
      name,
      modelName,
      type: "video",
      mode,
      audio: modelFormData.value.audio,
      durationResolutionMap: normalized.rows,
    } satisfies VideoModel;
  }

  function handleAddModel() {
    if (!catalog.currentVendor.value) {
      window.$message.error($t("settings.vendor.msg.selectVendorFirst"));
      return;
    }
    editingModelIndex.value = null;
    editingModelName.value = null;
    resetRemoteModels();
    resetModelForm(catalog.currentVendor.value.id === "tianjiang" ? "video" : "text");
    modelDialogVisible.value = true;
  }

  async function handleConfirmModel() {
    const list = ensureVendorModels();
    if (list.length === 0 && !catalog.currentVendor.value) return;
    const model = buildModelFromForm();
    if (!model) return;
    const duplicateIndex = list.findIndex(
      (item, index) =>
        index !== editingModelIndex.value && item.modelName === model.modelName,
    );
    if (duplicateIndex !== -1) {
      window.$message.error($t("settings.vendor.msg.modelIdExists"));
      return;
    }
    try {
      if (editingModelIndex.value === null) {
        await axios.post("/setting/vendorConfig/addVendorModel", {
          id: catalog.currentVendor.value!.id,
          model,
        });
        window.$message.success($t("settings.vendor.msg.modelAdded"));
      } else {
        await axios.post("/setting/vendorConfig/upVendorModel", {
          id: catalog.currentVendor.value!.id,
          modelName: editingModelName.value,
          model,
        });
        window.$message.success($t("settings.vendor.msg.modelUpdated"));
      }
      modelDialogVisible.value = false;
      const { modelCatalogStore } = await import("@/features/models/modelCatalogStore");
      modelCatalogStore.invalidateAll();
      void catalog.getVendorList();
    } catch (error: any) {
      window.$message.error(
        error.message ?? $t("settings.vendor.msg.operationFailed"),
      );
    }
  }

  function handleEditModel(model: VendorModel) {
    const list = ensureVendorModels();
    editingModelIndex.value = list.findIndex(
      (item) => item.modelName === model.modelName,
    );
    editingModelName.value = model.modelName;
    modelFormData.value = createModelForm(model);
    modelDialogVisible.value = true;
  }

  function handleTestModel(model: VendorModel) {
    testingModel.value = model;
    if (model.type === "text") textTestVisible.value = true;
    if (model.type === "image") imageTestVisible.value = true;
    if (model.type === "video") videoTestVisible.value = true;
  }

  function handleDeleteModel(modelName: string) {
    if (!catalog.currentVendor.value) return;
    const dialog = DialogPlugin.confirm({
      theme: "danger",
      header: $t("settings.vendor.msg.deleteModelConfirm"),
      body: $t("settings.vendor.msg.deleteModelBody", { name: modelName }),
      confirmBtn: {
        content: $t("settings.vendor.msg.confirmDelete"),
        theme: "danger",
      },
      cancelBtn: $t("settings.vendor.msg.cancel"),
      onConfirm: async () => {
        try {
          await axios.post("/setting/vendorConfig/delVendorModel", {
            id: catalog.currentVendor.value!.id,
            modelName,
          });
          window.$message.success($t("settings.vendor.msg.modelDeleted"));
          void catalog.getVendorList();
        } catch (error: any) {
          window.$message.error(
            error.message ?? $t("settings.vendor.msg.operationFailed"),
          );
        } finally {
          dialog.destroy();
        }
      },
    });
  }

  return {
    audioOptions,
    editingModelIndex,
    getModeLabel: (mode: string, type: string) =>
      resolveModeLabel(mode, type, $t),
    getTypeLabel,
    handleAddModel,
    handleConfirmModel,
    handleDeleteModel,
    handleEditModel,
    handleTestModel,
    imageModeOptions,
    imageTestVisible,
    modelDialogVisible,
    modelFormData,
    modelTypeOptions,
    loadRemoteModels,
    referenceOptions,
    remoteModels,
    remoteModelsLoaded,
    remoteModelsLoading,
    selectedRemoteModelId,
    selectRemoteModel,
    testingModel,
    textTestVisible,
    videoModeOptions,
    videoTestVisible,
  };
}
