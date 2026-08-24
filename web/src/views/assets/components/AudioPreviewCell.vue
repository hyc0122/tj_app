<template>
  <div class="previewCell">
    <div class="mediaTrigger audioThumb" @click="page.openMediaPreview(row.src ?? '', row.name ?? '')">
      <t-icon name="music" size="28px" />
      <div class="mediaHoverOverlay">
        <t-icon name="play-circle" size="24px" />
        <span class="hoverText">{{ $t("workbench.assets.play") }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { inject } from "vue";
import type { AssetRecord } from "../composables/assetsLogic";
import { assetsContextKey } from "../composables/assetsContext";

defineProps<{ row: AssetRecord }>();
const page = inject(assetsContextKey)!;
</script>

<style lang="scss" scoped>
@use "../styles/assets-page.scss";
</style>
