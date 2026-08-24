import { ref } from "vue";
import { useFileDialog } from "@vueuse/core";
import { DialogPlugin } from "tdesign-vue-next";
import axios from "@/utils/axios";
import { localProjectBody } from "@/features/tianjiang/project/local-project-id";
import type { AssetRecord } from "./assetsLogic";
import type { AssetsState } from "./useAssetsState";

export function useAssetsItemActions(state: AssetsState) {
  const addAudioShow = ref(false);
  const audioFormData = ref({ name: "", describe: "", sex: "" });
  const formData = ref({
    id: 0,
    name: "",
    describe: "",
    remark: "",
    src: "",
    prompt: "",
  });
  const addAssetsShow = ref(false);
  const generateImageShow = ref(false);
  const currentAssetData = ref<{
    id?: number;
    name?: string;
    describe?: string;
    type?: string;
    prompt?: string;
    src: string;
  }>({ id: 0, src: "" });
  const { open, onChange, onCancel } = useFileDialog({
    multiple: false,
    reset: true,
    accept: ".png,.jpg,.jpeg,.mp3,.mp4",
  });

  async function selectFile(): Promise<FileList | null> {
    return new Promise((resolve) => {
      open();
      onChange((files) => resolve(files));
      onCancel(() => resolve(null));
    });
  }

  async function handleAdd(type: string) {
    if (type === "clip") {
      const files = await selectFile();
      if (!files?.length) return;
      const file = files[0];
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          // 中文注释：项目 ID 边界失败或上传失败均须提示，禁止未处理 rejection
          await axios.post(
            "/assets/uploadClip",
            localProjectBody(state.project.value?.id, {
              base64Data: reader.result as string,
              name: file.name,
            }),
          );
          window.$message.success($t("workbench.assets.uploadSuccess"));
          void state.getFilteredData(state.assetOptions.value);
        } catch (error) {
          // 中文注释：优先展示安全 Error.message；无文案时用既有 upload 语义键避免新增 i18n
          const msg =
            typeof (error as Error)?.message === "string" && (error as Error).message
              ? (error as Error).message
              : $t("workbench.assets.imageGenFail", { name: file.name, error: "" });
          window.$message.error(msg);
        }
      };
      reader.readAsDataURL(file);
      return;
    }
    if (type === "audio") {
      audioFormData.value = { name: "", describe: "", sex: "" };
      addAudioShow.value = true;
      return;
    }
    formData.value = { id: 0, name: "", describe: "", remark: "", src: "", prompt: "" };
    addAssetsShow.value = true;
  }

  function generate(row: AssetRecord) {
    currentAssetData.value = {
      id: row.id,
      name: row.name,
      describe: row.describe,
      type: row.type,
      prompt: row.prompt,
      src: row.src ?? "",
    };
    generateImageShow.value = true;
  }

  function handleEdit(row: AssetRecord) {
    if (row.type === "audio") {
      audioFormData.value = {
        name: row.name ?? "",
        describe: row.describe ?? "",
        sex: row.sex ?? "",
        ...row,
      };
      addAudioShow.value = true;
      return;
    }
    formData.value = {
      id: row.id,
      name: row.name ?? "",
      describe: row.describe ?? "",
      remark: row.remark ?? "",
      src: row.src ?? "",
      prompt: row.prompt ?? "",
    };
    addAssetsShow.value = true;
  }

  function handleDelete(row: AssetRecord) {
    const dialog = DialogPlugin.confirm({
      header: $t("workbench.assets.confirmDeleteHeader"),
      body: $t("workbench.assets.confirmDeleteBody"),
      confirmBtn: $t("workbench.assets.deleteBtn"),
      cancelBtn: $t("workbench.assets.cancelBtn"),
      theme: "warning",
      onConfirm: async () => {
        try {
          await axios.post("/assets/delAssets", { id: row.id });
          window.$message.success($t("workbench.assets.deleteSuccess"));
          void state.getFilteredData(state.assetOptions.value);
        } catch (error) {
          console.error("删除资产失败:", error);
          window.$message.error($t("workbench.assets.deleteFail"));
        } finally {
          dialog.destroy();
        }
      },
    });
  }

  return {
    addAudioShow,
    audioFormData,
    formData,
    addAssetsShow,
    generateImageShow,
    currentAssetData,
    handleAdd,
    generate,
    handleEdit,
    handleDelete,
  };
}
