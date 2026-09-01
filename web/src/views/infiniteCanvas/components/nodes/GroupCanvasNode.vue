<template>
  <CanvasNodeFrame kind="group">
    <strong>{{ data.title }}</strong>
  </CanvasNodeFrame>
</template>

<script setup lang="ts">
import CanvasNodeFrame from "./CanvasNodeFrame.vue";

defineProps<{
  id: string;
  data: { title?: string };
}>();
</script>
