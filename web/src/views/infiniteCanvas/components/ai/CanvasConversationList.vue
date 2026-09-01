<template>
  <nav class="canvas-conversation-list" aria-label="对话历史">
    <button type="button" class="newChat" @click="$emit('newChat')">{{ $t("infiniteCanvas.ai.newChat") }}</button>
    <ul>
      <li v-for="item in history" :key="item.conversationUuid">
        <button type="button" @click="$emit('select', item.conversationUuid)">{{ item.title }}</button>
      </li>
    </ul>
  </nav>
</template>

<script setup lang="ts">
defineProps<{
  history: Array<{ conversationUuid: string; title: string }>;
}>();
defineEmits<{
  newChat: [];
  select: [conversationUuid: string];
}>();
</script>
