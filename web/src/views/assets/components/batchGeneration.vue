<template>
  <div class="batchGeneration">
    <t-dialog
      v-model:visible="batchGenerationShow"
      :header="$t('workbench.assets.batch.header')"
      top="3vh"
      width="80vw"
      :maskClosable="false"
      :footer="true"
      @close-btn-click="handleCancel"
      @confirm="onConfirm"
      @cancel="handleCancel">
      <div class="content">
        <div class="toolbar">
          <t-space>
            <span class="selectedInfo">{{ $t('workbench.assets.batch.selected', { count: selectedRowKeys.length }) }}</span>
            <t-button theme="primary" size="small" @click="handleSelectAll">{{ $t('workbench.assets.batch.selectAll') }}</t-button>
            <t-button theme="default" size="small" @click="handleClearSelection">{{ $t('workbench.assets.batch.clearSelection') }}</t-button>
          </t-space>
          <t-input v-model="searchText" :placeholder="$t('workbench.assets.searchPlaceholder')" clearable style="width: 400px; margin-left: 10px">
            <template #prefix-icon>
              <t-icon name="search" />
            </template>
          </t-input>
          <div class="btn">
            <t-button theme="primary" @click="handleBatchGeneratePrompt" :loading="textLoading" :disabled="textLoading">
              <div class="ac">
                <i-translate theme="outline" size="20" />
                {{ $t('workbench.assets.generatePrompt') }}
              </div>
            </t-button>
            <t-button theme="primary" style="margin-left: 10px" @click="handleBatchGenerateImage" :loading="imageLoading" :disabled="imageLoading">
              <div class="ac">
                <i-pic theme="outline" size="20" />
                {{ $t('workbench.assets.generateImage') }}
              </div>
            </t-button>
          </div>
        </div>
        <t-table
          :columns="columns"
          :data="filteredData"
          :selected-row-keys="selectedRowKeys"
          row-key="id"
          hover
          stripe
          size="small"
          :pagination="pagination"
          :loading="loading"
          table-layout="fixed"
          max-height="60vh"
          @select-change="handleSelectChange"
          @page-change="handlePageChange">
          <template #preview="{ row }">
            <div class="previewCell">
              <t-image-viewer :images="[row.filePath]" :closeOnEscKeydown="true" :closeOnOverlay="true">
                <template #trigger="{ open }">
                  <div class="imageTrigger" @click="row.filePath && open()">
                    <img v-if="row.filePath" :src="row.filePath" :alt="row.name" class="previewImage" />
                    <div v-else class="noImage">
                      <t-icon name="image" size="24px" />
                    </div>
                    <div v-if="row.filePath" class="imageHoverOverlay">
                      <t-icon name="browse" size="20px" />
                      <span class="hoverText">{{ $t('workbench.assets.preview') }}</span>
                    </div>
                  </div>
                </template>
              </t-image-viewer>
            </div>
          </template>
          <template #prompt="{ row }">
            <t-tooltip :content="row.prompt" placement="top">
              <t-textarea :placeholder="$t('workbench.assets.batch.inputPh')" v-model="row.prompt" />
            </t-tooltip>
          </template>
        </t-table>
      </div>
      <template #footer>
        <t-space>
          <t-button theme="default" @click="handleCancel">{{ $t('workbench.assets.cancelBtn') }}</t-button>
          <t-button theme="primary" @click="onConfirm" :disabled="selectedRowKeys.length === 0">{{ $t('workbench.assets.batch.saveSelected', { count: selectedRowKeys.length }) }}</t-button>
        </t-space>
      </template>
    </t-dialog>
  </div>
</template>

<script setup lang="ts">
import { useLegacyBatchGeneration } from "../composables/useLegacyBatchGeneration";

const props = defineProps<{ type: "role" | "tool" | "scene" | "clip" }>();
const emit = defineEmits<{ update: [] }>();
const batchGenerationShow = defineModel<boolean>({ default: false });
const {
  columns, tableData, rowPromptLoading, rowImageLoading, selectedRowKeys, searchText,
  loading, pagination, filteredData, textLoading, imageLoading, handleSelectChange,
  handleSelectAll, handleClearSelection, handlePageChange, closeModal, handleCancel,
  onConfirm, handleBatchGeneratePrompt, handleBatchGenerateImage,
} = useLegacyBatchGeneration(props.type, batchGenerationShow, () => emit("update"));
</script>

<style lang="scss" scoped>
@use "../styles/legacy-batch-generation.scss";
</style>
