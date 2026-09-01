<template>
  <CanvasNodeFrame :kind="kind">
    <strong>{{ data.title }}</strong>
    <p>{{ kind }}</p>
    <button type="button" @click.stop="openPreview?.(id)">预览并执行</button>
  </CanvasNodeFrame>
</template>

<script setup lang="ts">
import CanvasNodeFrame from "./CanvasNodeFrame.vue";

const props = defineProps<{
  id: string;
  type?: string;
  data: { title?: string; prompt?: string };
}>();

const kind = computed(() => String(props.type ?? "image_generation"));
const openPreview = inject<((nodeUuid: string) => Promise<void>) | undefined>("canvas-execution-preview", undefined);
</script>
