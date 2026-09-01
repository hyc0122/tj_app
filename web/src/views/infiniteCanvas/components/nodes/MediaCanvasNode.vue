<template>
  <CanvasNodeFrame :kind="kind">
    <strong>{{ data.title }}</strong>
    <img v-if="kind === 'image'" loading="lazy" alt="" :data-asset-uuid="data.assetUuid" />
    <video v-else-if="kind === 'video'" preload="none" controls :data-asset-uuid="data.assetUuid" />
    <audio v-else-if="kind === 'audio'" controls :data-asset-uuid="data.assetUuid" />
  </CanvasNodeFrame>
</template>

<script setup lang="ts">
import CanvasNodeFrame from "./CanvasNodeFrame.vue";

const props = defineProps<{
  id: string;
  type?: string;
  data: { title?: string; assetUuid?: string };
}>();

const kind = computed(() => String(props.type ?? "image"));
</script>
