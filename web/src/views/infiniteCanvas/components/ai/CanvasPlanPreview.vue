<template>
  <section v-if="visible" class="canvas-plan-preview" aria-label="计划预览">
    <p>{{ summary }}</p>
    <button type="button" :disabled="!completeDone" @click="applyPlan">
      {{ $t("infiniteCanvas.ai.applyPlan") }}
    </button>
  </section>
</template>

<script setup lang="ts">
const props = defineProps<{
  visible: boolean;
  summary: string;
  completeDone: boolean;
}>();
const emit = defineEmits<{
  apply: [];
}>();

function applyPlan(): void {
  if (!props.completeDone) return;
  emit("apply");
}
</script>
