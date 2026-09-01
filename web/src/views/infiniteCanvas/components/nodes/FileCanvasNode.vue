<template>
  <CanvasNodeFrame kind="file">
    <strong>{{ data.title }}</strong>
    <p>文件 {{ data.assetUuid }}</p>
  </CanvasNodeFrame>
</template>

<script setup lang="ts">
import CanvasNodeFrame from "./CanvasNodeFrame.vue";

defineProps<{
  id: string;
  data: { title?: string; assetUuid?: string };
}>();
</script>
