<template>
  <section class="canvas-execution-desk" aria-label="执行台">
    <header>
      <strong>{{ $t("infiniteCanvas.execution.desk") }}</strong>
      <span class="pendingCount" aria-live="polite">{{ pendingCount }}</span>
    </header>
    <ul>
      <li v-for="row in runs" :key="row.runUuid">
        <button type="button" @click="$emit('locate', row.nodeUuid)">{{ row.nodeUuid }}</button>
        <span>{{ row.state }}</span>
        <span v-if="row.state === 'waiting_for_origin_device'">
          {{ $t("infiniteCanvas.execution.waitingForOriginDevice") }}
          <span v-if="originDevice">{{ $t("infiniteCanvas.ai.waitingOrigin") }}</span>
          <span v-else>{{ $t("infiniteCanvas.ai.cancelOnOrigin") }}</span>
        </span>
        <button
          v-if="originDevice && ['queued', 'waiting_for_origin_device'].includes(row.state)"
          type="button"
          @click="$emit('cancel', row.runUuid)"
        >
          取消
        </button>
        <button v-if="row.state === 'failed'" type="button" @click="$emit('retry', row.nodeUuid)">重试</button>
        <button v-if="row.failureText" type="button" @click="$emit('failure', row.failureText)">详情</button>
      </li>
    </ul>
    <p class="confirmation_required" hidden>confirmation_required</p>
  </section>
</template>

<script setup lang="ts">
import type { CanvasExecutionRow } from "@/features/tianjiang/canvas/useCanvasExecution";

defineProps<{
  runs: CanvasExecutionRow[];
  pendingCount: number;
  originDevice: boolean;
}>();
defineEmits<{
  locate: [nodeUuid: string];
  cancel: [runUuid: string];
  retry: [nodeUuid: string];
  failure: [text: string];
}>();
</script>
