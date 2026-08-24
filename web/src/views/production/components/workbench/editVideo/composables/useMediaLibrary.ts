import { onMounted, ref, watch } from "vue";
import { extractVideoThumbnails, extractAudioWaveform } from "vue-clip-track";
import {
  type MediaItem,
  type AudioItem,
  getTextItems,
  getTransitionItems,
  getEffectItems,
  getFilterItems,
  getLibraryTabs,
  formatDuration,
} from "../utils/mediaData";
import { buildMediaDragData } from "./mediaLibraryLogic";

export interface MediaLibraryProps {
  initialVideoItems: MediaItem[];
  initialMediaItems: MediaItem[];
  initialAudioItems: AudioItem[];
  initialImageItems: MediaItem[];
}

export function useMediaLibrary(props: MediaLibraryProps) {
  const activeTab = ref("video");
  const tabs = getLibraryTabs();
  const videoItems = ref<MediaItem[]>([...props.initialVideoItems]);
  const mediaItems = ref<MediaItem[]>([...props.initialMediaItems]);
  const audioItems = ref<AudioItem[]>([...props.initialAudioItems]);
  const imageItems = ref<MediaItem[]>([...props.initialImageItems]);
  const textItems = ref(getTextItems());
  const transitionItems = ref(getTransitionItems());
  const effectItems = ref(getEffectItems());
  const filterItems = ref(getFilterItems());

  async function loadVideoThumbnails() {
    for (const item of [...mediaItems.value, ...videoItems.value]) {
      try {
        const result = await extractVideoThumbnails(item.url, { count: 10, width: 120 });
        item.duration = result.duration;
        item.thumbnails = result.thumbnails;
        item.thumbnail = result.thumbnails[0] || "";
        item.loading = false;
      } catch (error) {
        console.error(`Failed to load thumbnails for ${item.name}:`, error);
        item.loading = false;
        item.duration = 5;
      }
    }
  }

  async function loadImageThumbnails() {
    for (const item of imageItems.value) {
      try {
        const img = new Image();
        img.crossOrigin = "anonymous";
        await new Promise<void>((resolve, reject) => {
          img.onload = () => {
            item.thumbnail = item.url;
            item.loading = false;
            resolve();
          };
          img.onerror = reject;
          img.src = item.url;
        });
      } catch (error) {
        console.error(`Failed to load image ${item.name}:`, error);
        item.loading = false;
      }
    }
  }

  async function loadAudioWaveforms() {
    for (const item of audioItems.value) {
      try {
        const result = await extractAudioWaveform(item.url, { samples: 50 });
        item.duration = result.duration;
        item.waveformData = result.waveformData;
        item.loading = false;
      } catch (error) {
        console.error(`Failed to load waveform for ${item.name}:`, error);
        item.loading = false;
        item.duration = 30;
      }
    }
  }

  watch(
    () => props.initialVideoItems,
    (items) => {
      videoItems.value = [...items];
      if (items.length > 0) loadVideoThumbnails();
    },
  );
  watch(
    () => props.initialMediaItems,
    (items) => {
      mediaItems.value = [...items];
      if (items.length > 0) loadVideoThumbnails();
    },
  );
  watch(
    () => props.initialAudioItems,
    (items) => {
      audioItems.value = [...items];
      if (items.length > 0) loadAudioWaveforms();
    },
  );
  watch(
    () => props.initialImageItems,
    (items) => {
      imageItems.value = [...items];
      if (items.length > 0) loadImageThumbnails();
    },
  );

  function handleDragStart(event: DragEvent, item: any) {
    if (!event.dataTransfer) return;
    const dragData = buildMediaDragData(item);
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("application/json", JSON.stringify(dragData));
    event.dataTransfer.setData("text/plain", item.name);
    if (event.target instanceof HTMLElement) event.target.classList.add("dragging");
  }

  function handleDragEnd(event: DragEvent) {
    if (event.target instanceof HTMLElement) event.target.classList.remove("dragging");
  }

  onMounted(() => {
    // 延后昂贵的媒体解析，保持页面首屏响应与原实现一致。
    setTimeout(() => {
      loadVideoThumbnails();
      loadAudioWaveforms();
      loadImageThumbnails();
    }, 100);
  });

  return {
    activeTab,
    tabs,
    videoItems,
    mediaItems,
    audioItems,
    imageItems,
    textItems,
    transitionItems,
    effectItems,
    filterItems,
    formatDuration,
    handleDragStart,
    handleDragEnd,
  };
}
