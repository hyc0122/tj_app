<template>
  <aside v-if="open" class="canvas-drawer">
    <h2>素材</h2>
    <button type="button" @click="$emit('close')">关闭</button>
    <input type="file" @change="onPick" />
    <ul>
      <li v-for="item in assets" :key="item.assetUuid">
        <span>{{ item.assetUuid }}</span>
        <button type="button" @click="$emit('insert', item.assetUuid)">插入</button>
        <button type="button" @click="$emit('remove', item)">删除</button>
      </li>
    </ul>
    <p v-if="error">{{ error }}</p>
  </aside>
</template>

<script setup lang="ts">
defineProps<{
  open: boolean;
  assets: Array<{ assetUuid: string; sha256?: string }>;
  error?: string;
}>();
const emit = defineEmits<{
  (event: "close"): void;
  (event: "upload", file: File): void;
  (event: "insert", assetUuid: string): void;
  (event: "remove", asset: { assetUuid: string; sha256?: string }): void;
}>();

function onPick(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) emit("upload", file);
}
</script>
