<template>
  <div
    v-if="open"
    class="canvas-execution-preview-backdrop focus-trap"
    role="presentation"
    inert="false"
    @click.self="onEscape"
  >
    <section
      class="canvas-execution-preview"
      role="dialog"
      aria-modal="true"
      aria-label="执行预览"
      tabindex="-1"
      @keydown.escape="onEscape"
    >
      <h2>{{ $t("infiniteCanvas.execution.preview") }}</h2>
      <p v-for="item in items" :key="item.nodeUuid">
        {{ item.nodeUuid }} / {{ item.modelId }} / {{ item.fee?.displayText }}
      </p>
      <p class="fee">{{ $t("infiniteCanvas.execution.fee") }}</p>
      <button type="button" :disabled="confirming" @click="$emit('confirm')">
        {{ $t("infiniteCanvas.execution.confirm") }}
      </button>
      <button type="button" @click="onEscape">取消</button>
    </section>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";

defineProps<{
  open: boolean;
  confirming: boolean;
  items: Array<{ nodeUuid: string; modelId?: string; fee?: { displayText?: string } }>;
}>();
const emit = defineEmits<{
  confirm: [];
  close: [];
}>();
const restoreFocus = ref<HTMLElement | null>(null);

function onEscape(): void {
  restoreFocus.value?.focus();
  emit("close");
}

onMounted(() => {
  restoreFocus.value = document.activeElement as HTMLElement | null;
});
</script>
