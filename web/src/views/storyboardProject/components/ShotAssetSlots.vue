<template>
  <section class="shotAssetSlots" aria-label="镜头资产绑定">
    <div
      v-for="slot in slots"
      :key="slot.type"
      class="shotAssetSlot"
      :data-asset-slot="slot.type"
      :data-bound="slot.matches.length > 0"
    >
      <ul v-if="slot.matches.length" class="shotAssetSlot__list">
        <li
          v-for="binding in slot.matches"
          :key="`${binding.sourceProjectUuid}:${binding.assetUuid}:${binding.assetType}`"
          class="shotAssetSlot__item"
          data-asset-row
          :data-asset-slot="slot.type"
          :data-asset-type="slot.type"
          :data-asset-id="binding.assetUuid"
          data-bound="true"
        >
          <span class="shotAssetSlot__name" data-asset-name>{{ assetName(binding) }}</span>
          <button
            v-if="slot.type === 'role'"
            type="button"
            data-action="toggle-binding-voice"
            :data-asset-id="binding.assetUuid"
            :data-voice-available="hasAudio(binding) ? 'true' : 'false'"
            :data-voice-enabled="isVoiceEnabled(binding) ? 'true' : 'false'"
            :disabled="readonly || !hasAudio(binding) || isUpdatingVoice(binding)"
            :title="voiceTitle(binding)"
            :aria-label="voiceTitle(binding)"
            @click.stop="requestToggleVoice(binding)"
          >
            <t-icon :name="voiceIconName(binding)" />
          </button>
          <button
            type="button"
            data-action="unbind-asset"
            :data-asset-id="binding.assetUuid"
            :disabled="readonly || isUnbinding(binding)"
            aria-label="取消关联"
            @click.stop="requestUnbind(binding)"
          >
            <t-icon name="close" />
          </button>
        </li>
      </ul>
      <button
        type="button"
        data-action="pick-asset"
        :data-asset-slot="slot.type"
        :data-asset-type="slot.type"
        :data-asset-id="slot.matches[0]?.assetUuid || ''"
        :data-bound="slot.matches.length > 0"
        :disabled="readonly"
        :aria-label="`${slot.label}资产：${slot.matches.length ? '已绑定，点击继续关联' : '未绑定，点击选择'}`"
        @click.stop="requestPick(slot.type)"
      >
        {{ slot.matches.length ? "继续关联" : `选择${slot.label}` }}
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { WorkspaceAsset, WorkspaceBinding } from "../storyboard-workbench-types";

export type ShotAssetType = "role" | "scene" | "tool";

const props = withDefaults(
  defineProps<{
    bindings?: WorkspaceBinding[];
    assets?: WorkspaceAsset[];
    readonly?: boolean;
    unbindingAssetUuid?: string;
    updatingVoiceAssetUuid?: string;
    singleType?: ShotAssetType;
  }>(),
  {
    bindings: () => [],
    assets: () => [],
    readonly: false,
    unbindingAssetUuid: "",
    updatingVoiceAssetUuid: "",
    singleType: undefined,
  },
);

const emit = defineEmits<{
  pick: [assetType: ShotAssetType];
  unbind: [binding: WorkspaceBinding];
  toggleVoice: [binding: WorkspaceBinding, voiceEnabled: boolean];
}>();

const slotDefinitions = [
  { type: "role", label: "角色", icon: "user" },
  { type: "scene", label: "场景", icon: "location" },
  { type: "tool", label: "道具", icon: "tools" },
] as const;

const slots = computed(() =>
  slotDefinitions
    .filter((definition) => !props.singleType || definition.type === props.singleType)
    .map((definition) => ({
      ...definition,
      // 中文注释：同一类型必须逐项展示全部 binding，禁止再折叠成第一项 +N。
      matches: props.bindings.filter((binding) => binding.assetType === definition.type),
    })),
);

function assetName(binding: WorkspaceBinding): string {
  const found = props.assets.find((asset) => (
    asset.assetUuid === binding.assetUuid
    && asset.sourceProjectUuid === binding.sourceProjectUuid
    && (asset.assetType === binding.assetType || String((asset as { type?: string }).type ?? "") === binding.assetType)
  ));
  // 中文注释：找不到 DTO 时只显示安全文案，禁止回退 UUID。
  return found?.name?.trim() || "已关联资产";
}

function findAsset(binding: WorkspaceBinding): WorkspaceAsset | undefined {
  return props.assets.find((asset) => (
    asset.assetUuid === binding.assetUuid
    && asset.sourceProjectUuid === binding.sourceProjectUuid
    && (asset.assetType === binding.assetType || String((asset as { type?: string }).type ?? "") === binding.assetType)
  ));
}

function hasAudio(binding: WorkspaceBinding): boolean {
  return findAsset(binding)?.hasAudio === true;
}

function isVoiceEnabled(binding: WorkspaceBinding): boolean {
  return binding.voiceEnabled !== false;
}

function isUpdatingVoice(binding: WorkspaceBinding): boolean {
  return Boolean(props.updatingVoiceAssetUuid && props.updatingVoiceAssetUuid === binding.assetUuid);
}

function voiceIconName(binding: WorkspaceBinding): string {
  // 中文注释：关闭音色仍显示喇叭按钮；图标必须使用依赖清单中真实存在的交叉静音图标。
  return hasAudio(binding) && isVoiceEnabled(binding) ? "sound" : "sound-mute";
}

function voiceTitle(binding: WorkspaceBinding): string {
  if (!hasAudio(binding)) return "该角色尚未上传音色";
  return isVoiceEnabled(binding) ? "音色已启用，点击临时关闭" : "音色已关闭，点击启用";
}

function isUnbinding(binding: WorkspaceBinding): boolean {
  return Boolean(props.unbindingAssetUuid && props.unbindingAssetUuid === binding.assetUuid);
}

function requestPick(assetType: ShotAssetType): void {
  if (props.readonly) return;
  emit("pick", assetType);
}

function requestUnbind(binding: WorkspaceBinding): void {
  if (props.readonly || isUnbinding(binding)) return;
  emit("unbind", binding);
}

function requestToggleVoice(binding: WorkspaceBinding): void {
  if (props.readonly || !hasAudio(binding) || isUpdatingVoice(binding)) return;
  emit("toggleVoice", binding, !isVoiceEnabled(binding));
}
</script>

<style scoped lang="scss">
.shotAssetSlots {
  display: grid;
  min-width: 0;
  gap: 6px;
}

.shotAssetSlot {
  display: grid;
  min-width: 0;
  gap: 6px;
  align-content: start;
}

.shotAssetSlot__list {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.shotAssetSlot__item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 6px;
  align-items: center;
  min-width: 0;
  padding: 5px 6px;
  border: 1px solid var(--product-border);
  border-radius: 8px;
  background: var(--product-surface-soft);
}

.shotAssetSlot__name {
  min-width: 0;
  overflow: hidden;
  color: var(--product-text);
  font-size: 11px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.shotAssetSlot__item [data-action="toggle-binding-voice"],
.shotAssetSlot__item [data-action="unbind-asset"] {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  color: var(--product-text-muted);
  background: transparent;
  cursor: pointer;
}

.shotAssetSlot__item [data-action="toggle-binding-voice"][data-voice-enabled="true"][data-voice-available="true"] {
  color: var(--td-brand-color);
}

.shotAssetSlot__item [data-action="toggle-binding-voice"]:disabled,
.shotAssetSlot__item [data-action="unbind-asset"]:disabled {
  cursor: not-allowed;
  opacity: 0.52;
}

.shotAssetSlot > [data-action="pick-asset"] {
  min-width: 0;
  min-height: 32px;
  padding: 6px 8px;
  border: 1px dashed var(--product-border);
  border-radius: 8px;
  color: var(--product-text-secondary);
  font-size: 11px;
  text-align: left;
  background: transparent;
  cursor: pointer;
}

.shotAssetSlot > [data-action="pick-asset"]:disabled {
  cursor: not-allowed;
  opacity: 0.52;
}
</style>
