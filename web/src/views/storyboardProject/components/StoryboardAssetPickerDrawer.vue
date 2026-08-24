<template>
  <t-drawer
    :visible="open"
    :header="drawerTitle"
    :close-btn="true"
    data-drawer="storyboard-asset-picker"
    size="min(840px, 100vw)"
    @close="emit('close')"
    @update:visible="(visible: boolean) => { if (!visible) emit('close'); }"
  >
    <section class="assetPicker" data-panel="asset-picker-drawer">
      <label class="assetPicker__search">
        <span>搜索{{ assetTypeLabel }}</span>
        <input v-model="searchText" type="search" :placeholder="`按名称或描述查找${assetTypeLabel}`" />
      </label>

      <div class="assetPicker__body">
        <div>
          <p v-if="filteredAssets.length === 0" class="assetPicker__empty">当前项目没有可绑定的{{ assetTypeLabel }}资产。</p>
          <div v-else class="assetPicker__grid">
            <button
              v-for="asset in filteredAssets"
              :key="asset.assetUuid"
              type="button"
              class="assetPickerCard module-interactive--sm"
              :class="{ 'is-bound': isBound(asset.assetUuid), 'is-selected': selectedAssetUuid === asset.assetUuid }"
              :data-asset-id="asset.assetUuid"
              :disabled="readonly || busy || isBound(asset.assetUuid)"
              :aria-pressed="selectedAssetUuid === asset.assetUuid"
              @click="selectAsset(asset)"
            >
              <span class="assetPickerCard__preview">
                <img v-if="safeStoryboardAssetMediaUrl(asset.coverUrl)" :src="safeStoryboardAssetMediaUrl(asset.coverUrl)" :alt="asset.name" />
                <i v-else>{{ asset.name.slice(0, 1) }}</i>
              </span>
              <span class="assetPickerCard__copy">
                <strong>{{ asset.name }}</strong>
                <small>{{ asset.description || "暂无补充描述" }}</small>
              </span>
              <span v-if="isBound(asset.assetUuid)" class="assetPickerCard__bound">已绑定</span>
              <span v-else class="assetPickerCard__action">{{ selectedAssetUuid === asset.assetUuid ? "已选择" : "选择" }}</span>
            </button>
          </div>
        </div>

        <aside class="assetPickerPreview" data-panel="selected-asset-preview">
          <header><small>绑定目标</small><strong>{{ shotIdentity }}</strong></header>
          <template v-if="selectedAsset">
            <div class="assetPickerPreview__media">
              <img v-if="safeStoryboardAssetMediaUrl(selectedAsset.coverUrl)" :src="safeStoryboardAssetMediaUrl(selectedAsset.coverUrl)" :alt="selectedAsset.name" />
              <span v-else>{{ selectedAsset.name.slice(0, 1) }}</span>
            </div>
            <strong>{{ selectedAsset.name }}</strong>
            <p>{{ selectedAsset.description || "暂无补充描述" }}</p>
          </template>
          <div v-else class="assetPickerPreview__empty"><t-icon name="image" /><span>尚未选择资产</span></div>
        </aside>
      </div>

      <footer v-if="filteredAssets.length" class="assetPicker__footer">
        <span>{{ selectedAsset ? `已选择：${selectedAsset.name}` : "请先选择一个资产" }}</span>
        <button
          type="button"
          data-action="confirm-asset-binding"
          :disabled="readonly || busy || !selectedAsset || isBound(selectedAsset.assetUuid)"
          @click="confirmBinding"
        >
          {{ busy ? "绑定中…" : "确认绑定" }}
        </button>
      </footer>
    </section>
  </t-drawer>
</template>

<script setup lang="ts">
import type {
  StoryboardAssetType,
  WorkspaceAsset,
  WorkspaceBinding,
} from "../storyboard-workbench-types";
import { safeStoryboardAssetMediaUrl } from "../storyboard-media-url";

export interface StoryboardAssetPickerTarget {
  shotUuid: string;
  shotNumber?: number;
  assetType: Extract<StoryboardAssetType, "role" | "scene" | "tool">;
  assetUuid?: string;
}

const props = defineProps<{
  open: boolean;
  target: StoryboardAssetPickerTarget | null;
  assets: WorkspaceAsset[];
  bindings?: WorkspaceBinding[];
  readonly?: boolean;
  busy?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  bind: [{
    shotUuid: string;
    assetUuid: string;
    assetType: StoryboardAssetPickerTarget["assetType"];
    relationRole: "appear";
    sourceProjectUuid: string;
  }];
}>();

const searchText = ref("");
const selectedAssetUuid = ref("");
const assetTypeLabel = computed(() => ({ role: "角色", scene: "场景", tool: "道具" }[props.target?.assetType ?? "role"]));
const drawerTitle = computed(() => props.target
  ? `为${shotIdentity.value}选择${assetTypeLabel.value}`
  : "选择分镜资产");
const shotIdentity = computed(() => props.target?.shotNumber
  ? `镜头 ${String(props.target.shotNumber).padStart(2, "0")}`
  : "当前镜头");
const filteredAssets = computed(() => {
  if (!props.target) return [];
  const keyword = searchText.value.trim().toLowerCase();
  const boundIds = new Set((props.bindings ?? [])
    .filter((binding) => binding.assetType === props.target?.assetType)
    .map((binding) => binding.assetUuid));
  return props.assets
    .filter((asset) => asset.assetType === props.target?.assetType)
    .filter((asset) => !keyword
      || asset.name.toLowerCase().includes(keyword)
      || String(asset.description ?? "").toLowerCase().includes(keyword))
    .sort((left, right) => Number(boundIds.has(right.assetUuid)) - Number(boundIds.has(left.assetUuid))
      || left.name.localeCompare(right.name, "zh-CN"));
});
const selectedAsset = computed(() => props.assets.find((asset) => (
  asset.assetUuid === selectedAssetUuid.value && asset.assetType === props.target?.assetType
)) ?? null);

watch(
  [() => props.open, () => props.target],
  () => {
    // 切换镜头、资产类型或重新打开抽屉时清空上一次临时选择，避免误绑定。
    searchText.value = "";
    selectedAssetUuid.value = "";
  },
);

function isBound(assetUuid: string): boolean {
  return (props.bindings ?? []).some((binding) => (
    binding.assetType === props.target?.assetType && binding.assetUuid === assetUuid
  ));
}

function selectAsset(asset: WorkspaceAsset): void {
  if (!props.target || props.readonly || props.busy || isBound(asset.assetUuid)) return;
  selectedAssetUuid.value = asset.assetUuid;
}

function confirmBinding(): void {
  const asset = selectedAsset.value;
  if (!props.target || !asset || props.readonly || props.busy || isBound(asset.assetUuid)) return;
  emit("bind", {
    shotUuid: props.target.shotUuid,
    assetUuid: asset.assetUuid,
    assetType: props.target.assetType,
    relationRole: "appear",
    sourceProjectUuid: asset.sourceProjectUuid,
  });
}
</script>

<style scoped lang="scss">
.assetPicker {
  color: var(--product-text);
}

.assetPicker__search {
  display: grid;
  gap: 8px;
  margin-bottom: 16px;
  color: var(--product-text-secondary);
}

.assetPicker__search input {
  min-height: 40px;
  padding: 0 12px;
  color: var(--product-text);
  background: var(--product-surface-soft);
  border: 1px solid var(--product-border);
  border-radius: 10px;
}

.assetPicker__search input:focus-visible,
.assetPickerCard:focus-visible {
  outline: none;
  box-shadow: var(--product-focus-ring);
}

.assetPicker__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.assetPicker__body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(220px, 0.42fr);
  gap: 14px;
  align-items: start;
}

.assetPickerPreview {
  display: grid;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--product-border);
  border-radius: var(--product-radius-card);
  background: var(--product-surface-soft);
}

.assetPickerPreview header small,
.assetPickerPreview header strong {
  display: block;
}

.assetPickerPreview header small,
.assetPickerPreview p {
  color: var(--product-text-muted);
}

.assetPickerPreview__media,
.assetPickerPreview__empty {
  display: grid;
  place-items: center;
  overflow: hidden;
  min-height: 180px;
  border: 1px dashed var(--product-border-strong);
  border-radius: 12px;
  color: var(--product-text-muted);
  background: var(--product-surface);
}

.assetPickerPreview__media img {
  width: 100%;
  height: 180px;
  object-fit: contain;
}

.assetPickerCard {
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  min-width: 0;
  padding: 12px;
  color: var(--product-text);
  text-align: left;
  background: var(--product-surface-soft);
  border: 1px solid var(--product-border);
  border-radius: var(--product-radius-card);
}

.assetPickerCard.is-bound {
  border-color: var(--product-border-strong);
}

.assetPickerCard.is-selected {
  border-color: var(--td-brand-color);
  box-shadow: var(--product-focus-ring);
}

.assetPickerCard__preview {
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  overflow: hidden;
  background: var(--product-surface);
  border-radius: 12px;
}

.assetPickerCard__preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.assetPickerCard__copy {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.assetPickerCard__copy small,
.assetPicker__empty {
  color: var(--product-text-muted);
}

.assetPickerCard__bound {
  color: var(--td-success-color);
}

.assetPickerCard__action {
  color: var(--td-brand-color);
}

.assetPicker__footer {
  position: sticky;
  bottom: 0;
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  margin-top: 16px;
  padding: 12px;
  color: var(--product-text-secondary);
  background: color-mix(in srgb, var(--product-surface) 94%, transparent);
  border: 1px solid var(--product-border);
  border-radius: var(--product-radius-card);
}

.assetPicker__footer button {
  min-height: 36px;
  padding: 0 16px;
  color: var(--td-text-color-anti);
  background: var(--td-brand-color);
  border: 1px solid var(--td-brand-color);
  border-radius: 9px;
}

.assetPicker__footer button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

@media (max-width: 720px) {
  .assetPicker__body,
  .assetPicker__grid {
    grid-template-columns: 1fr;
  }
}
</style>
