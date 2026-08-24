import { DialogPlugin } from "tdesign-vue-next";
import type { TabValue } from "tdesign-vue-next";
import type { Ref } from "vue";
import axios from "@/utils/axios";
import type { ManualTab, VisualManualItem } from "./types";
import {
  createVisualManualTabs,
  mergeManualTabs,
  normalizeManualImages,
} from "./projectDialogLogic";
import { appendImageFiles } from "./manualFiles";

export function useVisualManual(saving: Ref<boolean>) {
  const visualManualOptions = ref<VisualManualItem[]>([]);
  const visualManualLoading = ref(false);
  const visualManualDialogVisible = ref(false);
  const editingVisualManual = ref<VisualManualItem | null>(null);
  const visualManualForm = ref({
    name: "",
    images: [] as string[],
    stylePath: "",
  });
  const visualManualCoverInputRef = ref<HTMLInputElement>();
  const visualManualTabValue = ref<TabValue>("README");
  const visualManualTabData = ref<ManualTab[]>(createVisualManualTabs());

  const visualManualError = ref("");

  function fetchVisualManuals() {
    visualManualLoading.value = true;
    visualManualError.value = "";
    Promise.resolve(axios.post("/project/getVisualManual"))
      .then(({ data }) => {
        visualManualOptions.value = (Array.isArray(data) ? data : []).map(
          (item: VisualManualItem & { image?: string | string[] }) => ({
            id: item.id,
            name: item.name,
            stylePath: item.stylePath,
            images: normalizeManualImages(item),
            data: item.data,
          }),
        );
      })
      .catch((err: Error) => {
        visualManualOptions.value = [];
        visualManualError.value = err?.message || "视觉手册加载失败，请重试";
        window.$message?.error?.(visualManualError.value);
      })
      .finally(() => {
        visualManualLoading.value = false;
      });
  }

  function openVisualManualDialog(item?: VisualManualItem) {
    editingVisualManual.value = item ?? null;
    if (item) {
      visualManualForm.value = {
        name: item.name,
        stylePath: item.stylePath,
        images: item.images ? [...item.images] : [],
      };
      visualManualTabData.value = mergeManualTabs(
        createVisualManualTabs(),
        item.data,
      );
    } else {
      visualManualForm.value = { name: "", images: [], stylePath: "" };
      visualManualTabData.value = createVisualManualTabs();
    }
    visualManualTabValue.value = "README";
    visualManualDialogVisible.value = true;
  }

  function resetVisualManualDialog() {
    visualManualDialogVisible.value = false;
    editingVisualManual.value = null;
    visualManualForm.value = { name: "", images: [], stylePath: "" };
    visualManualTabData.value = createVisualManualTabs();
    visualManualTabValue.value = "README";
  }

  function handleVisualManualCoverFileChange(event: Event) {
    const input = event.target as HTMLInputElement;
    appendImageFiles(
      input.files,
      visualManualForm.value.images,
      input,
    );
  }

  async function handleVisualManualSubmit() {
    if (!visualManualForm.value.name.trim()) {
      window.$message.warning(
        $t("workbench.project.msg.enterVisualManualName"),
      );
      return;
    }
    if (!visualManualForm.value.images.length) {
      window.$message.warning(
        $t("workbench.project.msg.enterVisualManualImage"),
      );
      return;
    }
    const emptyTab = visualManualTabData.value.find(
      (tab) => !tab.data.trim(),
    );
    if (emptyTab) {
      window.$message.warning(
        `「${emptyTab.label}」${$t("workbench.project.msg.enterVisualManualTabData")}`,
      );
      return;
    }
    saving.value = true;
    try {
      const endpoint = editingVisualManual.value
        ? "/project/editVisualManual"
        : "/project/addVisualManual";
      await axios.post(endpoint, {
        name: visualManualForm.value.name,
        images: visualManualForm.value.images,
        data: visualManualTabData.value,
        stylePath: visualManualForm.value.stylePath,
      });
      window.$message.success(
        $t(
          editingVisualManual.value
            ? "workbench.project.msg.visualManualUpdated"
            : "workbench.project.msg.visualManualAdded",
        ),
      );
      resetVisualManualDialog();
      fetchVisualManuals();
    } catch (error: any) {
      window.$message.error(
        error.message ?? $t("workbench.project.msg.operationFailed"),
      );
    } finally {
      saving.value = false;
    }
  }

  function deleteVisualManual(item: VisualManualItem) {
    const dialog = DialogPlugin.confirm({
      header: $t("workbench.project.msg.deleteVisualManualHeader"),
      body: $t("workbench.project.msg.deleteVisualManualBody", {
        name: item.stylePath,
      }),
      confirmBtn: $t("workbench.project.msg.deleteVisualManualConfirm"),
      cancelBtn: $t("workbench.project.msg.deleteVisualManualCancel"),
      onConfirm: () => {
        axios
          .post("/project/deleteVisualManual", { name: item.stylePath })
          .then(() => {
            resetVisualManualDialog();
            window.$message.success(
              $t("workbench.project.msg.visualManualDeleted"),
            );
          })
          .catch((error) => {
            window.$message.error(
              error.message ?? $t("workbench.project.msg.operationFailed"),
            );
          })
          .finally(() => {
            fetchVisualManuals();
            dialog.destroy();
          });
      },
    });
  }

  return {
    deleteVisualManual,
    editingVisualManual,
    fetchVisualManuals,
    handleVisualManualCoverFileChange,
    handleVisualManualSubmit,
    openVisualManualDialog,
    visualManualError,
    removeVisualManualCover: (index: number) =>
      visualManualForm.value.images.splice(index, 1),
    resetVisualManualDialog,
    triggerVisualManualCoverUpload: () =>
      visualManualCoverInputRef.value?.click(),
    visualManualCoverInputRef,
    visualManualDialogVisible,
    visualManualForm,
    visualManualLoading,
    visualManualOptions,
    visualManualTabData,
    visualManualTabValue,
  };
}
