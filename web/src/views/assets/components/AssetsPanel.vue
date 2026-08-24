<template>
  <div class="data">
    <t-tabs v-model="page.assetOptions.value" @change="page.selectAssetOptions">
      <t-tab-panel v-for="(item, index) in page.themeData.value" :key="index" :value="item.value">
        <template #label>
          <div class="tabLabel">
            <component :is="item.icon" theme="outline" size="20" />
            <span>{{ item.name }}</span>
          </div>
        </template>
        <div class="panelContent">
          <div class="toolbar">
            <t-space>
              <t-button theme="primary" @click="page.handleAdd(item.value)">
                <template #icon><t-icon name="add" /></template>
                {{ $t("workbench.assets.addPrefix") }}{{ item.name }}
              </t-button>
              <t-popup placement="bottom">
                <t-button v-if="page.assetOptions.value !== 'clip' && page.assetOptions.value !== 'audio'" theme="primary">
                  <template #icon><t-icon name="indent-left" /></template>
                  {{ $t("workbench.assets.batchGenerate") }}
                </t-button>
                <template #content>
                  <div class="data">
                    <div class="generatePrompt" @click="page.batchGeneration(1)">{{ $t("workbench.assets.generatePrompt") }}</div>
                    <div class="generateImage" @click="page.batchGeneration(2)">{{ $t("workbench.assets.generateImage") }}</div>
                  </div>
                </template>
              </t-popup>
              <t-button theme="default" variant="outline" @click="page.handleBatchDelete">
                <template #icon><t-icon name="delete" /></template>
                {{ $t("workbench.assets.batchDelete") }}
              </t-button>
            </t-space>
            <div class="f ac">
              <t-input v-model="page.searchText.value" :placeholder="$t('workbench.assets.searchPlaceholder')" clearable style="width: 260px" />
              <t-button style="margin-left: 5px" @click="page.handleSearch">
                <template #icon><t-icon name="search" /></template>
                {{ $t("workbench.assets.search") }}
              </t-button>
            </div>
          </div>
          <div class="assetsList f w">
            <AssetsStandardTable v-if="['role', 'tool', 'scene'].includes(page.assetOptions.value)" />
            <AssetsClipTable v-else-if="page.assetOptions.value === 'clip'" />
            <AssetsAudioTable v-else />
          </div>
        </div>
      </t-tab-panel>
    </t-tabs>
  </div>
</template>

<script setup lang="ts">
import { inject } from "vue";
import AssetsAudioTable from "./AssetsAudioTable.vue";
import AssetsClipTable from "./AssetsClipTable.vue";
import AssetsStandardTable from "./AssetsStandardTable.vue";
import { assetsContextKey } from "../composables/assetsContext";

const page = inject(assetsContextKey)!;
</script>

<style lang="scss" scoped>
@use "../styles/assets-page.scss";
</style>
