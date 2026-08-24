<template>
  <div class="assets">
    <AssetsPanel />
    <AssetsDialogs />
  </div>
</template>

<script setup lang="ts">
import { provide } from "vue";
import AssetsDialogs from "./components/AssetsDialogs.vue";
import AssetsPanel from "./components/AssetsPanel.vue";
import { assetsContextKey } from "./composables/assetsContext";
import { useAssetsPage } from "./composables/useAssetsPage";
import type { AssetTab } from "./composables/useAssetsState";
import type { MediaType } from "./composables/assetsLogic";

const props = withDefaults(
  defineProps<{
    /** 是否作为选择器弹窗使用 */
    selectorMode?: boolean;
    /** 限制显示的资产类型 */
    allowedTypes?: AssetTab[];
    /** 当类型为 clip 时，限制媒体子类型 */
    clipMediaTypes?: Array<Exclude<MediaType, "unknown">>;
    /** 是否多选 */
    multiple?: boolean;
  }>(),
  { selectorMode: false, multiple: true },
);

const page = useAssetsPage(props);
provide(assetsContextKey, page);

defineExpose({
  selectedRowKeys: page.selectedRowKeys,
  selectedSubRowKeys: page.selectedSubRowKeys,
  tableData: page.tableData,
});
</script>

<style lang="scss" scoped>
.assets {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
</style>
