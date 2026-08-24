import { DialogPlugin } from "tdesign-vue-next";
import type { TabValue } from "tdesign-vue-next";
import type { Ref } from "vue";
import axios from "@/utils/axios";
import type { DirectorManualItem, ManualTab } from "./types";
import {
  createDirectorManualTabs,
  mergeManualTabs,
  normalizeManualImages,
} from "./projectDialogLogic";
import { appendImageFiles } from "./manualFiles";

export function useDirectorManual(saving: Ref<boolean>) {
  const directorManualForm = ref({
    name: "",
    images: [] as string[],
    directorManual: "",
  });
  const directorManualLoading = ref(false);
  const editingDirectorManual = ref<DirectorManualItem | null>(null);
  const directorDialogVisible = ref(false);
  const directorManualOptions = ref<DirectorManualItem[]>([]);
  const directorManualTabValue = ref<TabValue>("README");
  const directorManualTabData = ref<ManualTab[]>(createDirectorManualTabs());

  const directorManualError = ref("");

  function queryDirectorManual() {
    directorManualLoading.value = true;
    directorManualError.value = "";
    Promise.resolve(axios.post("/project/queryDirectorManual"))
      .then(({ data }) => {
        directorManualOptions.value = (Array.isArray(data) ? data : []).map(
          (item: DirectorManualItem & { image?: string | string[] }) => ({
            id: item.id,
            name: item.name,
            directorManual: item.directorManual,
            images: normalizeManualImages(item),
            data: item.data,
          }),
        );
      })
      .catch((err: Error) => {
        directorManualOptions.value = [];
        directorManualError.value = err?.message || "导演手册加载失败，请重试";
        window.$message?.error?.(directorManualError.value);
      })
      .finally(() => {
        directorManualLoading.value = false;
      });
  }

  function openDirectorManualDialog(item?: DirectorManualItem) {
    editingDirectorManual.value = item ?? null;
    if (item) {
      directorManualForm.value = {
        name: item.name,
        directorManual: item.directorManual,
        images: item.images ? [...item.images] : [],
      };
      directorManualTabData.value = mergeManualTabs(
        createDirectorManualTabs(),
        item.data,
      );
    } else {
      directorManualForm.value = {
        name: "",
        images: [],
        directorManual: "",
      };
      directorManualTabData.value = createDirectorManualTabs();
    }
    directorManualTabValue.value = "README";
    directorDialogVisible.value = true;
  }

  function resetDirectorManualDialog() {
    directorDialogVisible.value = false;
    editingDirectorManual.value = null;
    directorManualForm.value = {
      name: "",
      images: [],
      directorManual: "",
    };
    directorManualTabData.value = createDirectorManualTabs();
    directorManualTabValue.value = "README";
  }

  function handleDirectorManualCoverFileChange(event: Event) {
    const input = event.target as HTMLInputElement;
    appendImageFiles(
      input.files,
      directorManualForm.value.images,
      input,
    );
  }

  function deleteDirectorManual(item: DirectorManualItem) {
    const dialog = DialogPlugin.confirm({
      header: $t("workbench.project.msg.deleteDirectorManualHeader"),
      body: $t("workbench.project.msg.deleteDirectorManualBody", {
        name: item.directorManual,
      }),
      confirmBtn: $t("workbench.project.msg.deleteVisualManualConfirm"),
      cancelBtn: $t("workbench.project.msg.deleteVisualManualCancel"),
      onConfirm: () => {
        axios
          .post("/project/deleteDirectorManual", {
            name: item.directorManual,
          })
          .then(() => {
            resetDirectorManualDialog();
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
            queryDirectorManual();
            dialog.destroy();
          });
      },
    });
  }

  async function handleDirectorManualSubmit() {
    if (!directorManualForm.value.name.trim()) {
      window.$message.warning(
        $t("workbench.project.msg.enterVisualManualName"),
      );
      return;
    }
    if (!directorManualForm.value.images.length) {
      window.$message.warning(
        $t("workbench.project.msg.enterVisualManualImage"),
      );
      return;
    }
    const emptyTab = directorManualTabData.value.find(
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
      const endpoint = editingDirectorManual.value
        ? "/project/editDirectorlManual"
        : "/project/addDirectorManual";
      await axios.post(endpoint, {
        name: directorManualForm.value.name,
        images: directorManualForm.value.images,
        data: directorManualTabData.value,
        directorManual: directorManualForm.value.directorManual,
      });
      window.$message.success(
        $t(
          editingDirectorManual.value
            ? "workbench.project.msg.directorManualUpdated"
            : "workbench.project.msg.directorManualAdded",
        ),
      );
      resetDirectorManualDialog();
      queryDirectorManual();
    } catch (error: any) {
      window.$message.error(
        error.message ?? $t("workbench.project.msg.operationFailed"),
      );
    } finally {
      saving.value = false;
    }
  }

  return {
    deleteDirectorManual,
    directorDialogVisible,
    directorManualError,
    directorManualForm,
    directorManualLoading,
    directorManualOptions,
    directorManualTabData,
    directorManualTabValue,
    editingDirectorManual,
    handleDirectorManualCoverFileChange,
    handleDirectorManualSubmit,
    openDirectorManualDialog,
    queryDirectorManual,
    resetDirectorManualDialog,
  };
}
