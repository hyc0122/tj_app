<template>
  <form class="composer" @submit.prevent="submit">
    <textarea
      v-model="prompt"
      maxlength="20000"
      placeholder="一句话描述你的画布"
    />
    <button type="submit" :disabled="!prompt.trim() || submitting">开始规划</button>
  </form>
</template>

<script setup lang="ts">
import { createCanvasHomePlanningPort, type CanvasHomePlanningPort } from "@/features/tianjiang/canvas/api";

const props = defineProps<{
  projectUuid?: string;
  port?: CanvasHomePlanningPort;
}>();

const prompt = ref("");
const submitting = ref(false);

async function submit(): Promise<void> {
  if (!props.projectUuid) return;
  submitting.value = true;
  try {
    const port = props.port ?? createCanvasHomePlanningPort();
    await port.plan(props.projectUuid, {
      prompt: prompt.value.trim(),
      baseRevision: 0,
      clientChatRequestId: crypto.randomUUID(),
      requestDigest: "0".repeat(64),
    });
  } finally {
    submitting.value = false;
  }
}
</script>
