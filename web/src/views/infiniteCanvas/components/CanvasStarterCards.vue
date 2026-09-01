<template>
  <div class="cards">
    <button
      v-for="kind in cards"
      :key="kind"
      type="button"
      :data-starter="kind"
      @click="$emit('select', kind)"
    >
      {{ kind }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { CANVAS_EMPTY_STATE_CARDS, type CanvasStarterKind } from "@/features/tianjiang/canvas/navigation";

const cards = CANVAS_EMPTY_STATE_CARDS;
defineEmits<{ (event: "select", kind: CanvasStarterKind): void }>();
</script>
