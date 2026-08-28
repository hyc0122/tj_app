import type { Ref } from "vue";
import axios from "@/utils/axios";
import type { useVendorCatalog } from "./useVendorCatalog";
import type { RemoteVendorModel, VendorModelForm } from "./types";
import { createEmptyModelForm } from "./vendorConfigLogic";

export function useVendorRemoteModels(
  catalog: Pick<ReturnType<typeof useVendorCatalog>, "currentVendor">,
  modelFormData: Ref<VendorModelForm>,
) {
  const remoteModels = ref<RemoteVendorModel[]>([]);
  const remoteModelsLoading = ref(false);
  const remoteModelsLoaded = ref(false);
  const selectedRemoteModelId = ref("");

  function resetRemoteModels() {
    remoteModels.value = [];
    remoteModelsLoaded.value = false;
    selectedRemoteModelId.value = "";
  }

  async function loadRemoteModels() {
    const vendor = catalog.currentVendor.value;
    if (!vendor || vendor.id !== "tianjiang" || remoteModelsLoading.value) return;
    remoteModelsLoading.value = true;
    try {
      const response = await axios.post("/setting/vendorConfig/listRemoteModels", {
        id: vendor.id,
      });
      const rows = Array.isArray(response?.data?.models) ? response.data.models : [];
      remoteModels.value = rows.filter(
        (item: unknown): item is RemoteVendorModel =>
          Boolean(
            item
              && typeof item === "object"
              && typeof (item as RemoteVendorModel).id === "string",
          ),
      );
      remoteModelsLoaded.value = true;
    } catch (error: any) {
      window.$message.error(error?.message ?? $t("settings.vendor.remoteModelsFailed"));
    } finally {
      remoteModelsLoading.value = false;
    }
  }

  function selectRemoteModel(modelId: string) {
    const id = String(modelId ?? "").trim();
    if (!id) return;
    selectedRemoteModelId.value = id;
    // 佳速远端模型按需求默认作为视频模型，名称与标识均使用远端模型 ID。
    modelFormData.value = {
      ...createEmptyModelForm("video"),
      name: id,
      modelName: id,
    };
  }

  return {
    loadRemoteModels,
    remoteModels,
    remoteModelsLoaded,
    remoteModelsLoading,
    resetRemoteModels,
    selectedRemoteModelId,
    selectRemoteModel,
  };
}
