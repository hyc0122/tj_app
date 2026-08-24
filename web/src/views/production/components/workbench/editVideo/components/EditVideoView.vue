<template>
  <div class="editVideo">
    <splitpanes class="default-theme content" horizontal :push-other-panes="false">
      <pane size="60">
        <splitpanes :push-other-panes="false">
          <pane size="20" min-size="10">
            <mediaLibrary
              :initial-video-items="initialVideoItems"
              :initial-media-items="initialMediaItems"
              :initial-audio-items="initialAudioItems"
              :initial-image-items="initialImageItems" />
          </pane>
          <pane size="60" min-size="20">
            <div ref="previewWrapperRef" class="previewWrapper">
              <videoPreview ref="videoPreviewRef" :canvas-width="canvasWidth" :canvas-height="canvasHeight" :style="previewStyle" />
            </div>
          </pane>
          <pane size="20" min-size="10">
            <propertyPanel />
          </pane>
        </splitpanes>
      </pane>
      <pane size="40" class="pr">
        <VideoTrack
          class="videoTrack"
          ref="videoTrackRef"
          :operation-buttons="operationButtons"
          :scale-config-buttons="scaleConfigButtons"
          :track-types="trackTypes"
          :clip-configs="clipConfigs"
          :enable-main-track-mode="true"
          :enable-cross-track-drag="true"
          :enable-snap="true"
          :default-scale="1"
          @add-transition="handleAddTransitionFromClick"
          @drop-media="handleDropMedia"
          @transition-added="onTransitionAdded">
          <!-- 自定义操作按钮 -->
          <template #custom-operation-reset>
            <t-button variant="text" size="small" @click="videoTrackRef?.reset()" :title="$t('workbench.production.editVideo.reset')">
              <template #icon><i-refresh size="16" /></template>
              {{ $t("workbench.production.editVideo.reset") }}
            </t-button>
          </template>

          <template #custom-operation-undo>
            <t-button
              variant="text"
              size="small"
              :disabled="!historyStore.canUndo"
              @click="historyStore.undo()"
              :title="$t('workbench.production.editVideo.undo')">
              <template #icon><i-undo size="16" /></template>
              {{ $t("workbench.production.editVideo.undo") }}
            </t-button>
          </template>

          <template #custom-operation-redo>
            <t-button
              variant="text"
              size="small"
              :disabled="!historyStore.canRedo"
              @click="historyStore.redo()"
              :title="$t('workbench.production.editVideo.redo')">
              <template #icon><i-redo size="16" /></template>
              {{ $t("workbench.production.editVideo.redo") }}
            </t-button>
          </template>

          <template #custom-operation-split>
            <t-button
              variant="text"
              size="small"
              :disabled="tracksStore.selectedClipIds.size === 0"
              @click="handleSplit"
              :title="$t('workbench.production.editVideo.split')">
              <template #icon><i-cutting-one size="16" /></template>
              {{ $t("workbench.production.editVideo.split") }}
            </t-button>
          </template>

          <template #custom-operation-delete>
            <t-button variant="text" size="small" @click="handleDeleteClips" :title="$t('workbench.production.editVideo.delete')">
              <template #icon><i-delete size="16" /></template>
              {{ $t("workbench.production.editVideo.delete") }}
            </t-button>
          </template>
          <!-- <template #custom-operation-import>
            <t-button variant="text" size="small" @click="handleImport" :title="$t('workbench.production.editVideo.importProject')">
              <template #icon><i-folder-open size="16" /></template>
              {{ $t("workbench.production.editVideo.import") }}
            </t-button>
          </template> -->
          <template #scale-append>
            <t-button theme="danger" @click="handleExport" :loading="isExporting" :title="$t('workbench.production.editVideo.exportProject')">
              <template #icon><i-export size="16" style="margin-right: 4px" /></template>
              {{ isExporting ? $t("workbench.production.editVideo.rendering") : $t("workbench.production.editVideo.exportVideo") }}
            </t-button>
          </template>
        </VideoTrack>
      </pane>
    </splitpanes>
  </div>
</template>

<script setup lang="ts">
import { inject } from "vue";
import { Splitpanes, Pane } from "splitpanes";
import { VideoTrack } from "vue-clip-track";
import "vue-clip-track/style.css";
import mediaLibrary from "../mediaLibrary.vue";
import videoPreview from "../videoPreview.vue";
import propertyPanel from "../propertyPanel.vue";
import { editVideoContextKey } from "../editVideoContext";

const context = inject(editVideoContextKey);
if (!context) throw new Error();

const {
  initialVideoItems, initialMediaItems, initialAudioItems, initialImageItems,
  canvasWidth, canvasHeight, tracksStore, historyStore, previewWrapperRef,
  videoTrackRef, videoPreviewRef, previewStyle, isExporting, operationButtons,
  scaleConfigButtons, trackTypes, clipConfigs, handleExport, handleSplit,
  handleDeleteClips, handleDropMedia, handleAddTransitionFromClick, onTransitionAdded,
} = context;
</script>

<style scoped lang="scss" src="../styles/edit-video.scss"></style>
