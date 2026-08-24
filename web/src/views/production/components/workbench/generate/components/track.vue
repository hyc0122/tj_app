<template>
  <div class="videoTrack">
    <t-card bordered :style="{ height: '100%' }">
      <div class="trackMenu f ac jb">
        <div class="left f ac">
          <t-checkbox v-model="checkAll" @change="handleCheckAll">{{ $t("workbench.generate.selectAll") }}</t-checkbox>
          <span class="selectedCount" v-if="checkedTrackIds.length">{{ $t("workbench.generate.selected") }} {{ checkedTrackIds.length }} 段</span>
        </div>
        <div class="right f ac">
          <t-button size="small" variant="outline" @click="batchDownloadVideo">{{ $t("workbench.generate.batchDownloadVideo") }}</t-button>
          <t-button size="small" variant="outline" @click="batchGenText" :loading="generateTextLoad">
            {{ $t("workbench.generate.batchGenerateText") }}
          </t-button>
          <t-button size="small" variant="outline" @click="batchGenVideo" :loading="generateVideoLoad">
            {{ $t("workbench.generate.batchGenerateVideo") }}
          </t-button>
        </div>
      </div>
      <div class="itemBox">
        <div
          class="item"
          :class="{ active: index === activeTrackIndex }"
          v-for="(track, index) in trackList"
          :key="track.id"
          @click="changeIndex(index)">
          <t-checkbox
            class="trackCheck"
            :checked="track.id != null && checkedTrackIds.includes(track.id)"
            @click.stop
            @change="(val: boolean) => toggleCheck(track.id, val)" />
          <t-tag class="indexTag" size="small">#{{ index + 1 }}</t-tag>
          <t-tag class="selectTag" theme="success" size="small" v-if="track.selectVideoId">已选择</t-tag>
          <div class="thumbGroup" v-if="track.selectVideoId && getSelectedVideoSrc(track)">
            <img
              v-if="videoCoverMap[getSelectedVideoSrc(track)!]"
              class="thumb selectedVideoThumb"
              :src="videoCoverMap[getSelectedVideoSrc(track)!]"
              draggable="false" />
            <div v-else class="thumb placeholder c"><i-video size="24" /></div>
          </div>
          <div class="thumbGroup" v-else-if="track.medias.some((media) => media.src)">
            <template v-for="(media, mediaIndex) in track.medias" :key="mediaIndex">
              <template v-if="media.src">
                <t-image fit="cover" v-if="media.fileType === 'image'" :src="media.src" class="thumb" />
                <div v-else class="thumb placeholder c">
                  <i-volume-notice v-if="media.fileType === 'audio'" size="20" />
                  <i-video v-else size="24" />
                </div>
              </template>
            </template>
          </div>
          <span v-else class="emptyTrack">{{ $t("workbench.generate.emptyTrack", { index: index + 1 }) }}</span>
          <div class="deleteBtn" @click.stop="confirmDeleteTrack(index)"><i-close size="14" /></div>
        </div>
        <div class="item addItem c" @click="addTrack"><i-plus size="36" /></div>
      </div>
    </t-card>
  </div>
</template>

<script setup lang="ts">
import "@/views/production/components/workbench/type/type";
import {
  useTrackSelection,
  type TrackComponentProps,
  type TrackEmit,
} from "./composables/useTrackSelection";
import { useTrackBatchActions } from "./composables/useTrackBatchActions";

const props = defineProps<TrackComponentProps>();
const activeTrackIndex = defineModel<number>("activeTrackIndex", { default: 0 });
const trackList = defineModel<TrackItem[]>({ default: () => [] });
const emit = defineEmits<TrackEmit>();

const selection = useTrackSelection(activeTrackIndex, trackList, emit);
const {
  checkedTrackIds,
  checkAll,
  videoCoverMap,
  getSelectedVideoSrc,
  changeIndex,
  confirmDeleteTrack,
  handleCheckAll,
  toggleCheck,
} = selection;
const {
  generateTextLoad,
  generateVideoLoad,
  addTrack,
  batchDownloadVideo,
  batchGenText,
  batchGenVideo,
} = useTrackBatchActions(props, activeTrackIndex, trackList, checkedTrackIds, checkAll, emit);
</script>

<style lang="scss" scoped>
@use "./styles/track.scss";
</style>
