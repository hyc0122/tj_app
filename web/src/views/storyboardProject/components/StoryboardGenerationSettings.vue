<template>
  <section
    class="generationSettings"
    data-panel="storyboard-generation-settings"
    :data-catalog-state="catalogStatus"
    :data-catalog-valid="videoCatalogValid ? 'true' : 'false'"
  >
    <header>
      <div>
        <span>GENERATION SETTINGS</span>
        <strong>视频生成</strong>
      </div>
      <small>当前镜头</small>
    </header>

    <div class="generationSettings__grid">
      <label data-field="video-provider-model">
        <span>视频模型</span>
        <modelSelect
          :model-value="modelValue.providerModel"
          type="video"
          size="small"
          name="providerModel"
          :disabled="readonly || busy"
          :account-scope-id="accountScopeId"
          :placeholder="catalogUnavailable ? emptyCatalogMessage : undefined"
          @update:model-value="onProviderModelChange"
        />
      </label>
      <label>
        <span>生成模式</span>
        <select
          name="mode"
          :value="modelValue.mode"
          :data-text2video-allowed="hasBoundAssets ? 'false' : 'true'"
          :disabled="readonly || busy"
          @change="update('mode', modeValue($event))"
        >
          <option value="auto">自动判断</option>
          <option value="multimodal2video">全能参考</option>
          <option value="text2video" :disabled="hasBoundAssets">纯文本生成</option>
        </select>
      </label>
      <label>
        <span>画幅</span>
        <select name="aspectRatio" :value="modelValue.aspectRatio" :disabled="readonly || busy" @change="update('aspectRatio', selectValue($event))">
          <option value="9:16">9:16</option>
          <option value="16:9">16:9</option>
          <option value="1:1">1:1</option>
          <option value="4:3">4:3</option>
        </select>
      </label>
      <label>
        <span>分辨率</span>
        <select
          name="resolution"
          :value="normalizedResolution"
          :disabled="readonly || busy"
          @change="update('resolution', resolutionValue($event))"
        >
          <option v-for="resolution in STORYBOARD_VIDEO_RESOLUTIONS" :key="resolution" :value="resolution">
            {{ resolution }}
          </option>
        </select>
      </label>
      <label>
        <span>时长（秒）</span>
        <input
          name="durationSeconds"
          type="number"
          min="4"
          max="30"
          step="1"
          :value="Math.round(Number(modelValue.durationMs || 5000) / 1000)"
          :disabled="readonly || busy"
          @change="update('durationMs', durationMsFromSeconds($event))"
        />
      </label>
    </div>
    <p v-if="selectionRequiredMessage" data-selection-required>{{ selectionRequiredMessage }}</p>
    <p v-else-if="catalogUnavailable" data-catalog-status>{{ emptyCatalogMessage }}</p>
    <p v-else>有绑定素材时可选择自动判断或全能参考；纯文本镜头使用 text2video。</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import modelSelect from "@/components/modelSelect.vue";
import {
  currentAccountScopeId,
  modelCatalogStore,
  type ModelCatalogItem,
} from "@/features/models/modelCatalogStore";
import {
  DEFAULT_STORYBOARD_VIDEO_RESOLUTION,
  STORYBOARD_VIDEO_RESOLUTIONS,
  normalizeStoryboardVideoResolution,
  type StoryboardGenerationMode,
  type StoryboardVideoResolution,
} from "../storyboard-workbench-types";
import {
  isStoryboardVideoModelAvailable,
  videoCatalogAvailableValues,
  type StoryboardVideoCatalogState,
} from "../storyboard-video-catalog";

export interface StoryboardGenerationSettingsValue {
  mediaType: "video";
  providerModel: string;
  mode: Extract<StoryboardGenerationMode, "auto" | "text2video" | "image2video" | "frames2video" | "multiframe2video" | "multimodal2video">;
  durationMs: number;
  aspectRatio: string;
  // 中文注释：视频分辨率是预览摘要和正式请求的一部分，设置组件必须始终显式携带。
  resolution: StoryboardVideoResolution | string;
}

const emptyCatalogMessage = "当前账号未配置可用视频模型";

const props = defineProps<{
  modelValue: StoryboardGenerationSettingsValue;
  /** 已废弃：视频模型必须来自当前账号目录，禁止再传入静态即梦名单。 */
  videoModels?: readonly { value: string; label: string }[];
  readonly?: boolean;
  busy?: boolean;
  hasBoundAssets?: boolean;
  preferredProviderModel?: string;
  accountScopeId?: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: StoryboardGenerationSettingsValue];
  "update:catalogValid": [valid: boolean];
}>();

const catalogStatus = ref<StoryboardVideoCatalogState>("checking");
const catalogItems = ref<ModelCatalogItem[]>([]);
const selectionRequiredMessage = ref("");
const selectionRequiresExplicitChoice = ref(false);

const availableValues = computed(() => videoCatalogAvailableValues(catalogItems.value));

const normalizedResolution = computed(() => (
  normalizeStoryboardVideoResolution(props.modelValue.resolution) || DEFAULT_STORYBOARD_VIDEO_RESOLUTION
));

const catalogUnavailable = computed(() => (
  catalogStatus.value !== "ready" || availableValues.value.length === 0
));

const videoCatalogValid = computed(() => isStoryboardVideoModelAvailable({
  catalogState: catalogStatus.value,
  availableValues: availableValues.value,
  providerModel: props.modelValue.providerModel,
}));

watch(videoCatalogValid, (valid) => {
  emit("update:catalogValid", valid);
}, { immediate: true });

function selectValue(event: Event): string {
  return (event.target as HTMLSelectElement).value;
}

function durationMsFromSeconds(event: Event): number {
  const seconds = Number((event.target as HTMLInputElement).value);
  if (!Number.isInteger(seconds) || seconds < 4 || seconds > 30) return props.modelValue.durationMs;
  return seconds * 1000;
}

function resolutionValue(event: Event): StoryboardVideoResolution {
  const value = normalizeStoryboardVideoResolution(selectValue(event));
  // 中文注释：原生下拉理论上只会产生白名单值；异常 DOM 值仍保持当前安全选择。
  return value || normalizedResolution.value;
}

function modeValue(event: Event): StoryboardGenerationSettingsValue["mode"] {
  const value = selectValue(event);
  // 中文注释：有角色/场景/道具绑定时禁止纯文本；下拉仍在类型边界显式收窄。
  if (props.hasBoundAssets && value === "text2video") return "auto";
  return value === "multimodal2video" || value === "text2video" ? value : "auto";
}

watch(
  () => [props.hasBoundAssets, props.modelValue.mode] as const,
  ([bound, mode]) => {
    if (bound && mode === "text2video") {
      emit("update:modelValue", { ...props.modelValue, mode: "auto" });
    }
  },
  { immediate: true },
);

function update<Key extends keyof StoryboardGenerationSettingsValue>(
  key: Key,
  value: StoryboardGenerationSettingsValue[Key],
): void {
  emit("update:modelValue", { ...props.modelValue, [key]: value });
}

function onProviderModelChange(value: string): void {
  const next = String(value ?? "");
  if (next && !isStoryboardVideoModelAvailable({
    catalogState: catalogStatus.value,
    availableValues: availableValues.value,
    providerModel: next,
  })) {
    update("providerModel", "");
    return;
  }
  // 中文注释：只有用户显式选择才能解除“原模型已失效”门禁，禁止项目默认或目录首项自动接管。
  selectionRequiresExplicitChoice.value = false;
  selectionRequiredMessage.value = "";
  update("providerModel", next);
}

defineExpose({
  catalogState: catalogStatus,
  availableValues,
  videoCatalogValid,
});

function pickProviderModel(): string {
  const available = availableValues.value;
  const preferred = String(props.preferredProviderModel ?? "").trim();
  const current = String(props.modelValue.providerModel ?? "").trim();
  // 中文注释：当前明确选择是唯一真源；项目默认只允许在尚无选择的首次初始化阶段使用。
  if (current && available.includes(current)) return current;
  if (current || selectionRequiresExplicitChoice.value) return "";
  if (preferred && available.includes(preferred)) return preferred;
  return available[0] ?? "";
}

function applyPickedModel(): void {
  if (catalogStatus.value !== "ready") return;
  const current = String(props.modelValue.providerModel ?? "").trim();
  if (current && !availableValues.value.includes(current)) {
    // 中文注释：显式模型从当前账号目录消失时必须清空并要求重选，不能静默回填项目默认。
    selectionRequiresExplicitChoice.value = true;
    selectionRequiredMessage.value = "当前选择的视频模型已不可用，请重新选择";
  } else if (current) {
    selectionRequiredMessage.value = "";
  }
  const next = pickProviderModel();
  if (next !== props.modelValue.providerModel) {
    // 中文注释：只改模型字段，避免异步目录回写把绑定镜头的 mode 从 auto 打回 text2video。
    emit("update:modelValue", { ...props.modelValue, providerModel: next });
  }
}

function invalidateCatalogSelection(): void {
  catalogStatus.value = "checking";
  catalogItems.value = [];
  // 中文注释：刷新期间保留显式值但关闭目录有效门禁，避免异步重载把它改成项目默认或首项。
}

async function loadCatalog(): Promise<void> {
  const scope = props.accountScopeId || currentAccountScopeId();
  invalidateCatalogSelection();
  try {
    const next = await modelCatalogStore.ensure(scope, "video");
    if ((props.accountScopeId || currentAccountScopeId()) !== scope) return;
    catalogItems.value = Array.isArray(next.items) ? next.items : [];
    catalogStatus.value = modelCatalogStore.failure(scope, "video") ? "failed" : "ready";
    if (catalogStatus.value !== "ready") return;
    // 中文注释：空目录同样代表原显式模型已失效，必须清空并要求重选，不能保留一个不可提交的幽灵值。
    applyPickedModel();
  } catch {
    if ((props.accountScopeId || currentAccountScopeId()) !== scope) return;
    catalogItems.value = [];
    catalogStatus.value = "failed";
  }
}

watch(() => props.accountScopeId || currentAccountScopeId(), () => {
  void loadCatalog();
});

watch(() => props.preferredProviderModel, () => {
  if (catalogStatus.value === "ready") applyPickedModel();
});

onMounted(() => {
  void loadCatalog();
});
</script>

<style scoped lang="scss">
.generationSettings {
  display: grid;
  gap: 14px;
  padding: 16px;
  color: var(--product-text);
  background: var(--product-surface-soft);
  border: 1px solid var(--product-border);
  border-radius: var(--product-radius-card);
}

.generationSettings header,
.generationSettings header > div,
.generationSettings label {
  display: grid;
  gap: 5px;
}

.generationSettings header {
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
}

.generationSettings header span {
  color: var(--td-brand-color);
  font-size: 11px;
  letter-spacing: .08em;
}

.generationSettings header small,
.generationSettings label span,
.generationSettings p {
  color: var(--product-text-muted);
}

.generationSettings__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.generationSettings select {
  min-height: 38px;
  padding: 0 10px;
  color: var(--product-text);
  background: var(--product-surface);
  border: 1px solid var(--product-border);
  border-radius: 9px;
}

.generationSettings select:focus-visible {
  outline: none;
  box-shadow: var(--product-focus-ring);
}

@media (max-width: 760px) {
  .generationSettings__grid {
    grid-template-columns: 1fr;
  }
}
</style>
