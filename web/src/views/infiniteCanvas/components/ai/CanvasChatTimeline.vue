<template>
  <ol class="canvas-chat-timeline" aria-live="polite">
    <li v-for="(item, index) in messages" :key="index">
      <strong>{{ item.role }}</strong>
      <p>{{ item.text }}</p>
    </li>
  </ol>
</template>

<script setup lang="ts">
import type { CanvasChatMessage } from "@/features/tianjiang/canvas/useCanvasAiSession";

defineProps<{
  messages: CanvasChatMessage[];
}>();
</script>
