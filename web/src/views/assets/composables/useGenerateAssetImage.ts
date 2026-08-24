import { ref, watch, type Ref } from "vue";
import { storeToRefs } from "pinia";
import { DialogPlugin } from "tdesign-vue-next";
import axios from "@/utils/axios";
import { localProjectBody, toLocalProjectId } from "@/features/tianjiang/project/local-project-id";
import projectStore from "@/stores/project";

export interface GenerateAssetForm {
  id?: number;
  name?: string;
  describe?: string;
  type?: string;
  prompt?: string;
  src: string;
}

interface GeneratedImage {
  id: string;
  src: string;
  state: string;
  selected?: boolean;
}

export function useGenerateAssetImage(
  formData: GenerateAssetForm,
  dialogVisible: Ref<boolean>,
  emitUpdate: () => void,
) {
  const { project } = storeToRefs(projectStore());
  const referenceFileList = ref<any[]>([]);
  const customFileList = ref<any[]>([]);
  const autoUpload = ref(false);
  const showImageFileName = ref(false);
  const generateLoading = ref(false);
  const promptLoading = ref(false);
  const selectValue = ref("");
  const resolution = ref("1K");
  const value2 = ref("");
  const resultImages = ref<GeneratedImage[]>([]);
  const visible = ref(false);
  const trigger = ref("");
  const selectedImageIndex = ref<number | null>(null);
  const hoveredImageIndex = ref<number | null>(null);
  let pollingTimer: ReturnType<typeof setTimeout> | null = null;

  function stopPolling() {
    if (!pollingTimer) return;
    clearTimeout(pollingTimer);
    pollingTimer = null;
  }

  function handleCancel() {
    dialogVisible.value = false;
    generateLoading.value = false;
    stopPolling();
    emitUpdate();
  }

  async function generatePrompt() {
    promptLoading.value = true;
    try {
      const { data } = await axios.post("/assetsGenerate/polishAssetsPrompt", {
        projectId: toLocalProjectId(project.value?.id),
        assetsId: formData.id,
        type: formData.type ?? "props",
        name: formData.name,
        describe: formData.describe || $t("workbench.assets.noDescription"),
      });
      window.$message.success($t("workbench.assets.gen.promptSuccess"));
      if (data.assetsId === formData.id) formData.prompt = data.prompt;
    } catch (error) {
      window.$message.error((error as Error)?.message ?? $t("workbench.assets.gen.promptFail"));
    } finally {
      promptLoading.value = false;
    }
  }

  async function readReferenceImage() {
    const file = referenceFileList.value[0]?.raw;
    if (!(file instanceof File)) return "";
    return new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsDataURL(file);
    });
  }

  async function fetchGeneratedImages() {
    const { data } = await axios.post("/assets/getImage", { assetsId: formData.id });
    const images: GeneratedImage[] = data.tempAssets.map(
      (item: { id: string; filePath: string; state: string; selected?: boolean }) => ({
        id: item.id,
        src: item.filePath,
        state: item.state,
        selected: item.selected ?? false,
      }),
    );
    resultImages.value = images;
    const selectedIndex = images.findIndex((image) => image.selected);
    if (selectedIndex !== -1) selectedImageIndex.value = selectedIndex;
    stopPolling();
    if (images.some((image) => image.state === "生成中") && dialogVisible.value) {
      pollingTimer = setTimeout(() => void fetchGeneratedImages(), 3000);
    }
  }

  async function handleGenerate() {
    if (!formData.prompt) {
      window.$message.error($t("workbench.assets.gen.fillPrompt"));
      return;
    }
    if (!resolution.value || !selectValue.value) {
      window.$message.error(
        !resolution.value
          ? $t("workbench.assets.gen.pickResolution")
          : $t("workbench.assets.gen.pickModel"),
      );
      return;
    }
    generateLoading.value = true;
    try {
      await axios.post("/assetsGenerate/generateAssets", {
        type: formData.type ?? "props",
        projectId: toLocalProjectId(project.value?.id),
        name: formData.name ?? $t("workbench.assets.gen.unnamed"),
        base64: await readReferenceImage(),
        prompt: formData.prompt,
        model: selectValue.value,
        id: formData.id,
        resolution: resolution.value,
      });
      window.$message.success($t("workbench.assets.gen.assetGenSuccess"));
      await fetchGeneratedImages();
    } catch (error) {
      window.$message.error((error as Error)?.message ?? $t("workbench.assets.gen.assetGenFail"));
      void fetchGeneratedImages();
    } finally {
      generateLoading.value = false;
    }
  }

  function handleCustomUpload(files: any[]) {
    const file = files[0]?.raw || files[0];
    if (!(file instanceof File)) return;
    const reader = new FileReader();
    reader.onload = () => {
      resultImages.value.push({ id: "", src: reader.result as string, state: "已完成" });
      window.$message.success($t("workbench.assets.gen.uploadOk"));
      customFileList.value = [];
    };
    reader.readAsDataURL(file);
  }

  function handlePreview(src: string) {
    visible.value = true;
    trigger.value = src;
  }

  function selectImage(index: number) {
    if (resultImages.value[index]?.state !== "已完成") return;
    selectedImageIndex.value = index;
    window.$message.success($t("workbench.assets.gen.imageSelected"));
  }

  function deleteImage(id: string | number, index: number) {
    const dialog = DialogPlugin.confirm({
      header: $t("workbench.assets.confirmDeleteHeader"),
      body: $t("workbench.assets.confirmDeleteBody"),
      confirmBtn: $t("workbench.assets.deleteBtn"),
      cancelBtn: $t("workbench.assets.cancelBtn"),
      theme: "warning",
      onConfirm: async () => {
        try {
          await axios.post("/assets/delImage", { id });
          resultImages.value.splice(index, 1);
          if (selectedImageIndex.value === index) selectedImageIndex.value = null;
          else if (selectedImageIndex.value !== null && selectedImageIndex.value > index) {
            selectedImageIndex.value--;
          }
          window.$message.success($t("workbench.assets.deleteSuccess"));
        } catch {
          window.$message.error($t("workbench.assets.deleteFail"));
        } finally {
          dialog.destroy();
        }
      },
    });
  }

  async function onClick() {
    if (selectedImageIndex.value === null) return;
    const selectedImage = resultImages.value[selectedImageIndex.value];
    const isLocalUpload = !selectedImage.id;
    await axios.post("/assets/saveAssets", {
      id: formData.id,
      base64: isLocalUpload ? selectedImage.src : "",
      type: formData.type,
      prompt: formData.prompt,
      projectId: toLocalProjectId(project.value?.id),
      imageId: isLocalUpload ? undefined : Number(selectedImage.id),
    });
    window.$message.success($t("workbench.assets.gen.imageSaved"));
    dialogVisible.value = false;
    emitUpdate();
  }

  watch(dialogVisible, (isVisible) => {
    if (!isVisible) return;
    referenceFileList.value = [];
    value2.value = "";
    selectedImageIndex.value = null;
    hoveredImageIndex.value = null;
    generateLoading.value = false;
    void fetchGeneratedImages();
  });

  return {
    referenceFileList,
    customFileList,
    autoUpload,
    showImageFileName,
    generateLoading,
    promptLoading,
    selectValue,
    resolution,
    value2,
    resultImages,
    visible,
    trigger,
    selectedImageIndex,
    hoveredImageIndex,
    handleCancel,
    generatePrompt,
    handleGenerate,
    handleCustomUpload,
    handlePreview,
    selectImage,
    deleteImage,
    onClick,
  };
}
