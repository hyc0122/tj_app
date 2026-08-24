<template>
  <section
    class="shotGenerationState"
    :class="`is-${statusTone}`"
    :data-generation-state="mediaType"
    :data-generation-status="mediaType"
    :data-status="normalizedStatus"
    :aria-label="`${mediaLabel}生成状态：${statusLabel}`">
    <div class="shotGenerationState__status">
      <span class="shotGenerationState__dot" aria-hidden="true" />
      <span>
        <small>{{ mediaLabel }}任务</small>
        <strong>{{ statusLabel }}</strong>
      </span>
    </div>
    <div class="shotGenerationState__meta">
      <span v-if="task" class="shotGenerationState__model" :title="`${task.providerId}:${task.modelName}`">
        {{ task.modelName || task.providerId }}
      </span>
      <small
        v-if="!generationAvailable && unavailableReason"
        class="shotGenerationState__unavailable"
        :data-generation-unavailable="mediaType"
      >
        {{ unavailableReason }}
      </small>
    </div>
    <div class="shotGenerationState__actions">
      <button
        v-if="isFailed"
        type="button"
        :data-action="`retry-${mediaType}`"
        :data-source-task-id="task?.taskUuid"
        :disabled="readonly || busy || !generationAvailable"
        :aria-label="`按当前镜头参数重新生成${mediaLabel}`"
        @click.stop="requestRetry">
        <t-icon name="refresh" aria-hidden="true" />
        重新生成
      </button>
      <button
        type="button"
        :data-action="`generate-${mediaType}`"
        :disabled="readonly || busy || !generationAvailable"
        :aria-label="`${isFailed ? '生成新' : '生成'}${mediaLabel}任务`"
        @click.stop="requestGenerate">
        <t-icon name="play-circle" aria-hidden="true" />
        {{ isFailed ? "新建" : "生成" }}
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { StoryboardMediaType, WorkspaceGenerationTask } from "../storyboard-workbench-types";

const props = withDefaults(
  defineProps<{
    mediaType: StoryboardMediaType;
    task?: WorkspaceGenerationTask | null;
    readonly?: boolean;
    generationAvailable?: boolean;
    unavailableReason?: string;
    busy?: boolean;
  }>(),
  {
    task: null,
    readonly: false,
    generationAvailable: false,
    unavailableReason: "",
    busy: false,
  },
);

const emit = defineEmits<{
  generate: [];
  retry: [taskUuid: string];
}>();

const normalizedStatus = computed(() => props.task?.status?.trim().toLowerCase() || "idle");
const isFailed = computed(() => normalizedStatus.value.startsWith("failed"));
const mediaLabel = computed(() => (props.mediaType === "image" ? "图片" : "视频"));
const statusLabel = computed(
  () =>
    (
      ({
        idle: "未提交",
        queued: "排队中",
        running: "生成中",
        submitting: "提交中",
        submitted: "已提交",
        polling: "生成中",
        provider_completed: "结果处理中",
        completed: "已完成",
        failed: "失败",
        failed_retryable: "可重试失败",
        failed_fatal: "失败",
        cancelled: "已取消",
        unknown: "结果未知",
      }) as Record<string, string>
    )[normalizedStatus.value] || normalizedStatus.value,
);
const statusTone = computed(() => {
  if (["running", "submitting", "submitted", "polling", "provider_completed"].includes(normalizedStatus.value)) return "active";
  if (["queued", "unknown"].includes(normalizedStatus.value)) return "warning";
  if (normalizedStatus.value === "completed") return "success";
  if (normalizedStatus.value.startsWith("failed")) return "error";
  return "idle";
});
function requestGenerate(): void {
  if (props.readonly || props.busy || !props.generationAvailable) return;
  emit("generate");
}

function requestRetry(): void {
  if (props.readonly || props.busy || !props.generationAvailable || !props.task || !isFailed.value) return;
  emit("retry", props.task.taskUuid);
}
</script>

<style scoped lang="scss">
.shotGenerationState {
  display: grid;
  grid-template-columns: minmax(110px, auto) minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  min-height: 42px;
  padding-top: 8px;
  border-top: 1px solid var(--product-border);
}

.shotGenerationState__status {
  display: flex;
  gap: 7px;
  align-items: center;
}

.shotGenerationState__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--product-text-muted);
}

.shotGenerationState.is-active .shotGenerationState__dot {
  background: var(--td-brand-color);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--td-brand-color) 13%, transparent);
}

.shotGenerationState.is-warning .shotGenerationState__dot {
  background: var(--td-warning-color);
}

.shotGenerationState.is-success .shotGenerationState__dot {
  background: var(--td-success-color);
}

.shotGenerationState.is-error .shotGenerationState__dot {
  background: var(--td-error-color);
}

.shotGenerationState__status small,
.shotGenerationState__status strong {
  display: block;
}

.shotGenerationState__status small {
  color: var(--product-text-muted);
  font-size: 9px;
}

.shotGenerationState__status strong {
  margin-top: 2px;
  color: var(--product-text);
  font-size: 11px;
}

.shotGenerationState__model {
  display: block;
  overflow: hidden;
  color: var(--product-text-muted);
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.shotGenerationState__meta {
  min-width: 0;
}

.shotGenerationState__unavailable {
  color: var(--td-warning-color);
  font-size: 9px;
}

.shotGenerationState__actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
}

.shotGenerationState__actions > button {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  min-height: 30px;
  padding: 0 10px;
  border: 1px solid var(--product-border-strong);
  border-radius: 8px;
  color: var(--td-brand-color);
  background: color-mix(in srgb, var(--td-brand-color) 8%, var(--product-surface-soft));
  cursor: pointer;
  transition:
    border-color 150ms ease,
    background-color 150ms ease,
    box-shadow 150ms ease;
}

.shotGenerationState__actions > button:hover:not(:disabled),
.shotGenerationState__actions > button:focus-visible {
  border-color: var(--td-brand-color);
  background: color-mix(in srgb, var(--td-brand-color) 14%, var(--product-surface-soft));
}

.shotGenerationState__actions > button:focus-visible {
  outline: none;
  box-shadow: var(--product-focus-ring);
}

.shotGenerationState__actions > button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
</style>
