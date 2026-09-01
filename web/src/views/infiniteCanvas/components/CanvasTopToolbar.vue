<template>
  <div class="canvas-toolbar canvas-toolbar--top">
    <div>{{ title }}</div>
    <div>
      <button type="button" @click="$emit('save')">保存</button>
      <button type="button" @click="$emit('layout')">一键整理</button>
      <button type="button" @click="$emit('import-export')">导入导出</button>
      <button type="button" @click="$emit('history')">历史</button>
      <button type="button" @click="$emit('assets')">素材</button>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{ title: string }>();
defineEmits<{
  (event: "save"): void;
  (event: "layout"): void;
  (event: "import-export"): void;
  (event: "history"): void;
  (event: "assets"): void;
}>();
</script>
