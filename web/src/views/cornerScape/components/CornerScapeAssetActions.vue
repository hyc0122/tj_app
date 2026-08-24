<template>
  <div class="cornerScapeAssetActions" data-section="corner-scape-asset-actions">
    <div class="cornerScapeAssetActions__buttons">
      <t-button theme="primary" variant="outline" data-action="create-asset" :disabled="readonly" @click="createOpen = true">新建资产</t-button>
      <t-button theme="primary" variant="outline" data-action="batch-upload-assets" :disabled="readonly" @click="batchOpen = true">批量上传资产</t-button>
      <t-button theme="primary" variant="outline" data-action="import-asset-descriptions" :disabled="readonly" @click="importOpen = true">导入资产描述</t-button>
    </div>
    <CornerScapeCreateAssetDialog
      :open="createOpen"
      :project-uuid="projectUuid"
      :readonly="readonly"
      @close="createOpen = false"
      @created="emit('changed')"
    />
    <CornerScapeBatchUploadDialog
      :open="batchOpen"
      :project-uuid="projectUuid"
      :readonly="readonly"
      @close="batchOpen = false"
      @created="emit('changed')"
    />
    <CornerScapeImportAssetsDialog
      :open="importOpen"
      :project-uuid="projectUuid"
      :readonly="readonly"
      @close="importOpen = false"
      @created="emit('changed')"
    />
  </div>
</template>

<script setup lang="ts">
import projectStore from "@/stores/project";
import CornerScapeCreateAssetDialog from "./CornerScapeCreateAssetDialog.vue";
import CornerScapeBatchUploadDialog from "./CornerScapeBatchUploadDialog.vue";
import CornerScapeImportAssetsDialog from "./CornerScapeImportAssetsDialog.vue";

const emit = defineEmits<{ changed: [] }>();
const store = projectStore();
const readonly = computed(() => (
  !store.canWrite
  || store.project?.myRole === "viewer"
  || store.project?.openMode === "readonly"
));
const projectUuid = computed(() => String(store.project?.projectUuid || "").trim());
const createOpen = ref(false);
const batchOpen = ref(false);
const importOpen = ref(false);

watch(projectUuid, () => {
  // 中文注释：切换项目后必须关闭旧弹窗，禁止旧异步表单写入新项目。
  createOpen.value = false;
  batchOpen.value = false;
  importOpen.value = false;
});
</script>

<style scoped lang="scss">
.cornerScapeAssetActions {
  display: grid;
  gap: 10px;
  margin-bottom: 12px;
}

.cornerScapeAssetActions__buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>

<style lang="scss">
/* 中文注释：弹窗已 attach 到 body，样式必须是全局类，内部滚动避免页面横向溢出。 */
.assetActionGlobalDialog {
  z-index: 5500;
  max-width: calc(100vw - 32px);
  max-height: min(90vh, 840px);
}

.assetActionGlobalDialog .t-dialog__body,
.assetActionGlobalDialog .createAssetDialog,
.assetActionGlobalDialog .batchUploadDialog,
.assetActionGlobalDialog .importAssetsDialog {
  max-height: min(72vh, 680px);
  overflow: auto;
}
</style>
