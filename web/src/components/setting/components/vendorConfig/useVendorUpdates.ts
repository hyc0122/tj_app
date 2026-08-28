import { computed, ref, watch } from "vue";
import { DialogPlugin } from "tdesign-vue-next";

import axios from "@/utils/axios";
import type { useVendorCatalog } from "./useVendorCatalog";

interface VendorUpdateResult {
  hasUpdate: boolean;
  latestVersion: string;
  notice: string;
}

export function useVendorUpdates(
  catalog: Pick<ReturnType<typeof useVendorCatalog>, "currentVendor" | "getVendorList">,
) {
  const checkingVendorUpdate = ref(false);
  const installingVendorUpdate = ref(false);
  const hasVendorUpdate = ref(false);
  const latestVendorVersion = ref("");
  const vendorUpdateNotice = ref("");
  const canUpdateVendor = computed(() => catalog.currentVendor.value?.id === "tianjiang");
  const vendorUpdateBusy = computed(
    () => checkingVendorUpdate.value || installingVendorUpdate.value,
  );

  function resetVendorUpdateState() {
    hasVendorUpdate.value = false;
    latestVendorVersion.value = "";
    vendorUpdateNotice.value = "";
  }

  async function checkVendorUpdate() {
    const vendor = catalog.currentVendor.value;
    if (!vendor || vendor.id !== "tianjiang" || vendorUpdateBusy.value) return;
    checkingVendorUpdate.value = true;
    try {
      // 页面只提交公开供应商 ID，API Key 始终由本地后端从当前账号库注入。
      const response = await axios.post("/setting/vendorConfig/checkVendorUpdate", {
        id: vendor.id,
      });
      const result = response?.data as VendorUpdateResult | undefined;
      if (!result || typeof result.latestVersion !== "string") {
        throw new Error("佳速配置更新响应无效");
      }
      hasVendorUpdate.value = result.hasUpdate === true;
      latestVendorVersion.value = result.latestVersion;
      vendorUpdateNotice.value = typeof result.notice === "string" ? result.notice : "";
      if (!hasVendorUpdate.value) window.$message.info("当前佳速配置已是最新版本");
    } catch (error: any) {
      window.$message.error(error?.message ?? "检查佳速配置更新失败，请稍后重试");
    } finally {
      checkingVendorUpdate.value = false;
    }
  }

  function confirmVendorUpdate() {
    const vendor = catalog.currentVendor.value;
    if (!vendor || vendor.id !== "tianjiang" || !hasVendorUpdate.value || vendorUpdateBusy.value) {
      return;
    }
    const targetVersion = latestVendorVersion.value;
    const dialog = DialogPlugin.confirm({
      header: "更新佳速配置",
      body: `确认更新到 ${targetVersion}？更新只替换配置代码，现有 API Key 和自定义地址会保留。`,
      confirmBtn: "确认更新",
      cancelBtn: "取消",
      onConfirm: async () => {
        installingVendorUpdate.value = true;
        try {
          await axios.post("/setting/vendorConfig/installVendorUpdate", { id: vendor.id });
          await catalog.getVendorList();
          resetVendorUpdateState();
          window.$message.success(`佳速配置已更新到 ${targetVersion}`);
        } catch (error: any) {
          window.$message.error(error?.message ?? "更新佳速配置失败，请稍后重试");
        } finally {
          installingVendorUpdate.value = false;
          dialog.destroy();
        }
      },
      onClose: () => dialog.hide(),
    });
  }

  watch(
    () => `${catalog.currentVendor.value?.id ?? ""}:${catalog.currentVendor.value?.version ?? ""}`,
    resetVendorUpdateState,
  );

  return {
    canUpdateVendor,
    checkingVendorUpdate,
    confirmVendorUpdate,
    checkVendorUpdate,
    hasVendorUpdate,
    installingVendorUpdate,
    latestVendorVersion,
    vendorUpdateBusy,
    vendorUpdateNotice,
  };
}
