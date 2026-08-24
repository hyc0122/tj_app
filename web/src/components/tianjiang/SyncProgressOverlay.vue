<template>
  <div
    v-if="visible"
    class="sync-progress-overlay"
    role="dialog"
    aria-modal="true"
    data-testid="sync-progress-overlay"
  >
    <div class="sync-progress-card">
      <h2>{{ t("syncProgress.title") }}</h2>
      <p v-if="progress.projectName" class="project-name">
        {{ progress.projectName }}
        <span v-if="progress.projectKind">({{ progress.projectKind }})</span>
      </p>
      <p class="phase">{{ phaseLabel }}</p>
      <p class="objects">
        {{ t("syncProgress.objects") }}:
        {{ progress.objectIndex ?? progress.completedObjects }}/{{ progress.objectTotal ?? progress.totalObjects }}
      </p>
      <p class="bytes">
        {{ t("syncProgress.bytes") }}:
        {{ byteText }}
      </p>
      <p class="projects">
        {{ t("syncProgress.projects") }}:
        {{ progress.completedProjects }}/{{ progress.totalProjects }}
      </p>
      <p v-if="progress.state === 'failed'" class="error" data-testid="sync-progress-error">
        {{ progress.errorMessage || t("syncProgress.failed") }}
        <span v-if="progress.errorCode">({{ progress.errorCode }})</span>
      </p>
      <button
        v-if="progress.state === 'failed'"
        type="button"
        data-testid="sync-progress-return"
        @click="emit('return')"
      >
        {{ t("syncProgress.returnToApp") }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import {
  formatByteProgress,
  type SyncProgressSnapshot,
} from "@/features/tianjiang/sync/progress";

const props = defineProps<{
  progress: SyncProgressSnapshot;
}>();

const emit = defineEmits<{
  return: [];
}>();

const { t } = useI18n();

const visible = computed(
  () => props.progress.state === "running" || props.progress.state === "failed",
);

const phaseLabel = computed(() => {
  const key = `syncProgress.phase.${props.progress.phase}`;
  const translated = t(key);
  return translated === key ? props.progress.phase : translated;
});

const byteText = computed(() =>
  formatByteProgress(
    props.progress.bytesDone ?? props.progress.uploadedBytes,
    props.progress.bytesTotal ?? props.progress.totalBytes,
  ),
);
</script>

<style scoped>
.sync-progress-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
}
.sync-progress-card {
  min-width: 320px;
  max-width: 480px;
  padding: 24px;
  border-radius: 12px;
  background: var(--td-bg-color-container, #fff);
  color: var(--td-text-color-primary, #111);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
}
.project-name {
  font-weight: 600;
}
.error {
  color: #d54941;
  margin-top: 12px;
}
button {
  margin-top: 16px;
}
</style>
