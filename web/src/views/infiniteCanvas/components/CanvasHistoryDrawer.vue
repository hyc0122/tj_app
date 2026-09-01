<template>
  <aside v-if="open" class="canvas-drawer">
    <h2>历史</h2>
    <button type="button" @click="$emit('close')">关闭</button>
    <ul>
      <li v-for="item in revisions" :key="item.revisionUuid">
        <span>r{{ item.documentRevision }}</span>
        <button type="button" @click="$emit('restore', item.revisionUuid)">恢复</button>
      </li>
    </ul>
  </aside>
</template>

<script setup lang="ts">
defineProps<{
  open: boolean;
  revisions: Array<{ revisionUuid: string; documentRevision: number }>;
}>();
defineEmits<{
  (event: "close"): void;
  (event: "restore", revisionUuid: string): void;
}>();
</script>
