import { reactive, ref } from "vue";
import axios from "@/utils/axios";
import { localProjectBody } from "@/features/tianjiang/project/local-project-id";
import openAssetsSelector from "@/utils/assetsCheck";
import type { CornerScapeItem } from "./cornerScapeTypes";
import type { CornerScapeState } from "./useCornerScapeState";
import { pickSafeProjectRuntimeFileUrl } from "./safeProjectRuntimeUrl";

export function useCornerScapeDrawer(state: CornerScapeState) {
  const drawerVisible = ref(false);
  const currentItem = ref<CornerScapeItem | null>(null);
  const selectedHistoryId = ref<number | null>(null);
  const polishing = ref(false);
  const editForm = reactive({
    assetsId: 0,
    assetUuid: "",
    model: "",
    type: "",
    resolution: "",
    prompt: "",
    name: "",
    describe: "",
    remark: "",
    imageRatio: "16:9",
    promptState: "",
    relepedAudio: [] as Array<{ id: number; name: string; src?: string }>,
  });
  const saving = ref(false);
  const replacing = ref(false);

  function displayRatio(value?: string): "16:9" | "9:16" {
    return value === "9:16" ? "9:16" : "16:9";
  }

  function syncEditForm(item: CornerScapeItem) {
    editForm.assetsId = item.id;
    editForm.assetUuid = item.assetUuid || "";
    editForm.name = item.name || "";
    editForm.type = item.type || "";
    // 中文注释：打开资产时必须用当前图片真实模型和分辨率，禁止沿用上一资产。
    editForm.model = item.model || "";
    editForm.resolution = item.resolution || "";
    editForm.prompt = item.prompt || "";
    editForm.describe = item.describe || "";
    editForm.remark = item.remark || "";
    editForm.imageRatio = displayRatio(item.imageRatio);
    editForm.promptState = item.promptState;
    editForm.relepedAudio = item.relepedAudio ?? [];
  }

  async function toggleHistorySelect(id: number) {
    selectedHistoryId.value = selectedHistoryId.value === id ? null : id;
    if (!currentItem.value) return;
    const image = currentItem.value.historyImages.find((entry) => entry.id === selectedHistoryId.value);
    try {
      await axios.post(
        "/assets/saveAssets",
        localProjectBody(state.project.value?.id, {
          id: currentItem.value.id,
          type: currentItem.value.type,
          prompt: currentItem.value.prompt,
          imageId: image?.id,
        }),
      );
      if (image) {
        currentItem.value.filePath = image.filePath;
        currentItem.value.state = "已完成";
      }
      void state.getFilteredData();
      window.$message.success($t("workbench.cornerScape.msg.replaceSuccess"));
    } catch {
      window.$message.error($t("workbench.cornerScape.msg.replaceFailed"));
    }
  }

  async function openDrawer(item: CornerScapeItem) {
    if (item.state === "生成中") return;
    selectedHistoryId.value = null;
    currentItem.value = item;
    syncEditForm(item);
    drawerVisible.value = true;
    try {
      const payload = await axios.post(
        "/cornerScape/getAllAssets",
        localProjectBody(state.project.value?.id, {
          type: state.checkboxValue.value,
        }),
      );
      const rows = Array.isArray(payload)
        ? payload as CornerScapeItem[]
        : Array.isArray((payload as { data?: unknown })?.data)
          ? (payload as { data: CornerScapeItem[] }).data
          : [];
      const freshItem = rows.find((entry) => entry.id === item.id);
      if (!freshItem) return;
      const index = state.dataList.value.findIndex((entry) => entry.id === item.id);
      if (index !== -1) state.dataList.value[index] = freshItem;
      currentItem.value = freshItem;
      syncEditForm(freshItem);
    } catch (error) {
      console.error("刷新资产详情失败:", error);
    }
  }

  function setItemState(id: number, value: string) {
    const item = state.dataList.value.find((entry) => entry.id === id);
    if (item) item.state = value;
    if (currentItem.value?.id === id) currentItem.value.state = value;
  }

  function regenerateItem() {
    const item = currentItem.value;
    if (!item) return;
    if (!editForm.model || !editForm.resolution || !editForm.prompt.trim()) {
      const key = !editForm.model
        ? "workbench.cornerScape.msg.selectModel"
        : !editForm.resolution
          ? "workbench.cornerScape.msg.selectResolution"
          : "workbench.cornerScape.msg.enterPrompt";
      window.$message.warning($t(key));
      return;
    }
    setItemState(item.id, "生成中");
    drawerVisible.value = false;
    const controller = state.createAbortController();
    axios.post(
      "/assetsGenerate/generateAssets",
      localProjectBody(state.project.value?.id, {
        type: item.type ?? "props",
        name: item.name ?? $t("workbench.cornerScape.unnamed"),
        base64: "",
        prompt: editForm.prompt,
        model: editForm.model,
        id: item.id,
        resolution: editForm.resolution,
        concurrentCount: 1,
      }),
      { signal: controller.signal },
    ).then(async () => {
      window.$message.success($t("workbench.cornerScape.msg.genSuccess", { name: item.name }));
      await state.getFilteredData();
    }).catch((error: any) => {
      if (error.name === "CanceledError" || error.code === "ERR_CANCELED") return;
      window.$message.error(error.message ?? $t("workbench.cornerScape.msg.genFailed", { name: item.name }));
      setItemState(item.id, "生成失败");
    });
  }

  async function savePromptOnBlur() {
    if (!currentItem.value || editForm.prompt === currentItem.value.prompt) return;
    try {
      await axios.post(
        "/assets/saveAssets",
        localProjectBody(state.project.value?.id, {
          id: currentItem.value.id,
          type: currentItem.value.type,
          prompt: editForm.prompt,
        }),
      );
      currentItem.value.prompt = editForm.prompt;
      const target = state.dataList.value.find((item) => item.id === currentItem.value!.id);
      if (target) target.prompt = editForm.prompt;
      window.$message.success($t("workbench.cornerScape.msg.saveSuccess"));
    } catch {
      window.$message.error($t("workbench.cornerScape.msg.saveFailed"));
    }
  }

  async function polishPrompts() {
    if (!editForm.prompt.trim()) {
      window.$message.warning($t("workbench.cornerScape.msg.enterPromptFirst"));
      return;
    }
    polishing.value = true;
    try {
      const { data } = await axios.post(
        "/assetsGenerate/polishAssetsPrompt",
        localProjectBody(state.project.value?.id, {
          assetsId: editForm.assetsId,
          type: editForm.type ?? "props",
          name: editForm.name,
          describe: editForm.describe,
        }),
      );
      if (data.assetsId === editForm.assetsId) editForm.prompt = data.prompt;
      window.$message.success($t("workbench.cornerScape.msg.promptGenSuccess"));
      void state.getFilteredData();
    } catch (error) {
      window.$message.error((error as Error)?.message ?? $t("workbench.cornerScape.msg.polishFailed"));
    } finally {
      polishing.value = false;
    }
  }

  async function removeAudio(id: number) {
    editForm.relepedAudio = editForm.relepedAudio.filter((audio) => audio.id !== id);
    await axios.post("/cornerScape/updateAssetsAudio", { assetsId: editForm.assetsId });
  }

  let ownedPreviewUrl = "";
  let audioSelectGeneration = 0;

  function revokeOwnedPreview(url = ownedPreviewUrl): void {
    if (!url || !url.startsWith("blob:") || url !== ownedPreviewUrl) return;
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    if (ownedPreviewUrl === url) ownedPreviewUrl = "";
  }

  function revokeLocalPreview(): void {
    revokeOwnedPreview();
  }

  function pickSafeAudioSrc(value: unknown, allowBlob = false): string | undefined {
    return pickSafeProjectRuntimeFileUrl(value, allowBlob);
  }

  function applyRelatedAudio(
    items: Array<{ id: number; name: string; src?: string }>,
    allowBlob = false,
  ): void {
    editForm.relepedAudio = items.map((item) => {
      const src = pickSafeAudioSrc(item.src, allowBlob);
      return src ? { id: item.id, name: item.name, src } : { id: item.id, name: item.name };
    });
    if (currentItem.value) currentItem.value.relepedAudio = editForm.relepedAudio;
    const index = state.dataList.value.findIndex((entry) => entry.id === editForm.assetsId);
    if (index !== -1) state.dataList.value[index]!.relepedAudio = editForm.relepedAudio;
  }

  async function refreshRelatedAudioFromServer(generation?: number): Promise<boolean> {
    const payload = await axios.post(
      "/cornerScape/getAllAssets",
      localProjectBody(state.project.value?.id, {
        type: state.checkboxValue.value,
      }),
    );
    if (generation != null && generation !== audioSelectGeneration) return false;
    const rows = Array.isArray(payload)
      ? payload as CornerScapeItem[]
      : Array.isArray((payload as { data?: unknown })?.data)
        ? (payload as { data: CornerScapeItem[] }).data
        : [];
    const fresh = rows.find((entry) => entry.id === editForm.assetsId);
    if (!fresh) return false;
    const incoming = (fresh.relepedAudio ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      src: pickSafeAudioSrc(item.src),
    }));
    if (!incoming.some((item) => item.src) && ownedPreviewUrl) return false;
    applyRelatedAudio(incoming);
    const index = state.dataList.value.findIndex((entry) => entry.id === editForm.assetsId);
    if (index !== -1) state.dataList.value[index] = { ...state.dataList.value[index]!, ...fresh, relepedAudio: editForm.relepedAudio };
    return incoming.some((item) => item.src);
  }

  async function selectAudio() {
    const assets = await openAssetsSelector({
      title: $t("workbench.script.add.msg.selectAssetsTitle"),
      types: ["audio"],
      selectorMode: true,
      multiple: false,
    });
    if (!assets.length) return;
    const selected = assets[0]!;
    applyRelatedAudio([{
      id: selected.id,
      name: selected.name,
      src: pickSafeAudioSrc(selected.src),
    }]);
    await axios.post("/cornerScape/updateAssetsAudio", {
      assetsId: editForm.assetsId,
      audioIds: editForm.relepedAudio.map((audio) => audio.id),
    });
    try {
      // 中文注释：绑定后复用现有 getAllAssets 回读安全 src，抽屉不关也能立刻试听。
      const switched = await refreshRelatedAudioFromServer();
      if (switched) revokeOwnedPreview();
    } catch {
      // 回读失败时保留选择结果中已经校验过的安全 src，禁止回退 filePath。
    }
  }

  async function saveAssetInfo(): Promise<boolean> {
    const item = currentItem.value;
    const projectUuid = String((state.project.value as { projectUuid?: string } | null)?.projectUuid ?? "").trim();
    if (!item || !editForm.assetUuid || !projectUuid || saving.value) return false;
    saving.value = true;
    try {
      await axios.patch(
        `/tianjiang/runtime/projects/${encodeURIComponent(projectUuid)}/storyboard/assets/${encodeURIComponent(editForm.assetUuid)}`,
        {
          name: editForm.name,
          remark: editForm.remark,
          describe: editForm.describe,
          prompt: editForm.prompt,
          imageRatio: editForm.imageRatio,
        },
      );
      item.name = editForm.name;
      item.remark = editForm.remark;
      item.describe = editForm.describe;
      item.prompt = editForm.prompt;
      item.imageRatio = editForm.imageRatio;
      window.$message.success($t("workbench.cornerScape.msg.saveSuccess"));
      const switched = await refreshRelatedAudioFromServer();
      if (switched) revokeOwnedPreview();
      await state.getFilteredData();
      return true;
    } catch {
      window.$message.error($t("workbench.cornerScape.msg.saveFailed"));
      return false;
    } finally {
      saving.value = false;
    }
  }

  async function replaceAssetImage(file: File) {
    const item = currentItem.value;
    const projectUuid = String((state.project.value as { projectUuid?: string } | null)?.projectUuid ?? "").trim();
    if (!item || !editForm.assetUuid || !projectUuid || replacing.value) return;
    replacing.value = true;
    try {
      const form = new FormData();
      form.append("file", file);
      await axios.post(
        `/tianjiang/runtime/projects/${encodeURIComponent(projectUuid)}/storyboard/assets/${encodeURIComponent(editForm.assetUuid)}/image`,
        form,
      );
      window.$message.success($t("workbench.cornerScape.msg.replaceSuccess"));
      await openDrawer(item);
      void state.getFilteredData();
    } catch {
      window.$message.error($t("workbench.cornerScape.msg.replaceFailed"));
    } finally {
      replacing.value = false;
    }
  }

  async function uploadRoleAudio(file: File) {
    const item = currentItem.value;
    const projectUuid = String((state.project.value as { projectUuid?: string } | null)?.projectUuid ?? "").trim();
    if (!item || !editForm.assetUuid || item.type !== "role" || !projectUuid) return;
    const generation = ++audioSelectGeneration;
    const nextBlob = URL.createObjectURL(file);
    const previousOwned = ownedPreviewUrl;
    ownedPreviewUrl = nextBlob;
    applyRelatedAudio([{
      id: editForm.relepedAudio[0]?.id ?? Date.now(),
      name: file.name || "音色文件",
      src: nextBlob,
    }], true);
    if (previousOwned && previousOwned !== nextBlob) {
      try { URL.revokeObjectURL(previousOwned); } catch { /* ignore */ }
    }
    const form = new FormData();
    form.append("file", file);
    try {
      await axios.post(
        `/tianjiang/runtime/projects/${encodeURIComponent(projectUuid)}/storyboard/assets/${encodeURIComponent(editForm.assetUuid)}/audio`,
        form,
      );
      if (generation !== audioSelectGeneration) return;
      const switched = await refreshRelatedAudioFromServer(generation);
      if (generation !== audioSelectGeneration) return;
      if (switched) revokeOwnedPreview(nextBlob);
    } catch {
      // 保存失败或空回读时保留当前代际 blob，禁止误撤销仍在预览的 URL。
    }
    if (generation === audioSelectGeneration) void state.getFilteredData();
  }

  return {
    drawerVisible, currentItem, selectedHistoryId, editForm, polishing, saving, replacing,
    toggleHistorySelect, openDrawer, setItemState, regenerateItem,
    savePromptOnBlur, polishPrompts, removeAudio, selectAudio,
    saveAssetInfo, replaceAssetImage, uploadRoleAudio, revokeLocalPreview,
  };
}

export type CornerScapeDrawer = ReturnType<typeof useCornerScapeDrawer>;
