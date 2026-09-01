<template>
  <form class="canvas-chat-composer" @submit.prevent="emit('send')">
    <label>
      {{ $t("infiniteCanvas.ai.model") }}
      <select :value="modelId" @change="emit('update:modelId', ($event.target as HTMLSelectElement).value)">
        <option value="">默认</option>
      </select>
    </label>
    <div class="shortcut" role="group" aria-label="快捷提示">
      <button type="button" @click="emit('shortcut', '一句话出图')">一句话出图</button>
    </div>
    <p class="skill">{{ $t("infiniteCanvas.ai.skill") }}</p>
    <textarea
      :value="draft"
      :aria-label="$t('infiniteCanvas.ai.placeholder')"
      @input="emit('update:draft', ($event.target as HTMLTextAreaElement).value)"
      @compositionstart="emit('update:isComposing', true)"
      @compositionend="emit('update:isComposing', false)"
      @keydown="onKeydown"
    />
    <!-- Shift+Enter 换行；Enter 发送；IME isComposing 期间不发送 -->
    <input type="file" accept=".txt,.docx,image/*" multiple @change="onFiles" />
    <button type="button" class="voice" @click="emit('voice')">{{ $t("infiniteCanvas.ai.voice") }}</button>
    <button type="submit" :disabled="disabled">{{ $t("infiniteCanvas.ai.send") }}</button>
  </form>
</template>

<script setup lang="ts">
const props = defineProps<{
  draft: string;
  modelId: string;
  isComposing: boolean;
  disabled: boolean;
}>();
const emit = defineEmits<{
  send: [];
  shortcut: [value: string];
  voice: [];
  files: [files: File[]];
  "update:draft": [value: string];
  "update:modelId": [value: string];
  "update:isComposing": [value: boolean];
}>();

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" && event.shiftKey) return;
  if (event.key === "Enter" && !props.isComposing && !event.isComposing) {
    event.preventDefault();
    emit("send");
  }
}

function onFiles(event: Event): void {
  const input = event.target as HTMLInputElement;
  emit("files", [...(input.files ?? [])]);
}
</script>
