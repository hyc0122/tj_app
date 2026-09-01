<template>
  <CanvasNodeFrame kind="storyboard">
    <strong>{{ data.title }}</strong>
    <p>分镜</p>
  </CanvasNodeFrame>
</template>

<script setup lang="ts">
import CanvasNodeFrame from "./CanvasNodeFrame.vue";

defineProps<{
  id: string;
  data: { title?: string };
}>();
</script>
