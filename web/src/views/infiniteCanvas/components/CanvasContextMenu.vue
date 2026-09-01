<template>
  <div
    v-if="visible"
    class="canvas-context-menu"
    :style="{ left: `${x}px`, top: `${y}px` }"
  >
    <button type="button" @click="$emit('add', 'text')">新增文本</button>
    <button type="button" @click="$emit('add', 'image')">新增图片</button>
    <button type="button" @click="$emit('copy')">复制</button>
    <button type="button" @click="$emit('paste')">粘贴</button>
    <button type="button" @click="$emit('delete')">删除</button>
    <button type="button" @click="$emit('group')">分组</button>
    <button type="button" @click="$emit('ungroup')">解组</button>
  </div>
</template>

<script setup lang="ts">
import type { CanvasNodeKind } from "@/features/tianjiang/canvas/types";

defineProps<{ visible: boolean; x: number; y: number }>();
defineEmits<{
  (event: "add", kind: CanvasNodeKind): void;
  (event: "copy"): void;
  (event: "paste"): void;
  (event: "delete"): void;
  (event: "group"): void;
  (event: "ungroup"): void;
}>();
</script>
