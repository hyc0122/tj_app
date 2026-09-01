<template>
  <div class="canvas-toolbar canvas-toolbar--bottom">
    <button type="button" @click="$emit('add', 'text')">文本</button>
    <button type="button" @click="$emit('add', 'image')">图片</button>
    <button type="button" @click="$emit('add', 'video')">视频</button>
    <button type="button" @click="$emit('add', 'audio')">音频</button>
    <button type="button" @click="$emit('add', 'file')">文件</button>
    <button type="button" @click="$emit('add', 'storyboard')">分镜</button>
    <button type="button" @click="$emit('add', 'image_generation')">文生图</button>
    <button type="button" @click="$emit('add', 'video_generation')">视频生成</button>
    <button type="button" @click="$emit('add', 'group')">分组</button>
    <button type="button" @click="$emit('group')">成组</button>
    <button type="button" @click="$emit('ungroup')">解组</button>
    <button type="button" @click="$emit('undo')">撤销</button>
    <button type="button" @click="$emit('redo')">重做</button>
  </div>
</template>

<script setup lang="ts">
import type { CanvasNodeKind } from "@/features/tianjiang/canvas/types";

defineEmits<{
  (event: "add", kind: CanvasNodeKind): void;
  (event: "group"): void;
  (event: "ungroup"): void;
  (event: "undo"): void;
  (event: "redo"): void;
}>();
</script>
