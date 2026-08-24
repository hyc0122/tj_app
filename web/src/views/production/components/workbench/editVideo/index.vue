<template>
  <EditVideoView />
</template>

<script setup lang="ts">
import { provide } from "vue";
import type { Track } from "vue-clip-track";
import type { MediaItem, AudioItem } from "./utils/mediaData";
import EditVideoView from "./components/EditVideoView.vue";
import { editVideoContextKey } from "./editVideoContext";
import { useEditVideoPage } from "./composables/useEditVideoPage";

const props = withDefaults(
  defineProps<{
    initialTracks?: Track[];
    initialVideoItems?: MediaItem[];
    initialMediaItems?: MediaItem[];
    initialAudioItems?: AudioItem[];
    initialImageItems?: MediaItem[];
    canvasWidth?: number;
    canvasHeight?: number;
  }>(),
  {
    initialTracks: () => [],
    initialMediaItems: () => [],
    initialAudioItems: () => [],
    initialImageItems: () => [],
    canvasWidth: 1920,
    canvasHeight: 1080,
  },
);

provide(editVideoContextKey, useEditVideoPage(props));
</script>
