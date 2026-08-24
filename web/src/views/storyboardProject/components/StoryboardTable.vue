<template>
  <section class="storyboardShotList" data-panel="shot-list">
    <header class="shotListHeader">
      <div>
        <span>镜头序列</span>
        <strong>{{ shots.length }} SHOTS</strong>
      </div>
      <span class="shotListHeader__hint">勾选后可批量提交；点击行查看右侧生产面板</span>
    </header>

    <div v-if="loading && shots.length === 0" class="shotListLoading" aria-label="正在加载分镜">
      <i v-for="index in 5" :key="index" />
    </div>
    <div v-else-if="shots.length === 0" class="shotListEmpty">
      <span><t-icon name="film" /></span>
      <strong>还没有分镜</strong>
      <p>从新增分镜或导入现有脚本开始。</p>
      <t-button theme="primary" :disabled="readonly" :loading="inserting" @click="requestInsert(null)">新增第一条分镜</t-button>
    </div>
    <div v-else class="shotProductionTableWrap">
      <table class="shotProductionTable">
        <thead>
          <tr>
            <th class="shotColCheck"></th>
            <th class="shotColNo">分镜</th>
            <th>分镜提示词</th>
            <th>角色</th>
            <th>场景</th>
            <th>道具</th>
            <th class="shotColOps">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="shot in shots"
            :key="shot.shotUuid"
            :data-shot-id="shot.shotUuid"
            class="shotProductionRow module-interactive--panel"
            :class="{ 'is-selected': selectedShotUuid === shot.shotUuid }"
            tabindex="0"
            :aria-current="selectedShotUuid === shot.shotUuid ? 'true' : undefined"
            @click="requestSelect(shot.shotUuid)"
            @keydown.enter.self="requestSelect(shot.shotUuid)"
            @keydown.space.self.prevent="requestSelect(shot.shotUuid)"
          >
            <td class="shotColCheck" @click.stop>
              <input
                type="checkbox"
                :data-shot-select="shot.shotUuid"
                :checked="selectedShotIds.includes(shot.shotUuid)"
                :disabled="readonly"
                @change="toggleSelect(shot.shotUuid)"
              />
            </td>
            <td class="shotColNo">
              <span>{{ String(shot.displayOrder).padStart(2, "0") }}</span>
              <small data-shot-summary-status :data-status="shotSummaryStatus(shot)">{{ shotSummaryLabel(shot) }}</small>
            </td>
            <td>
              <ShotPromptCell :shot="shot" />
            </td>
            <td>
              <ShotAssetSlots
                :bindings="bindingsOf(shot, 'role')"
                :assets="assets"
                :readonly="readonly"
                :unbinding-asset-uuid="unbindingAssetUuid"
                :updating-voice-asset-uuid="updatingVoiceAssetUuid"
                :single-type="'role'"
                @pick="() => requestPickAsset(shot.shotUuid, 'role')"
                @unbind="(binding) => emit('unbindAsset', { shotUuid: shot.shotUuid, ...binding })"
                @toggle-voice="(binding, voiceEnabled) => emit('toggleBindingVoice', { shotUuid: shot.shotUuid, ...binding, voiceEnabled })"
              />
            </td>
            <td>
              <ShotAssetSlots
                :bindings="bindingsOf(shot, 'scene')"
                :assets="assets"
                :readonly="readonly"
                :unbinding-asset-uuid="unbindingAssetUuid"
                :updating-voice-asset-uuid="updatingVoiceAssetUuid"
                :single-type="'scene'"
                @pick="() => requestPickAsset(shot.shotUuid, 'scene')"
                @unbind="(binding) => emit('unbindAsset', { shotUuid: shot.shotUuid, ...binding })"
              />
            </td>
            <td>
              <ShotAssetSlots
                :bindings="bindingsOf(shot, 'tool')"
                :assets="assets"
                :readonly="readonly"
                :unbinding-asset-uuid="unbindingAssetUuid"
                :updating-voice-asset-uuid="updatingVoiceAssetUuid"
                :single-type="'tool'"
                @pick="() => requestPickAsset(shot.shotUuid, 'tool')"
                @unbind="(binding) => emit('unbindAsset', { shotUuid: shot.shotUuid, ...binding })"
              />
            </td>
            <td class="shotColOps" @click.stop>
              <div class="shotOps">
                <button type="button" data-action="preview-shot" :data-shot-id="shot.shotUuid" :disabled="readonly" @click="requestPreview(shot.shotUuid)">预览</button>
                <button type="button" data-action="generate-video" :disabled="readonly || generationBusy || !videoGenerationEnabled" @click="emit('generate', shot.shotUuid, 'video')">提交</button>
                <button
                  v-if="failedVideoTask(shot)"
                  type="button"
                  data-action="retry-video"
                  :data-source-task-id="failedVideoTask(shot)?.taskUuid"
                  :disabled="readonly || generationBusy || !videoGenerationEnabled"
                  @click="emit('retry', failedVideoTask(shot)!.taskUuid, shot.shotUuid, 'video')"
                >重试</button>
                <button type="button" data-action="insert-after" :data-shot-id="shot.shotUuid" :disabled="readonly" aria-label="在当前镜头后插入" @click="requestInsert(shot.shotUuid)">在此插入</button>
                <button type="button" data-action="move-shot-up" :data-shot-id="shot.shotUuid" :disabled="readonly || isFirst(shot)" @click="emit('move', shot.shotUuid, 'up')">上移</button>
                <button type="button" data-action="move-shot-down" :data-shot-id="shot.shotUuid" :disabled="readonly || isLast(shot)" @click="emit('move', shot.shotUuid, 'down')">下移</button>
                <button type="button" data-action="delete-shot" :data-shot-id="shot.shotUuid" :disabled="readonly" @click="emit('remove', shot.shotUuid)">删除</button>
                <input
                  name="durationSeconds"
                  type="number"
                  min="4"
                  max="30"
                  step="1"
                  :value="Math.round(Number(shot.durationMs ?? 5000) / 1000)"
                  :disabled="readonly"
                  aria-label="时长"
                  @change="emitDuration(shot.shotUuid, $event)"
                />
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<script setup lang="ts">
import ShotAssetSlots, { type ShotAssetType } from "./ShotAssetSlots.vue";
import ShotPromptCell from "./ShotPromptCell.vue";
import type { WorkspaceAsset, WorkspaceBinding, WorkspaceShot } from "../storyboard-workbench-types";

const props = withDefaults(
  defineProps<{
    projectUuid?: string;
    shots: WorkspaceShot[];
    assets?: WorkspaceAsset[];
    selectedShotUuid?: string;
    selectedShotIds?: string[];
    loading?: boolean;
    readonly?: boolean;
    inserting?: boolean;
    generationBusy?: boolean;
    unbindingAssetUuid?: string;
    updatingVoiceAssetUuid?: string;
    videoGenerationEnabled?: boolean;
  }>(),
  {
    projectUuid: "",
    assets: () => [],
    selectedShotUuid: "",
    selectedShotIds: () => [],
    loading: false,
    readonly: false,
    inserting: false,
    generationBusy: false,
    unbindingAssetUuid: "",
    updatingVoiceAssetUuid: "",
    videoGenerationEnabled: true,
  },
);

const emit = defineEmits<{
  select: [shotUuid: string];
  toggleSelect: [shotUuid: string];
  insert: [afterShotUuid: string | null];
  pickAsset: [shotUuid: string, assetType: ShotAssetType];
  toggleBindingVoice: [WorkspaceBinding & { shotUuid: string; voiceEnabled: boolean }];
  move: [shotUuid: string, direction: "up" | "down"];
  remove: [shotUuid: string];
  changeDuration: [shotUuid: string, durationMs: number];
  preview: [shotUuid: string];
  generate: [shotUuid: string, mediaType: "image" | "video"];
  retry: [taskUuid: string, shotUuid: string, mediaType: "image" | "video"];
  unbindAsset: [WorkspaceBinding & { shotUuid: string }];
}>();

function emitDuration(shotUuid: string, event: Event): void {
  const seconds = Number((event.target as HTMLInputElement).value);
  if (!Number.isInteger(seconds) || seconds < 4 || seconds > 30) return;
  emit("changeDuration", shotUuid, seconds * 1000);
}

function bindingsOf(shot: WorkspaceShot, type: ShotAssetType) {
  return (shot.bindings || []).filter((binding) => binding.assetType === type);
}

function isFirst(shot: WorkspaceShot): boolean {
  return props.shots[0]?.shotUuid === shot.shotUuid;
}

function isLast(shot: WorkspaceShot): boolean {
  return props.shots[props.shots.length - 1]?.shotUuid === shot.shotUuid;
}

type ShotSummaryStatus = "failed" | "active" | "queued" | "selected" | "completed" | "idle";

function shotSummaryStatus(shot: WorkspaceShot): ShotSummaryStatus {
  const statuses = (shot.generationTasks || []).map((task) => task.status.trim().toLowerCase());
  if (statuses.some((status) => status.startsWith("failed"))) return "failed";
  if (statuses.some((status) => ["running", "submitting", "submitted", "polling", "provider_completed"].includes(status))) return "active";
  if (statuses.includes("queued")) return "queued";
  if ((shot.candidates || []).some((candidate) => candidate.selected)) return "selected";
  if (statuses.includes("completed")) return "completed";
  return "idle";
}

function shotSummaryLabel(shot: WorkspaceShot): string {
  return (
    {
      failed: "存在失败",
      active: "生成中",
      queued: "排队中",
      selected: "已有采用",
      completed: "已完成",
      idle: "未提交",
    } as const
  )[shotSummaryStatus(shot)];
}

function requestSelect(shotUuid: string): void {
  emit("select", shotUuid);
}

function toggleSelect(shotUuid: string): void {
  emit("toggleSelect", shotUuid);
}

function requestInsert(afterShotUuid: string | null): void {
  if (props.readonly || props.inserting) return;
  emit("insert", afterShotUuid);
}

function requestPickAsset(shotUuid: string, assetType: ShotAssetType): void {
  if (props.readonly) return;
  emit("pickAsset", shotUuid, assetType);
}

function requestPreview(shotUuid: string): void {
  emit("select", shotUuid);
  emit("preview", shotUuid);
}

function failedVideoTask(shot: WorkspaceShot) {
  return [...(shot.generationTasks || [])]
    .filter((task) => task.mediaType === "video" && task.status.trim().toLowerCase().startsWith("failed"))
    .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
}
</script>
