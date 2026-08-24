<template>
  <div class="shotPromptCell" data-field="video-prompt">
    <p :title="displayText || '空提示词'">{{ displayText || "空提示词" }}</p>
  </div>
</template>

<script setup lang="ts">
import type { WorkspaceShot } from "../storyboard-workbench-types";

const props = defineProps<{
  shot: WorkspaceShot;
}>();

const displayText = computed(() => {
  const prompt = String(props.shot.videoPrompt ?? "").trim();
  if (prompt) return String(props.shot.videoPrompt ?? "");
  return String(props.shot.visualDescription || props.shot.sourceText || "");
});
</script>
