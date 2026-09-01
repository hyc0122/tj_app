<template>
  <div
    v-if="open"
    class="canvas-failure-backdrop focus-trap"
    role="presentation"
    :inert="false"
    @click.self="onEscape"
  >
    <section
      class="canvas-failure-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="失败详情"
      tabindex="-1"
      @keydown.escape="onEscape"
    >
      <h2>{{ $t("infiniteCanvas.execution.failure") }}</h2>
      <pre ref="bodyEl" class="safeProcessedText">{{ safeProcessedText }}</pre>
      <button type="button" @click="onEscape">关闭</button>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { sanitizeFailureText } from "@/features/tianjiang/canvas/useCanvasExecution";

const props = defineProps<{
  open: boolean;
  rawText: string;
}>();
const emit = defineEmits<{
  close: [];
}>();
const restoreFocus = ref<HTMLElement | null>(null);
const bodyEl = ref<HTMLElement | null>(null);
const safeProcessedText = computed(() => sanitizeFailureText(props.rawText));

function onEscape(): void {
  restoreFocus.value?.focus();
  emit("close");
}

watch(() => props.open, async (open) => {
  if (!open) return;
  await nextTick();
  if (bodyEl.value) bodyEl.value.textContent = safeProcessedText.value;
});

onMounted(() => {
  restoreFocus.value = document.activeElement as HTMLElement | null;
});
</script>
