<template>
  <div class="propertyPanel">
    <div class="panelHeader">
      <h3 class="panelTitle">{{ $t("workbench.production.editVideo.propertyPanel") }}</h3>
    </div>

    <div class="panelContent">
      <div v-if="!selectedClip" class="emptyState">
        <div class="emptyIconWrapper">
          <i-inbox theme="outline" size="32" fill="var(--td-text-color-placeholder)" />
        </div>
        <div class="emptyText">{{ $t("workbench.production.editVideo.selectClip") }}</div>
      </div>

      <div v-else class="properties">
        <!-- 基础信息 -->
        <div class="sectionCard">
          <div class="sectionHeader">
            <div class="sectionIconBadge">
              <component :is="getClipIcon(selectedClip)" theme="outline" size="16" />
            </div>
            <span class="sectionLabel">{{ $t("workbench.production.editVideo.basicInfo") }}</span>
            <t-tag size="small" theme="primary" variant="light">{{ getClipTypeName(selectedClip.type) }}</t-tag>
          </div>
          <div class="sectionBody">
            <div class="propRow">
              <label class="propLabel">{{ $t("workbench.production.editVideo.name") }}</label>
              <t-input
                v-model="clipName"
                size="small"
                :placeholder="$t('workbench.production.editVideo.clipNamePlaceholder')"
                @change="handleUpdateClip('name', clipName)" />
            </div>
            <div class="propRowInline">
              <div class="propField">
                <label class="propLabel">{{ $t("workbench.production.editVideo.startTime") }}</label>
                <t-input-number
                  :value="Number(selectedClip.startTime.toFixed(2))"
                  size="small"
                  :decimal-places="2"
                  :step="0.01"
                  theme="normal"
                  suffix="s"
                  @change="(val: any) => handleUpdateClip('startTime', Number(val))" />
              </div>
              <div class="propField">
                <label class="propLabel">{{ $t("workbench.production.editVideo.endTime") }}</label>
                <t-input-number
                  :value="Number(selectedClip.endTime.toFixed(2))"
                  size="small"
                  :decimal-places="2"
                  :step="0.01"
                  theme="normal"
                  suffix="s"
                  @change="(val: any) => handleUpdateClip('endTime', Number(val))" />
              </div>
            </div>
            <div class="propRowInline durationRow">
              <span class="durationLabel">{{ $t("workbench.production.editVideo.totalDuration") }}</span>
              <t-tag size="small" theme="default" variant="outline">{{ (selectedClip.endTime - selectedClip.startTime).toFixed(2) }}s</t-tag>
            </div>
          </div>
        </div>

        <!-- 视频属性 -->
        <div v-if="selectedClip.type === 'video'" class="sectionCard">
          <div class="sectionHeader">
            <div class="sectionIconBadge">
              <i-video theme="outline" size="16" />
            </div>
            <span class="sectionLabel">{{ $t("workbench.production.editVideo.videoProperties") }}</span>
          </div>
          <div class="sectionBody">
            <div class="propRow">
              <div class="propRowHead">
                <label class="propLabel">{{ $t("workbench.production.editVideo.opacity") }}</label>
                <span class="propValueText">{{ Math.round(videoOpacity) }}%</span>
              </div>
              <t-slider v-model="videoOpacity" :min="0" :max="100" :step="1" @change="handleUpdateClip('opacity', Math.round(videoOpacity) / 100)" />
            </div>
            <div class="propRow">
              <div class="propRowHead">
                <label class="propLabel">{{ $t("workbench.production.editVideo.volume") }}</label>
                <span class="propValueText">{{ Math.round(videoVolume) }}%</span>
              </div>
              <t-slider v-model="videoVolume" :min="0" :max="200" :step="1" @change="handleUpdateClip('volume', Math.round(videoVolume) / 100)" />
            </div>
            <div class="propRow">
              <label class="propLabel">{{ $t("workbench.production.editVideo.playbackSpeed") }}</label>
              <t-input-number
                v-model="videoSpeed"
                size="small"
                :min="0.1"
                :max="10"
                :step="0.1"
                :decimal-places="1"
                suffix="x"
                @change="(val: any) => handleUpdatePlaybackRate(Number(val))" />
            </div>
          </div>
        </div>

        <!-- 音频属性 -->
        <div v-if="selectedClip.type === 'audio'" class="sectionCard">
          <div class="sectionHeader">
            <div class="sectionIconBadge">
              <i-music theme="outline" size="16" />
            </div>
            <span class="sectionLabel">{{ $t("workbench.production.editVideo.audioProperties") }}</span>
          </div>
          <div class="sectionBody">
            <div class="propRow">
              <div class="propRowHead">
                <label class="propLabel">{{ $t("workbench.production.editVideo.volume") }}</label>
                <span class="propValueText">{{ Math.round(audioVolume) }}%</span>
              </div>
              <t-slider v-model="audioVolume" :min="0" :max="200" :step="1" @change="handleUpdateClip('volume', Math.round(audioVolume) / 100)" />
            </div>
            <div class="propRowInline">
              <div class="propField">
                <label class="propLabel">{{ $t("workbench.production.editVideo.fadeIn") }}</label>
                <t-input-number
                  v-model="audioFadeIn"
                  size="small"
                  :min="0"
                  :step="0.1"
                  :decimal-places="1"
                  theme="normal"
                  suffix="s"
                  @change="handleUpdateClip('fadeIn', audioFadeIn)" />
              </div>
              <div class="propField">
                <label class="propLabel">{{ $t("workbench.production.editVideo.fadeOut") }}</label>
                <t-input-number
                  v-model="audioFadeOut"
                  size="small"
                  :min="0"
                  :step="0.1"
                  :decimal-places="1"
                  theme="normal"
                  suffix="s"
                  @change="handleUpdateClip('fadeOut', audioFadeOut)" />
              </div>
            </div>
          </div>
        </div>

        <!-- 转场属性 -->
        <div v-if="selectedClip.type === 'transition'" class="sectionCard">
          <div class="sectionHeader">
            <div class="sectionIconBadge">
              <i-exchange theme="outline" size="16" />
            </div>
            <span class="sectionLabel">{{ $t("workbench.production.editVideo.transitionProperties") }}</span>
          </div>
          <div class="sectionBody">
            <div class="propRow">
              <label class="propLabel">{{ $t("workbench.production.editVideo.transitionType") }}</label>
              <t-select v-model="transitionType" size="small" @change="handleUpdateClip('transitionType', transitionType)">
                <t-option value="fade" :label="$t('workbench.production.editVideo.transFade')" />
                <t-option value="slide" :label="$t('workbench.production.editVideo.transSlide')" />
                <t-option value="wipe" :label="$t('workbench.production.editVideo.transWipe')" />
                <t-option value="dissolve" :label="$t('workbench.production.editVideo.transDissolve')" />
                <t-option value="zoom" :label="$t('workbench.production.editVideo.transZoom')" />
                <t-option value="rotate" :label="$t('workbench.production.editVideo.transRotate')" />
              </t-select>
            </div>
            <div class="propRow">
              <label class="propLabel">{{ $t("workbench.production.editVideo.transitionDuration") }}</label>
              <t-input-number
                v-model="transitionDuration"
                size="small"
                :min="0.1"
                :max="5"
                :step="0.1"
                :decimal-places="1"
                theme="normal"
                suffix="s"
                @change="handleUpdateTransitionDuration" />
            </div>
          </div>
        </div>

        <!-- 字幕属性 -->
        <div v-if="selectedClip.type === 'subtitle'" class="sectionCard">
          <div class="sectionHeader">
            <div class="sectionIconBadge">
              <i-editor theme="outline" size="16" />
            </div>
            <span class="sectionLabel">{{ $t("workbench.production.editVideo.subtitleProperties") }}</span>
          </div>
          <div class="sectionBody">
            <div class="propRow">
              <label class="propLabel">{{ $t("workbench.production.editVideo.textContent") }}</label>
              <t-textarea v-model="subtitleText" :autosize="{ minRows: 3, maxRows: 6 }" @change="handleUpdateClip('text', subtitleText)" />
            </div>
            <div class="propRow">
              <label class="propLabel">{{ $t("workbench.production.editVideo.fontSize") }}</label>
              <t-input-number
                v-model="subtitleFontSize"
                size="small"
                :min="12"
                :max="72"
                theme="normal"
                suffix="px"
                @change="handleUpdateClip('fontSize', subtitleFontSize)" />
            </div>
          </div>
        </div>

        <!-- 操作按钮 -->
        <div class="actions">
          <t-button theme="default" variant="outline" block @click="handleDuplicateClip">
            <template #icon><i-copy theme="outline" size="16" /></template>
            {{ $t("workbench.production.editVideo.copy") }}
          </t-button>
          <t-button theme="danger" variant="text" block @click="handleDeleteClip">
            <template #icon><i-delete theme="outline" size="16" /></template>
            {{ $t("workbench.production.editVideo.delete") }}
          </t-button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { inject } from "vue";
import { propertyPanelContextKey } from "../propertyPanelContext";

const context = inject(propertyPanelContextKey);
if (!context) throw new Error();

const {
  selectedClip, clipName, videoOpacity, videoVolume, videoSpeed, audioVolume,
  audioFadeIn, audioFadeOut, transitionType, transitionDuration, subtitleText,
  subtitleFontSize, getClipIcon, getClipTypeName, handleUpdateClip,
  handleUpdatePlaybackRate, handleUpdateTransitionDuration, handleDeleteClip,
  handleDuplicateClip,
} = context;
</script>

<style scoped lang="scss" src="../styles/property-panel.scss"></style>
