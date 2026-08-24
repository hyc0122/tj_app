<template>
  <section class="shotCandidateStrip" :data-candidate-strip="mediaType" :aria-label="`${mediaLabel}候选`">
    <div v-if="visibleCandidates.length" class="shotCandidateStrip__items">
      <button
        v-for="entry in visibleCandidates"
        :key="entry.candidate.candidateUuid"
        type="button"
        class="shotCandidate"
        data-action="preview-candidate"
        :data-candidate-media="entry.candidate.mediaType"
        :data-candidate-id="entry.candidate.candidateUuid"
        :data-selected="entry.candidate.selected"
        :disabled="readonly || busy"
        :aria-pressed="selectedCandidateUuid === entry.candidate.candidateUuid"
        :aria-label="`预览${mediaLabel}候选 ${entry.name}`"
        @click.stop="previewCandidate(entry.candidate.candidateUuid)">
        <span class="shotCandidate__visual" aria-hidden="true" :data-video-poster="mediaType === 'video' && entry.mediaUrl ? 'card' : undefined">
          <template v-if="entry.mediaUrl">
            <img v-if="mediaType === 'image'" :src="entry.mediaUrl" alt="" />
            <video v-else :src="entry.mediaUrl" muted playsinline preload="metadata" @loadedmetadata="seekPreviewFrame" />
          </template>
          <t-icon v-else :name="mediaType === 'image' ? 'image' : 'video'" />
        </span>
        <span class="shotCandidate__copy">
          <strong>{{ entry.name }}</strong>
          <small>{{ entry.candidate.selected ? "已采用" : selectedCandidateUuid === entry.candidate.candidateUuid ? "正在预览" : "点击预览" }}</small>
        </span>
        <t-icon v-if="entry.candidate.selected" name="check-circle" class="shotCandidate__selected" aria-hidden="true" />
      </button>
      <span v-if="hiddenCount" class="shotCandidateStrip__more">+{{ hiddenCount }}</span>
    </div>
    <div v-else class="shotCandidateStrip__empty">
      <t-icon :name="mediaType === 'image' ? 'image' : 'video'" aria-hidden="true" />
      <span>暂无{{ mediaLabel }}候选</span>
    </div>
    <div
      v-if="selectedEntry"
      class="shotCandidatePreview"
      :data-candidate-preview="mediaType"
      :data-selected-candidate="selectedEntry.candidate.candidateUuid"
    >
      <div class="shotCandidatePreview__media">
        <template v-if="selectedEntry.mediaUrl">
          <img v-if="mediaType === 'image'" :src="selectedEntry.mediaUrl" :alt="`${selectedEntry.name}预览`" />
          <div v-else class="shotCandidatePreview__videoShell">
            <p v-if="videoLoadFailed" class="shotCandidatePreview__error">视频无法预览，视频暂时无法播放</p>
            <video
              v-else
              :key="`${previewGeneration}-${selectedEntry.candidate.candidateUuid}`"
              ref="previewVideoRef"
              data-preview-video
              data-video-poster="preview"
              :data-preview-frame="frameReady ? 'ready' : undefined"
              :src="selectedEntry.mediaUrl"
              :controls="showNativeControls"
              playsinline
              preload="metadata"
              @loadedmetadata="seekPreviewFrame"
              @seeked="onPreviewSeeked"
              @play="onPreviewPlay"
              @pause="onPreviewPause"
              @ended="onPreviewPause"
              @error="onPreviewError"
            />
            <button
              v-if="!videoLoadFailed"
              type="button"
              class="shotCandidatePreview__play"
              data-action="toggle-video-playback"
              :aria-label="isPlaying ? '暂停视频' : '播放视频'"
              @click.stop="togglePlayback"
            >
              {{ isPlaying ? "暂停" : "播放" }}
            </button>
          </div>
        </template>
        <span v-else><t-icon :name="mediaType === 'image' ? 'image' : 'video'" />安全预览不可用</span>
      </div>
      <div class="shotCandidatePreview__footer">
        <div><small>当前预览</small><strong>{{ selectedEntry.name }}</strong></div>
        <button
          type="button"
          data-action="confirm-candidate-selection"
          :disabled="readonly || busy || selectedEntry.candidate.selected"
          @click.stop="confirmSelection"
        >
          {{ selectedEntry.candidate.selected ? "已采用" : busy ? "采用中…" : "采用此候选" }}
        </button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { buildStoryboardMediaUrl } from "../storyboard-media-url";
import type { StoryboardMediaType, WorkspaceCandidate } from "../storyboard-workbench-types";

const props = withDefaults(
  defineProps<{
    projectUuid?: string;
    mediaType: StoryboardMediaType;
    candidates?: WorkspaceCandidate[];
    readonly?: boolean;
    busy?: boolean;
  }>(),
  {
    projectUuid: "",
    candidates: () => [],
    readonly: false,
    busy: false,
  },
);

const emit = defineEmits<{
  select: [candidateUuid: string];
}>();

const selectedCandidateUuid = ref("");
const previewVideoRef = ref<HTMLVideoElement | null>(null);
const isPlaying = ref(false);
const showNativeControls = ref(false);
const videoLoadFailed = ref(false);
const frameReady = ref(false);
const previewGeneration = ref(0);

const matchingCandidates = computed(() =>
  props.candidates
    .filter((candidate) => candidate.mediaType === props.mediaType)
    .sort((left, right) => Number(right.selected) - Number(left.selected) || right.createdAt.localeCompare(left.createdAt)),
);
const visibleCandidates = computed(() =>
  matchingCandidates.value.slice(0, 3).map((candidate) => ({
    candidate,
    mediaUrl: safeCandidateMediaUrl(candidate.relativePath),
    name: candidateName(candidate.relativePath),
  })),
);
const selectedEntry = computed(() => visibleCandidates.value.find(
  (entry) => entry.candidate.candidateUuid === selectedCandidateUuid.value,
) ?? null);
const hiddenCount = computed(() => Math.max(0, matchingCandidates.value.length - visibleCandidates.value.length));
const mediaLabel = computed(() => (props.mediaType === "image" ? "图片" : "视频"));

// 只展示项目相对路径的文件名，不在行组件内拼接或暴露本机绝对路径。
function candidateName(relativePath: string): string {
  if (!safeCandidateMediaUrl(relativePath)) return "候选结果";
  const parts = relativePath.split("/").filter(Boolean);
  return parts.at(-1) || "候选结果";
}

// 路径校验失败时保留候选身份，但绝不把不可信路径写入 DOM 的 src。
function safeCandidateMediaUrl(relativePath: string): string {
  if (!props.projectUuid) return "";
  try {
    return buildStoryboardMediaUrl(props.projectUuid, relativePath);
  } catch {
    return "";
  }
}

function pickDefaultCandidateUuid(): string {
  const adopted = matchingCandidates.value.find((candidate) => candidate.selected);
  if (adopted) return adopted.candidateUuid;
  return matchingCandidates.value[0]?.candidateUuid ?? "";
}

function stopPreviewVideo(): void {
  const video = previewVideoRef.value;
  if (video) {
    video.pause();
  }
  isPlaying.value = false;
}

function resetPreviewPlayer(): void {
  stopPreviewVideo();
  showNativeControls.value = false;
  videoLoadFailed.value = false;
  frameReady.value = false;
  previewGeneration.value += 1;
}

function seekPreviewFrame(event: Event): void {
  const video = event.currentTarget;
  if (!(video instanceof HTMLVideoElement) || videoLoadFailed.value) return;
  try {
    if (video.currentTime < 0.05) video.currentTime = 0.05;
  } catch {
    frameReady.value = true;
  }
}

function onPreviewSeeked(event: Event): void {
  const video = event.currentTarget;
  if (!(video instanceof HTMLVideoElement)) return;
  if (video === previewVideoRef.value) frameReady.value = true;
}

watch(
  () => [props.projectUuid, props.mediaType, props.candidates] as const,
  () => {
    const nextUuid = visibleCandidates.value.some((entry) => entry.candidate.candidateUuid === selectedCandidateUuid.value)
      ? selectedCandidateUuid.value
      : pickDefaultCandidateUuid();
    if (nextUuid !== selectedCandidateUuid.value) {
      resetPreviewPlayer();
      selectedCandidateUuid.value = nextUuid;
      return;
    }
    if (!selectedCandidateUuid.value) {
      selectedCandidateUuid.value = pickDefaultCandidateUuid();
    }
  },
  { deep: true, immediate: true },
);

watch(selectedCandidateUuid, () => {
  resetPreviewPlayer();
});

onBeforeUnmount(() => {
  stopPreviewVideo();
});

function previewCandidate(candidateUuid: string): void {
  if (props.readonly || props.busy) return;
  if (candidateUuid === selectedCandidateUuid.value) return;
  resetPreviewVideoAndSelect(candidateUuid);
}

function resetPreviewVideoAndSelect(candidateUuid: string): void {
  resetPreviewPlayer();
  selectedCandidateUuid.value = candidateUuid;
}

function onPreviewPlay(): void {
  isPlaying.value = true;
  showNativeControls.value = true;
}

function onPreviewPause(): void {
  isPlaying.value = false;
}

function onPreviewError(): void {
  stopPreviewVideo();
  videoLoadFailed.value = true;
}

async function togglePlayback(): Promise<void> {
  const video = previewVideoRef.value;
  if (!video || videoLoadFailed.value) return;
  // 中文注释：jsdom 的 play mock 不会改 paused，必须用组件状态决定下一次是播放还是暂停。
  if (isPlaying.value) {
    video.pause();
    isPlaying.value = false;
    return;
  }
  try {
    await video.play();
    isPlaying.value = true;
    showNativeControls.value = true;
  } catch {
    // 中文注释：自动播放策略拒绝不得变成未处理 Promise，只显示稳定中文错误。
    stopPreviewVideo();
    videoLoadFailed.value = true;
  }
}

function confirmSelection(): void {
  const entry = selectedEntry.value;
  if (!entry || props.readonly || props.busy || entry.candidate.selected) return;
  emit("select", entry.candidate.candidateUuid);
}
</script>

<style scoped lang="scss">
.shotCandidateStrip {
  min-width: 0;
}

.shotCandidateStrip__items {
  display: flex;
  gap: 7px;
  align-items: stretch;
  min-width: 0;
}

.shotCandidate {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto;
  gap: 7px;
  align-items: center;
  min-width: 0;
  flex: 1 1 0;
  padding: 7px;
  border: 1px solid var(--product-border);
  border-radius: 9px;
  color: var(--product-text-secondary);
  text-align: left;
  background: var(--product-surface-soft);
  cursor: pointer;
  transition:
    border-color 150ms ease,
    color 150ms ease,
    box-shadow 150ms ease;
}

.shotCandidate[data-selected="true"] {
  border-color: var(--td-success-color);
  color: var(--product-text);
}

.shotCandidate:hover:not(:disabled),
.shotCandidate:focus-visible {
  border-color: var(--td-brand-color);
  color: var(--product-text);
}

.shotCandidate:focus-visible {
  outline: none;
  box-shadow: var(--product-focus-ring);
}

.shotCandidate:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.shotCandidate__visual {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  color: var(--td-brand-color);
  background: color-mix(in srgb, var(--td-brand-color) 12%, transparent);
}

.shotCandidate__visual img,
.shotCandidate__visual video {
  width: 100%;
  height: 100%;
  border-radius: inherit;
  object-fit: cover;
}

.shotCandidate__copy {
  min-width: 0;
}

.shotCandidate__copy strong,
.shotCandidate__copy small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.shotCandidate__copy strong {
  font-size: 10px;
}

.shotCandidate__copy small {
  margin-top: 2px;
  color: var(--product-text-muted);
  font-size: 9px;
}

.shotCandidate__selected {
  color: var(--td-success-color);
}

.shotCandidateStrip__more,
.shotCandidateStrip__empty {
  display: grid;
  place-items: center;
  min-height: 44px;
  border: 1px dashed var(--product-border);
  border-radius: 9px;
  color: var(--product-text-muted);
  font-size: 10px;
  background: var(--product-surface-soft);
}

.shotCandidatePreview {
  display: grid;
  gap: 8px;
  margin-top: 8px;
  padding: 8px;
  border: 1px solid var(--product-border-strong);
  border-radius: 10px;
  background: var(--product-surface);
}

.shotCandidatePreview__media {
  display: grid;
  place-items: center;
  overflow: hidden;
  min-height: 96px;
  border-radius: 8px;
  color: var(--product-text-muted);
  background: var(--product-surface-soft);
}

.shotCandidatePreview__media img,
.shotCandidatePreview__media video {
  width: 100%;
  max-height: 180px;
  object-fit: contain;
}

.shotCandidatePreview__videoShell {
  position: relative;
  display: grid;
  place-items: center;
  width: 100%;
  min-height: 120px;
}

.shotCandidatePreview__play {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 1;
  min-width: 56px;
  min-height: 56px;
  padding: 0 12px;
  border: 0;
  border-radius: 999px;
  color: #fff;
  background: rgb(0 0 0 / 62%);
  transform: translate(-50%, -50%);
  cursor: pointer;
}

.shotCandidatePreview__error {
  margin: 0;
  padding: 24px 12px;
  color: var(--product-text-muted);
  font-size: 12px;
}

.shotCandidatePreview__footer {
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
}

.shotCandidatePreview__footer small,
.shotCandidatePreview__footer strong {
  display: block;
}

.shotCandidatePreview__footer small {
  color: var(--product-text-muted);
  font-size: 9px;
}

.shotCandidatePreview__footer button {
  min-height: 30px;
  padding: 0 10px;
  color: var(--td-text-color-anti);
  background: var(--td-brand-color);
  border: 1px solid var(--td-brand-color);
  border-radius: 8px;
}

.shotCandidatePreview__footer button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.shotCandidateStrip__more {
  flex: 0 0 32px;
}

.shotCandidateStrip__empty {
  grid-template-columns: auto auto;
  justify-content: center;
  gap: 6px;
}
</style>
