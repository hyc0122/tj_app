<template>
  <addAssets
    v-model="page.addAssetsShow.value"
    :type="page.assetOptions.value"
    :title="page.tabNameMap[page.assetOptions.value]"
    :formData="page.formData.value"
    @getFilteredData="page.getFilteredData(page.assetOptions.value)" />
  <generateImage
    v-model="page.generateImageShow.value"
    :formData="page.currentAssetData.value"
    @update="page.loadCurrentTabData" />
  <addAudioAssets
    v-if="page.addAudioShow.value"
    v-model="page.addAudioShow.value"
    :formData="page.audioFormData.value"
    @getFilteredData="page.getFilteredData(page.assetOptions.value)" />
  <t-dialog
    v-model:visible="page.mediaPreviewShow.value"
    :header="page.mediaPreviewName.value || $t('workbench.assets.mediaPreview')"
    :footer="false"
    width="600px"
    placement="center"
    destroyOnClose
    @close="page.closeMediaPreview">
    <div class="mediaPreviewDialog">
      <video
        v-if="page.mediaPreviewType.value === 'video'"
        :src="page.mediaPreviewSrc.value"
        controls
        autoplay
        class="mediaPlayer videoPlayer" />
      <div v-else-if="page.mediaPreviewType.value === 'audio'" class="audioWrapper">
        <div class="audioIcon"><t-icon name="music" size="64px" /></div>
        <p class="audioName">{{ page.mediaPreviewName.value }}</p>
        <audio :src="page.mediaPreviewSrc.value" controls autoplay class="mediaPlayer audioPlayer" />
      </div>
    </div>
  </t-dialog>
  <t-dialog
    v-model:visible="page.batchGenerationShow.value"
    :header="page.batchType.value"
    width="600px"
    top="10vh"
    placement="center"
    destroyOnClose
    @confirm="page.keep"
    @close="page.batchGenerationShow.value = false">
    <div class="batch">
      <span>{{ $t("workbench.assets.confirmBatch", { type: page.batchType.value }) }}</span>
      <t-form labelAlign="top">
        <t-form-item
          v-if="page.batchType.value === $t('workbench.assets.batchGenImage')"
          :label="$t('workbench.assets.model')"
          name="selectValue">
          <modelSelect v-model="page.selectValue.value" type="image" />
        </t-form-item>
        <t-form-item
          v-if="page.batchType.value === $t('workbench.assets.batchGenImage')"
          :label="$t('workbench.assets.resolution')"
          name="resolution">
          <t-select v-model="page.resolution.value" :placeholder="$t('workbench.assets.resolutionPh')">
            <t-option v-for="value in ['1K', '2K', '4K']" :key="value" :label="value" :value="value" />
          </t-select>
        </t-form-item>
      </t-form>
    </div>
  </t-dialog>
</template>

<script setup lang="ts">
import { inject } from "vue";
import modelSelect from "@/components/modelSelect.vue";
import addAssets from "./addAssets.vue";
import addAudioAssets from "./addAudioAssets.vue";
import generateImage from "./generateImage.vue";
import { assetsContextKey } from "../composables/assetsContext";

const page = inject(assetsContextKey)!;
</script>

<style lang="scss">
@use "../styles/assets-dialogs.scss";
</style>
