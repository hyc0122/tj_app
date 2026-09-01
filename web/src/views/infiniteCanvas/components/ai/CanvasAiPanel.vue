<template>
  <aside
    class="canvas-ai-panel focus-trap"
    :class="{ docked, collapsed, fullscreen, drawer }"
    role="complementary"
    aria-label="画布 AI"
    :inert="collapsed"
    @keydown.escape="onEscape"
  >
    <header>
      <p>{{ $t("infiniteCanvas.ai.greeting", { name: greetingName }) }}</p>
      <button type="button" @click="collapsed = !collapsed">{{ $t("infiniteCanvas.ai.collapse") }}</button>
      <button type="button" @click="toggleFullscreen">
        {{ fullscreen ? $t("infiniteCanvas.ai.restore") : $t("infiniteCanvas.ai.fullscreen") }}
      </button>
      <button type="button" class="resize" tabindex="0" :aria-label="$t('infiniteCanvas.a11y.resizeHandle')"></button>
    </header>
    <CanvasConversationList :history="history" @new-chat="newChat" />
    <CanvasChatTimeline :messages="messages" />
    <p v-if="selectedContext" class="context">{{ selectedContext }}</p>
    <CanvasChatComposer
      :draft="draft"
      :model-id="modelId"
      :is-composing="isComposing"
      :disabled="!canSend"
      @send="send"
      @voice="onVoice"
      @update:draft="draft = $event"
      @update:model-id="modelId = $event"
      @update:is-composing="isComposing = $event"
    />
    <CanvasPlanPreview
      :visible="completeDone"
      :summary="pendingSummary"
      :complete-done="completeDone"
      @apply="applyPlan"
    />
    <div class="canvas-ai-live" aria-live="polite">{{ liveStatus }}</div>
  </aside>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useCanvasAiSession } from "@/features/tianjiang/canvas/useCanvasAiSession";
import CanvasConversationList from "./CanvasConversationList.vue";
import CanvasChatTimeline from "./CanvasChatTimeline.vue";
import CanvasChatComposer from "./CanvasChatComposer.vue";
import CanvasPlanPreview from "./CanvasPlanPreview.vue";

const props = defineProps<{
  projectUuid: string;
  baseRevision: number;
  greetingName: string;
  selectedContext?: string;
}>();

const docked = ref(true);
const collapsed = ref(false);
const fullscreen = ref(false);
const drawer = ref(false);
const restoreFocus = ref<HTMLElement | null>(null);
const liveStatus = ref("");
const session = useCanvasAiSession(
  () => props.projectUuid,
  () => props.baseRevision,
);
const {
  history,
  messages,
  draft,
  modelId,
  isComposing,
  canSend,
  completeDone,
  newChat,
  send,
  applyPlan,
} = session;

const pendingSummary = computed(() => messages.value.at(-1)?.text ?? "");

function toggleFullscreen(): void {
  fullscreen.value = !fullscreen.value;
  if (!fullscreen.value) restoreFocus.value?.focus();
}

function onEscape(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  if (fullscreen.value) {
    fullscreen.value = false;
    restoreFocus.value?.focus();
    return;
  }
  collapsed.value = true;
}

function onVoice(): void {
  liveStatus.value = "voice";
}

onMounted(() => {
  restoreFocus.value = document.activeElement as HTMLElement | null;
  void session.loadHistory();
});
onBeforeUnmount(() => {
  restoreFocus.value?.focus();
});
</script>
