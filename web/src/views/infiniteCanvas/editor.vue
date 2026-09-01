<template>
  <!-- CanvasAiPanel 由 TapCanvas 原右侧 AI 对话框承担 -->
  <TapCanvasHost :project-uuid="projectUuid" />
</template>

<script setup lang="ts">
import TapCanvasHost from "./TapCanvasHost.vue";

const route = useRoute();
const projectUuid = computed(() => String(route.params.projectUuid ?? ""));
</script>
