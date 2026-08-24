import { DialogPlugin, LoadingPlugin } from "tdesign-vue-next";
import type { UploadFile } from "tdesign-vue-next";
import axios from "@/utils/axios";
import type { useVendorCatalog } from "./useVendorCatalog";
import {
  useVendorCodeEditor,
  vendorEditorErrorMessage,
  vendorEditorOptions,
} from "./useVendorCodeEditor";

export function useVendorImport(
  catalog: Pick<
    ReturnType<typeof useVendorCatalog>,
    "currentVendor" | "getVendorList"
  >,
) {
  const vendorDialogVisible = ref(false);
  const codeEditor = useVendorCodeEditor(catalog);
  const {
    closeCodeEditor,
    codeDialogVisible,
    codeLoading,
    editingVendorId,
    handleEditVendorCode,
    handleResetVendorCode,
    prepareNewVendorCode,
    vendorCode,
  } = codeEditor;
  const fileInputRef = ref<HTMLInputElement | null>(null);
  const uploadRef = ref();
  const fileList = ref<any[]>([]);
  const addMode = ref("importAdd");
  const link = ref("");
  const linkReading = ref(false);
  const updating = ref(false);

  function refreshAndClose() {
    vendorDialogVisible.value = false;
    closeCodeEditor();
    void catalog.getVendorList();
  }

  function openDoubleConfirmation(
    bodyKey: string,
    secondBodyKey: string,
    confirmKey: string,
    action: () => Promise<void>,
  ) {
    const first = DialogPlugin.confirm({
      theme: "danger",
      header: $t("settings.vendor.msg.highRiskConfirm"),
      body: $t(bodyKey),
      confirmBtn: {
        content: $t("settings.vendor.msg.iKnowRisk"),
        theme: "danger",
      },
      cancelBtn: $t("settings.vendor.msg.cancel"),
      onConfirm: () => {
        first.destroy();
        const second = DialogPlugin.confirm({
          theme: "danger",
          header: $t("settings.vendor.msg.confirmAgain"),
          body: $t(secondBodyKey),
          confirmBtn: { content: $t(confirmKey), theme: "danger" },
          cancelBtn: $t("settings.vendor.msg.goBackCheck"),
          onConfirm: async () => {
            try {
              await action();
            } finally {
              second.destroy();
            }
          },
          onClose: () => second.hide(),
        });
      },
      onClose: () => first.hide(),
    });
  }

  function handleAddVendor() {
    addMode.value = "importAdd";
    prepareNewVendorCode(false);
    vendorDialogVisible.value = true;
  }

  function handleConfirmVendor() {
    const isEditing = Boolean(editingVendorId.value);
    // 冻结打开编辑器时的供应商 ID，防止后台切换写错文件。
    const frozenVendorId = editingVendorId.value;
    openDoubleConfirmation(
      isEditing
        ? "settings.vendor.msg.updateVendorRiskBody"
        : "settings.vendor.msg.addVendorRiskBody",
      isEditing
        ? "settings.vendor.msg.updateVendorConfirmBody"
        : "settings.vendor.msg.addVendorConfirmBody",
      isEditing
        ? "settings.vendor.msg.confirmAndUpdate"
        : "settings.vendor.msg.confirmAndAdd",
      async () => {
        try {
          if (frozenVendorId) {
            await axios.post("/setting/vendorConfig/updateCode", {
              id: frozenVendorId,
              tsCode: vendorCode.value,
            });
            window.$message.success($t("settings.vendor.msg.updateSuccess"));
          } else {
            await axios.post("/setting/vendorConfig/addVendor", {
              tsCode: vendorCode.value,
            });
            window.$message.success($t("settings.vendor.msg.vendorAdded"));
          }
          refreshAndClose();
        } catch (error: any) {
          const fallback = isEditing
            ? "settings.vendor.msg.updateFailed"
            : "settings.vendor.msg.addFailed";
          window.$message.error(
            vendorEditorErrorMessage(error, $t(fallback)),
          );
        }
      },
    );
  }

  watch(addMode, (value) => {
    if (value === "codeAdd") {
      prepareNewVendorCode(true);
    } else {
      closeCodeEditor();
    }
  });

  function showInvalidLinkContent(data: string) {
    if (data.includes("<html>")) {
      const dialog = DialogPlugin.alert({
        theme: "danger",
        header:
          "链接返回了一个网页，添加供应商需要返回TS代码，请确认链接是否正确",
        body:
          "请勿输入中转站地址，如需使用中转站请修改OpenAI标准接口的baseUrl使用中转站地址",
        onConfirm: () => dialog.hide(),
      });
      return;
    }
    const dialog = DialogPlugin.alert({
      theme: "danger",
      header:
        "链接返回的内容不正确，添加供应商需要返回TS代码，请确认链接是否正确",
      onConfirm: () => dialog.hide(),
    });
  }

  function linkRead() {
    if (linkReading.value) return;
    openDoubleConfirmation(
      "settings.vendor.msg.linkAddVendorRiskBody",
      "settings.vendor.msg.addVendorConfirmBody",
      "settings.vendor.msg.confirmAndAdd",
      async () => {
        const loading = LoadingPlugin({
          fullscreen: true,
          attach: "body",
          preventScrollThrough: false,
        });
        const timer = setTimeout(() => loading.hide(), 1000);
        linkReading.value = true;
        try {
          const { data } = await axios.post(
            "/setting/vendorConfig/getCodeByLink",
            { link: link.value },
          );
          if (data.includes("<html>")) {
            showInvalidLinkContent(data);
            return;
          }
          if (!data.includes("vendor")) {
            showInvalidLinkContent(data);
            return;
          }
          if (!data) {
            window.$message.error($t("settings.vendor.msg.linkAddFailed"));
            codeDialogVisible.value = false;
            return;
          }
          await axios.post("/setting/vendorConfig/addVendor", { tsCode: data });
          window.$message.success($t("settings.vendor.msg.vendorAdded"));
          refreshAndClose();
        } catch (error: any) {
          window.$message.error(
            vendorEditorErrorMessage(
              error,
              $t("settings.vendor.msg.addFailed"),
            ),
          );
        } finally {
          clearTimeout(timer);
          loading.hide();
          linkReading.value = false;
        }
      },
    );
  }

  function readFile(file: File) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.readAsText(file);
    });
  }

  async function handleBeforeUpload(file: UploadFile) {
    const rawFile = file.raw;
    if (!rawFile) {
      window.$message.error($t("workbench.novel.import.msg.selectFile"));
      return false;
    }
    openDoubleConfirmation(
      "settings.vendor.msg.importAdd",
      "settings.vendor.msg.addVendorConfirmBody",
      "settings.vendor.msg.confirmAndAdd",
      async () => {
        try {
          const content = await readFile(rawFile);
          await axios.post("/setting/vendorConfig/addVendor", {
            tsCode: content,
          });
          window.$message.success($t("settings.vendor.msg.vendorAdded"));
          refreshAndClose();
        } catch (error: any) {
          window.$message.error(
            vendorEditorErrorMessage(error, $t("settings.vendor.msg.addFailed")),
          );
        }
      },
    );
    return false;
  }

  async function handleDrop(event: DragEvent) {
    const files = event.dataTransfer?.files;
    if (files?.length) await handleBeforeUpload({ raw: files[0] });
  }

  function handleFileChange(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (loadEvent) => {
      vendorCode.value = String(loadEvent.target?.result ?? "");
    };
    reader.readAsText(file);
    input.value = "";
  }

  return {
    addMode,
    codeDialogVisible,
    codeLoading,
    editorOptions: vendorEditorOptions,
    fileInputRef,
    fileList,
    handleAddVendor,
    handleBeforeUpload,
    handleConfirmVendor,
    handleDrop,
    handleEditVendorCode,
    handleFileChange,
    handleResetVendorCode,
    link,
    linkRead,
    linkReading,
    requestMethod: () =>
      Promise.resolve({ response: {}, status: "success" } as const),
    triggerUpload: () => uploadRef.value?.triggerUpload(),
    updating,
    uploadRef,
    vendorCode,
    vendorDialogVisible,
  };
}
