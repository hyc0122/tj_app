<template>
  <div class="previewCell">
    <div v-if="loading" class="imageTrigger generatingImage">
      <t-loading size="small" />
      <span class="generatingLabel">{{ $t("workbench.assets.generating") }}</span>
    </div>
    <t-image-viewer v-else :images="[row.src ?? '']" :closeOnEscKeydown="true" :closeOnOverlay="true">
      <template #trigger="{ open }">
        <div class="imageTrigger" @click="row.src && page.getBigImageUrl(row, open)">
          <img v-if="row.src" :src="row.src" :alt="row.name" class="previewImage" />
          <div v-else class="noImage">
            <t-icon name="image" size="24px" />
          </div>
          <div v-if="row.src" class="imageHoverOverlay">
            <t-icon name="browse" size="20px" />
            <span class="hoverText">{{ $t("workbench.assets.preview") }}</span>
          </div>
        </div>
      </template>
    </t-image-viewer>
  </div>
</template>

<script setup lang="ts">
import { inject } from "vue";
import type { AssetRecord } from "../composables/assetsLogic";
import { assetsContextKey } from "../composables/assetsContext";

defineProps<{ row: AssetRecord; loading?: boolean }>();
const page = inject(assetsContextKey)!;
</script>

<style lang="scss" scoped>
@use "../styles/assets-page.scss";
</style>
