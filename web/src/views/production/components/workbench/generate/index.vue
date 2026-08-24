<template>
  <div class="index fc" data-video-workspace style="overflow: visible">
    <div class="referenceImage" data-workspace-reference>
      <div class="uploadBtn">
        <imageSelect :mode="modelParmas.mode as VideoMode" v-model="imageList" :storyboard-list="storyboardList" />
      </div>
    </div>
    <div class="modelSelect" data-workspace-model>
      <p v-if="modelStatus" class="modelStatus" data-workspace-status role="status">{{ modelStatus }}</p>
      <p data-workspace-model-name>{{ modeOptions.name }}</p>
      <input
        data-video-model-input
        type="text"
        :value="modelParmas.model"
        aria-label="视频模型"
        style="position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0)"
        @change="selectVideoModel(($event.target as HTMLInputElement).value)"
        @input="selectVideoModel(($event.target as HTMLInputElement).value)"
      />
      <modeMenu v-model="modelParmas" :modeOptions="modeOptions" :trackId="currentTrack?.id" :modeList="modeList" @modeChange="modeChange" />
    </div>
    <div class="generate ac">
      <div class="prompt" data-workspace-prompt>
        <t-card v-if="currentTrack" :title="'#' + (activeTrackIndex + 1) + $t('workbench.generate.generateText')" header-bordered class="videoPrompt">
          <template #actions>
            <t-button size="small" class="genTextbtn" :loading="currentTrack.state == '生成中'" @click="genText">
              {{ $t("workbench.generate.generateText") }}
            </t-button>
          </template>
          <div class="promptData fc">
            <div class="promptInput" data-local-scroll @focusout="handlePromptBlur">
              <promptEditor v-model="currentTrack.prompt" :references="references" :placeholder="$t('workbench.generate.promptPlaceholder')" />
            </div>
          </div>
        </t-card>
      </div>
      <div class="video" data-workspace-history>
        <videoCard
          v-if="currentTrack"
          :active-track-index="activeTrackIndex"
          v-model:current-track="currentTrack"
          @refresh="getGenerateData"
          @generate="generateVideo" />
      </div>
    </div>
    <div class="track">
      <newTrack
        v-model:activeTrackIndex="activeTrackIndex"
        v-model="trackList"
        :image-list="imageList"
        @change="trackChange"
        :modelParmas="modelParmas"
        :clampDuration="clampDuration"
        @getData="getGenerateData" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { inject, type Ref } from "vue";
import newTrack from "./components/track.vue";
import imageSelect from "./components/imageSelect.vue";
import modeMenu from "./components/modeMenu.vue";
import videoCard from "./components/video.vue";
import promptEditor from "@/components/promptEditor.vue";
import "@/views/production/components/workbench/type/type";
import { useGenerateWorkbench } from "./composables/useGenerateWorkbench";

const episodesId = inject<Ref<number>>("episodesId")!;
const {
  activeTrackIndex,
  modeOptions,
  trackList,
  modelParmas,
  modelStatus,
  storyboardList,
  currentTrack,
  imageList,
  modeList,
  references,
  modeChange,
  clampDuration,
  getGenerateData,
  handlePromptBlur,
  trackChange,
  genText,
  generateVideo,
} = useGenerateWorkbench(episodesId);

function selectVideoModel(modelId: string) {
  modelParmas.value.model = modelId;
}

defineExpose({
  selectVideoModel,
  modelParmas,
  modeOptions,
  modelStatus,
});
</script>

<style lang="scss" scoped>
@use "./styles/generate-page.scss";
</style>
