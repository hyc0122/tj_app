import VENDOR_CODE_TEMPLATE from "@/lib/vendorTemplate.ts?raw";
import axios from "@/utils/axios";
import type { useVendorCatalog } from "./useVendorCatalog";

export const vendorEditorOptions = {
  fontSize: 14,
  automaticLayout: true,
  tabSize: 2,
  scrollBeyondLastLine: false,
  formatOnPaste: true,
  formatOnType: true,
};

/** 将编辑器异常归一化为有限长度的用户消息，禁止出现 [object Object]。 */
export function vendorEditorErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "string" && error.trim() && error !== "[object Object]") {
    return error.slice(0, 160);
  }
  if (error instanceof Error && error.message && error.message !== "[object Object]") {
    const message = error.message.trim();
    if (message && !/\[object Object\]/.test(message)) return message.slice(0, 160);
  }
  if (error && typeof error === "object") {
    const row = error as Record<string, any>;
    const candidate = row.message ?? row.msg ?? row.response?.data?.message;
    if (
      typeof candidate === "string"
      && candidate.trim()
      && candidate !== "[object Object]"
    ) {
      return candidate.slice(0, 160);
    }
  }
  return fallback;
}

/** 管理供应商源码加载、重置及 A/B 切换竞态，导入流程只消费公开会话状态。 */
export function useVendorCodeEditor(
  catalog: Pick<ReturnType<typeof useVendorCatalog>, "currentVendor">,
) {
  const codeDialogVisible = ref(false);
  const codeLoading = ref(false);
  const editingVendorId = ref<string>();
  const vendorCode = ref(VENDOR_CODE_TEMPLATE);
  /** 编辑模式刚加载的原始源码，供重置恢复。 */
  const loadedSourceBaseline = ref("");
  /** 源码加载代际，丢弃迟到响应。 */
  let codeLoadGeneration = 0;

  function closeCodeEditor() {
    codeLoadGeneration += 1;
    codeDialogVisible.value = false;
    codeLoading.value = false;
    loadedSourceBaseline.value = "";
  }

  /** 为新增供应商准备模板；由调用方决定是否立即打开代码对话框。 */
  function prepareNewVendorCode(openDialog: boolean) {
    codeLoadGeneration += 1;
    editingVendorId.value = undefined;
    vendorCode.value = VENDOR_CODE_TEMPLATE;
    loadedSourceBaseline.value = "";
    codeLoading.value = false;
    codeDialogVisible.value = openDialog;
  }

  /** 先按当前账号按需读取源码，成功且非空后才打开 Monaco。 */
  async function handleEditVendorCode() {
    if (!catalog.currentVendor.value || codeLoading.value) return;
    const vendorId = catalog.currentVendor.value.id;
    const generation = ++codeLoadGeneration;
    editingVendorId.value = vendorId;
    codeLoading.value = true;
    try {
      const response = await axios.post("/setting/vendorConfig/getVendorCode", {
        id: vendorId,
      });
      // 丢弃过期响应，防止 A/B 切换串内容。
      if (generation !== codeLoadGeneration) return;
      if (editingVendorId.value !== vendorId) return;
      const payload = response?.data ?? response;
      const code = typeof payload?.code === "string"
        ? payload.code
        : typeof payload === "string"
          ? payload
          : "";
      if (!code.trim()) {
        window.$message.error("供应商源码为空，请稍后重试");
        return;
      }
      vendorCode.value = code;
      loadedSourceBaseline.value = code;
      codeDialogVisible.value = true;
    } catch (error: unknown) {
      if (generation !== codeLoadGeneration) return;
      // 加载失败不得打开空编辑器。
      codeDialogVisible.value = false;
      window.$message.error(
        vendorEditorErrorMessage(error, "加载供应商源码失败，请重试"),
      );
    } finally {
      if (generation === codeLoadGeneration) codeLoading.value = false;
    }
  }

  /** 编辑模式重置到刚加载的源码；新增模式重置为默认模板。 */
  function handleResetVendorCode() {
    vendorCode.value = editingVendorId.value
      ? loadedSourceBaseline.value || VENDOR_CODE_TEMPLATE
      : VENDOR_CODE_TEMPLATE;
  }

  return {
    closeCodeEditor,
    codeDialogVisible,
    codeLoading,
    editingVendorId,
    handleEditVendorCode,
    handleResetVendorCode,
    prepareNewVendorCode,
    vendorCode,
  };
}
