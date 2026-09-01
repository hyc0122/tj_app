<template>
  <CanvasNodeFrame kind="text">
    <strong>{{ data.title }}</strong>
    <p>{{ data.text || data.prompt }}</p>
  </CanvasNodeFrame>
</template>

<script setup lang="ts">
import CanvasNodeFrame from "./CanvasNodeFrame.vue";

defineProps<{
  id: string;
  data: { title?: string; text?: string; prompt?: string };
}>();
</script>
