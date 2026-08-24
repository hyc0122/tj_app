<template>
  <MediaLibraryView />
</template>

<script setup lang="ts">
import { provide } from "vue";
import type { MediaItem, AudioItem } from "./utils/mediaData";
import MediaLibraryView from "./components/MediaLibraryView.vue";
import { mediaLibraryContextKey } from "./mediaLibraryContext";
import { useMediaLibrary } from "./composables/useMediaLibrary";

const props = withDefaults(
  defineProps<{
    initialVideoItems?: MediaItem[];
    initialMediaItems?: MediaItem[];
    initialAudioItems?: AudioItem[];
    initialImageItems?: MediaItem[];
  }>(),
  {
    initialVideoItems: () => [],
    initialMediaItems: () => [],
    initialAudioItems: () => [],
    initialImageItems: () => [],
  },
);

provide(mediaLibraryContextKey, useMediaLibrary(props));
</script>
