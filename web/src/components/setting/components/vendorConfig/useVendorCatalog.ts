import axios from "@/utils/axios";
import { VendorSecretSession } from "@/features/tianjiang/vendor-secret-session";
import type { VendorItem, VendorLoadState } from "./types";
import { NATIVE_DREAMINA_ID } from "./types";
import settingStore from "@/stores/setting";
import {
  buildVendorUpdatePayload,
  isValidBase64,
  needsVendorUpdate,
} from "./vendorConfigLogic";
import {
  getInputIcon,
  getInputPlaceholder,
  getModelLogo,
  getVisibleInputType,
} from "./vendorCatalogPresentation";
import { redactVendorErrorMessage } from "./vendorCatalogSecurity";
import { confirmDeleteVendor, enableVendorToggle } from "./vendorCatalogMutations";
import { createVendorInputState, createVendorWorkspaceItems } from "./vendorCatalogWorkspace";

const AUTO_SAVE_DELAY = 700;

export function useVendorCatalog() {
  const vendorList = ref<VendorItem[]>([]);
  const { activeWorkspaceProviderId } = storeToRefs(settingStore());
  const activeVendorId = ref<string | undefined>(
    activeWorkspaceProviderId.value || undefined,
  );
  const loading = ref(false);
  const vendorLoadStates = reactive(new Map<string, VendorLoadState>());
  const secretSession = new VendorSecretSession();
  const autoUpdating = ref(false);
  const autoSaveReady = ref(false);
  const lastSavedSnapshot = ref("");
  let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingAutoSave = false;
  const vendorLoadGenerations = new Map<string, number>();
  let listGeneration = 0;
  let listAbortController: AbortController | null = null;
  const currentVendor = computed(() => vendorList.value.find(
    (vendor) => vendor.id === activeVendorId.value,
  ));
  const workspaceItems = createVendorWorkspaceItems(vendorList);
  const isNativeDreamina = computed(() => activeVendorId.value === NATIVE_DREAMINA_ID);
  const vendorLoadState = computed<VendorLoadState>(() =>
    activeVendorId.value
      ? vendorLoadStates.get(activeVendorId.value) ?? { state: "idle", generation: 0 }
      : { state: "idle", generation: 0 },
  );
  /** 凭据区是否可渲染：仅依赖响应式 vendorLoadStates，禁止读非响应式 session 私有字段。 */
  const vendorSecretsLoaded = computed(
    () => vendorLoadState.value.state === "loaded",
  );
  const loadingVendorSecrets = computed(() => vendorLoadState.value.state === "loading");
  /** 保存过程反馈：不得把密钥写入 message */
  const vendorSaveState = ref<"idle" | "saving" | "saved" | "error">("idle");
  const vendorSaveError = ref("");
  const { vendorModels, orderedInputs, requiredInputs, optionalInputs } =
    createVendorInputState(currentVendor);
  const currentVendorSnapshot = computed(() =>
    currentVendor.value
      ? JSON.stringify(buildVendorUpdatePayload(currentVendor.value))
      : "",
  );

  function clearVendorSecrets() {
    secretSession.dispose();
    for (const vendor of vendorList.value) vendor.inputValues = {};
  }

  async function loadVendorSecrets(vendorId: string) {
    const generation = (vendorLoadGenerations.get(vendorId) ?? 0) + 1;
    vendorLoadGenerations.set(vendorId, generation);
    vendorLoadStates.set(vendorId, { state: "loading", generation });
    try {
      const vendor = vendorList.value.find((item) => item.id === vendorId);
      if (!vendor) throw new Error("供应商不存在或已删除");
      const values = secretSession.activate(vendorId, vendor.inputValues);
      if (activeVendorId.value !== vendorId) {
        vendorLoadStates.set(vendorId, { state: "idle", generation });
        return;
      }
      vendor.inputValues = values;
      await nextTick();
      if (vendorLoadGenerations.get(vendorId) !== generation || activeVendorId.value !== vendorId) {
        vendorLoadStates.set(vendorId, { state: "idle", generation });
        return;
      }
      lastSavedSnapshot.value = currentVendorSnapshot.value;
      autoSaveReady.value = true;
      vendorLoadStates.set(vendorId, { state: "loaded", generation });
    } catch (error: any) {
      const raw = typeof error?.message === "string" ? error.message : "供应商配置加载失败";
      const safeMessage = redactVendorErrorMessage(raw, 16);
      if (vendorLoadGenerations.get(vendorId) === generation) {
        vendorLoadStates.set(vendorId, { state: "error", generation, message: safeMessage });
      }
      if (activeVendorId.value === vendorId) {
        window.$message.error(`${$t("settings.vendor.msg.loadInputsFailed")}${safeMessage}`);
      }
    }
  }

  async function retryVendorLoad() {
    if (activeVendorId.value) await loadVendorSecrets(activeVendorId.value);
  }

  async function getVendorList() {
    const generation = ++listGeneration;
    listAbortController?.abort();
    listAbortController = new AbortController();
    loading.value = true;
    clearVendorSecrets();
    try {
      const response = await axios.post(
        "/setting/vendorConfig/getVendorList",
        undefined,
        { signal: listAbortController.signal },
      );
      if (generation !== listGeneration) return;
      vendorList.value = Array.isArray(response.data) ? response.data : [];
      const currentIds = new Set(vendorList.value.map((vendor) => vendor.id));
      for (const vendorId of vendorLoadStates.keys()) {
        if (!currentIds.has(vendorId)) vendorLoadStates.delete(vendorId);
      }
      if (activeVendorId.value === NATIVE_DREAMINA_ID) {
        return;
      }
      if (
        vendorList.value.length > 0 &&
        !vendorList.value.some((vendor) => vendor.id === activeVendorId.value)
      ) {
        activeVendorId.value = vendorList.value[0].id;
        await loadVendorSecrets(activeVendorId.value);
      } else if (activeVendorId.value) {
        await loadVendorSecrets(activeVendorId.value);
      }
    } catch (error: any) {
      if (generation !== listGeneration || error?.code === "ERR_CANCELED" || error?.name === "CanceledError") return;
      window.$message.error(`${$t("settings.vendor.msg.getVendorListFailed")}${error.message}`);
    } finally {
      if (generation === listGeneration) loading.value = false;
    }
  }

  function scheduleAutoSave() {
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => void handleAutoUpdateVendor(), AUTO_SAVE_DELAY);
  }

  async function handleAutoUpdateVendor() {
    if (
      !currentVendor.value ||
      !vendorSecretsLoaded.value ||
      !autoSaveReady.value ||
      loading.value
    ) {
      return;
    }
    // 捕获当前供应商身份与快照，避免 await 期间切换导致 A 的值写入 B。
    const savingVendorId = currentVendor.value.id;
    const snapshot = currentVendorSnapshot.value;
    const payloadValues = { ...currentVendor.value.inputValues };
    if (!snapshot || snapshot === lastSavedSnapshot.value) return;
    if (autoUpdating.value) {
      pendingAutoSave = true;
      return;
    }
    autoUpdating.value = true;
    vendorSaveState.value = "saving";
    vendorSaveError.value = "";
    try {
      if (activeVendorId.value !== savingVendorId || !secretSession.isLoaded(savingVendorId)) {
        return;
      }
      await secretSession.save(
        savingVendorId,
        payloadValues,
        (path: string, body: unknown, options?: unknown) =>
          axios.post(path, body, options as any),
      );
      if (activeVendorId.value === savingVendorId) {
        lastSavedSnapshot.value = snapshot;
        vendorSaveState.value = "saved";
      }
    } catch (error: any) {
      const raw = typeof error?.message === "string" ? error.message : "保存失败";
      const safeMessage = redactVendorErrorMessage(raw, 24);
      vendorSaveState.value = "error";
      vendorSaveError.value = safeMessage;
      if (activeVendorId.value === savingVendorId) {
        window.$message.error(`${$t("settings.vendor.msg.updateFailed")}${safeMessage}`);
      }
    } finally {
      autoUpdating.value = false;
      if (pendingAutoSave && activeVendorId.value === savingVendorId) {
        pendingAutoSave = false;
        scheduleAutoSave();
      } else {
        pendingAutoSave = false;
      }
    }
  }

  watch(
    currentVendorSnapshot,
    (snapshot) => {
      if (
        !snapshot ||
        !vendorSecretsLoaded.value ||
        !autoSaveReady.value ||
        loading.value ||
        snapshot === lastSavedSnapshot.value
      ) {
        return;
      }
      scheduleAutoSave();
    },
    { flush: "post" },
  );

  watch(
    activeVendorId,
    async (vendorId, previousVendorId) => {
      if (autoSaveTimer) {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
      }
      pendingAutoSave = false;
      autoSaveReady.value = false;
      vendorSaveState.value = "idle";
      vendorSaveError.value = "";
      const previous = previousVendorId ? vendorLoadStates.get(previousVendorId) : undefined;
      if (previousVendorId && previous?.state === "loading") {
        vendorLoadStates.set(previousVendorId, {
          state: "idle",
          generation: previous?.generation ?? 0,
        });
      }
      if (vendorId && vendorId !== NATIVE_DREAMINA_ID) await loadVendorSecrets(vendorId);
    },
    { flush: "post" },
  );

  function onChange(item: VendorItem, value: number) {
    enableVendorToggle(item, value);
  }

  function handleDeleteVendor() {
    if (!currentVendor.value) return;
    confirmDeleteVendor({
      vendor: currentVendor.value,
      onDeleted: () => {
        activeVendorId.value = undefined;
        void getVendorList();
      },
    });
  }

  onMounted(async () => {
    await getVendorList();
  });
  onBeforeUnmount(() => {
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    listAbortController?.abort();
    clearVendorSecrets();
  });

  return {
    activeVendorId,
    currentVendor,
    workspaceItems,
    isNativeDreamina,
    nativeDreaminaId: NATIVE_DREAMINA_ID,
    getInputIcon,
    getInputPlaceholder,
    getVisibleInputType,
    getModelLogo,
    getVendorList,
    handleDeleteVendor,
    isValidBase64,
    loading,
    loadingVendorSecrets,
    needsUpdate: needsVendorUpdate,
    onBlurFn: () => vendorSecretsLoaded.value && scheduleAutoSave(),
    onChange,
    orderedInputs,
    optionalInputs,
    requiredInputs,
    retryVendorLoad,
    vendorList,
    vendorLoadState,
    vendorLoadStates,
    vendorModels,
    vendorSaveError,
    vendorSaveState,
    vendorSecretsLoaded,
  };
}
