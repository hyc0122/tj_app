<template>
  <div class="mediaLibrary">
    <div class="mediaLibraryHeader">
      <div class="headerTitle jb ac">
        <h3 class="mediaLibraryTitle">{{ $t("workbench.production.editVideo.clipMaterials") }}</h3>
        <span style="font-size: 12px">视频素材名字按照分镜台组#号数字命名</span>
      </div>
      <div class="mediaLibraryTabs">
        <t-button
          v-for="tab in tabs"
          :key="tab.id"
          :theme="activeTab === tab.id ? 'primary' : 'default'"
          :variant="activeTab === tab.id ? 'base' : 'text'"
          size="small"
          @click="activeTab = tab.id">
          <template #icon>
            <component :is="tab.icon" theme="outline" size="18" style="margin-right: 4px" />
          </template>
          {{ tab.label }}
        </t-button>
      </div>
    </div>

    <div class="mediaLibraryContent">
      <!-- 分镜视频 -->
      <div v-if="activeTab === 'video'" class="mediaList">
        <div
          v-for="item in videoItems"
          :key="item.id"
          class="mediaItem"
          draggable="true"
          @dragstart="handleDragStart($event, item)"
          @dragend="handleDragEnd">
          <div class="mediaItemPreview">
            <t-image v-if="item.thumbnail" :src="item.thumbnail" fit="cover" class="mediaItemThumbnail" />
            <component v-else :is="item.icon" theme="outline" size="18" />
            <div v-if="item.loading" class="mediaItemLoading">
              <t-loading size="small" />
            </div>
          </div>
          <div class="mediaItemInfo">
            <div class="selected" v-if="item.selected">
              <i-check-one theme="filled" size="16" fill="#000000" />
            </div>
            <div class="mediaItemName">
              <t-popup :content="item.name">
                {{ item.name }}
              </t-popup>
            </div>
            <t-tag v-if="item.duration" size="small" theme="default" variant="light">{{ formatDuration(item.duration) }}</t-tag>
          </div>
        </div>
      </div>
      <!-- 媒体素材 -->
      <div v-if="activeTab === 'media'" class="mediaList">
        <div
          v-for="item in mediaItems"
          :key="item.id"
          class="mediaItem"
          draggable="true"
          @dragstart="handleDragStart($event, item)"
          @dragend="handleDragEnd">
          <div class="mediaItemPreview">
            <t-image v-if="item.thumbnail" :src="item.thumbnail" fit="cover" class="mediaItemThumbnail" />
            <component v-else :is="item.icon" theme="outline" size="18" />
            <div v-if="item.loading" class="mediaItemLoading">
              <t-loading size="small" />
            </div>
          </div>
          <div class="mediaItemInfo">
            <div class="mediaItemName">
              <t-popup :content="item.name">
                {{ item.name }}
              </t-popup>
            </div>
            <t-tag v-if="item.duration" size="small" theme="default" variant="light">{{ formatDuration(item.duration) }}</t-tag>
          </div>
        </div>
      </div>

      <!-- 图片素材 -->
      <div v-if="activeTab === 'image'" class="mediaList">
        <div
          v-for="item in imageItems"
          :key="item.id"
          class="mediaItem"
          draggable="true"
          @dragstart="handleDragStart($event, item)"
          @dragend="handleDragEnd">
          <div class="mediaItemPreview">
            <t-image v-if="item.thumbnail" :src="item.thumbnail" fit="cover" class="mediaItemThumbnail" />
            <component v-else :is="item.icon" theme="outline" size="18" />
            <div v-if="item.loading" class="mediaItemLoading">
              <t-loading size="small" />
            </div>
          </div>
          <div class="mediaItemInfo">
            <div class="mediaItemName">
              <t-popup :content="item.name">
                {{ item.name }}
              </t-popup>
            </div>
          </div>
        </div>
      </div>

      <!-- 转场效果 -->
      <div v-if="activeTab === 'transition'" class="transitionList">
        <div
          v-for="transition in transitionItems"
          :key="transition.id"
          class="transitionItem"
          draggable="true"
          @dragstart="handleDragStart($event, transition)"
          @dragend="handleDragEnd">
          <div class="transitionItemPreview">
            <span class="transitionItemIcon"><component :is="transition.icon" theme="outline" size="18" /></span>
          </div>
          <div class="transitionItemName">
            <t-popup :content="transition.name">
              {{ transition.name }}
            </t-popup>
          </div>
        </div>
      </div>

      <!-- 特效 -->
      <div v-if="activeTab === 'effect'" class="effectList">
        <div
          v-for="effect in effectItems"
          :key="effect.id"
          class="effectItem"
          draggable="true"
          @dragstart="handleDragStart($event, effect)"
          @dragend="handleDragEnd">
          <div class="effectItemPreview">
            <component :is="effect.icon" theme="outline" size="18" />
          </div>
          <div class="effectItemName">
            <t-popup :content="effect.name">
              {{ effect.name }}
            </t-popup>
          </div>
        </div>
      </div>

      <!-- 滤镜 -->
      <div v-if="activeTab === 'filter'" class="filterList">
        <div
          v-for="filter in filterItems"
          :key="filter.id"
          class="filterItem"
          draggable="true"
          @dragstart="handleDragStart($event, filter)"
          @dragend="handleDragEnd">
          <div class="filterItemPreview">
            <component :is="filter.icon" theme="outline" size="18" />
          </div>
          <div class="filterItemName">
            <t-popup :content="filter.name">
              {{ filter.name }}
            </t-popup>
          </div>
        </div>
      </div>

      <!-- 音频 -->
      <div v-if="activeTab === 'audio'" class="audioList">
        <div
          v-for="audio in audioItems"
          :key="audio.id"
          class="audioItem"
          draggable="true"
          @dragstart="handleDragStart($event, audio)"
          @dragend="handleDragEnd">
          <div class="audioItemPreview">
            <i-music theme="outline" size="18" />
            <div v-if="audio.loading" class="mediaItemLoading">
              <t-loading size="small" />
            </div>
          </div>
          <div class="audioItemInfo">
            <div class="audioItemName">
              <t-popup :content="audio.name">
                {{ audio.name }}
              </t-popup>
            </div>
            <t-tag v-if="audio.duration" size="small" theme="default" variant="light">{{ formatDuration(audio.duration) }}</t-tag>
          </div>
        </div>
      </div>

      <!-- 字幕/文本 -->
      <div v-if="activeTab === 'text'" class="textList">
        <div
          v-for="text in textItems"
          :key="text.id"
          class="textItem"
          draggable="true"
          @dragstart="handleDragStart($event, text)"
          @dragend="handleDragEnd">
          <div class="textItemPreview">
            <span class="textItemContent">{{ text.preview }}</span>
          </div>
          <div class="textItemName">
            <t-popup :content="text.name">
              {{ text.name }}
            </t-popup>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { inject } from "vue";
import { mediaLibraryContextKey } from "../mediaLibraryContext";

const context = inject(mediaLibraryContextKey);
if (!context) throw new Error();

const {
  activeTab, tabs, videoItems, mediaItems, audioItems, imageItems, textItems,
  transitionItems, effectItems, filterItems, formatDuration,
  handleDragStart, handleDragEnd,
} = context;
</script>

<style scoped lang="scss" src="../styles/media-library-layout.scss"></style>
<style scoped lang="scss" src="../styles/media-library-items.scss"></style>
