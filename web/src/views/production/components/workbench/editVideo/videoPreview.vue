<template>
  <div class="videoPreview">
    <!-- AVCanvas 视频预览区域 -->
    <div ref="canvasContainer" class="previewScreen">
      <div v-if="!hasSprites" class="previewScreenPlaceholder">
        <div class="placeholderIcon"><i-film theme="outline" size="48" fill="var(--td-text-color-placeholder)" /></div>
        <div class="placeholderText">{{ $t('workbench.production.editVideo.videoPreviewArea') }}</div>
        <div class="placeholderTime">{{ formatTime(currentTimeInSeconds) }}</div>
      </div>

      <!-- 播放指示器 -->
      <div v-if="isPlaying && !hasSprites" class="previewScreenPlaying">
        <div class="playingIndicator"><i-play theme="outline" size="36" fill="#000000" /></div>
      </div>
    </div>

    <!-- 播放进度条 -->
    <div class="previewProgress">
      <input type="range" min="0" :max="durationInSeconds" :value="currentTimeInSeconds" step="0.01" class="progressSlider" @input="handleSeek" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { useVideoPreview } from "./composables/useVideoPreview";

const props = withDefaults(
  defineProps<{ canvasWidth?: number; canvasHeight?: number }>(),
  { canvasWidth: 1920, canvasHeight: 1080 },
);
const emit = defineEmits<{ play: []; pause: [] }>();
const {
  canvasContainer, hasSprites, isPlaying, currentTimeInSeconds, durationInSeconds,
  handleSeek, formatTime, exposed,
} = useVideoPreview(props, (event) => {
  if (event === "play") emit("play");
  else emit("pause");
});
defineExpose(exposed);
</script>

<style lang="scss" scoped>
@use "./styles/video-preview.scss";
</style>
