<template>
  <t-table
    :columns="page.audioColumns"
    :data="page.tableData.value"
    :selected-row-keys="page.selectedRowKeys.value"
    :expanded-row-keys="page.expandedRowKeys.value"
    row-key="id"
    hover
    stripe
    size="small"
    :pagination="page.pagination.value"
    :loading="page.loading.value"
    lazy-load
    table-layout="fixed"
    @select-change="page.handleSelectChange"
    @expand-change="page.handleExpandChange"
    @page-change="page.handlePageChange">
    <template v-if="!page.props.selectorMode" #expandedRow="{ row }">
      <div class="expandedContent">
        <t-table
          :columns="page.subAudioColumns"
          :data="row.sonAssets || []"
          :selected-row-keys="page.selectedSubRowKeys.value"
          row-key="id"
          hover
          size="small"
          table-layout="fixed"
          stripe
          :select-on-row-click="false"
          @select-change="page.handleSubSelectChange">
          <template #previewWithLoading="{ row: subRow }">
            <AudioPreviewCell :row="subRow" />
          </template>
          <template #prompt="{ row: subRow }">
            <div class="promptCell"><span>{{ subRow.prompt }}</span></div>
          </template>
          <template #operation="{ row: subRow }">
            <t-button theme="danger" variant="text" :disabled="page.isGenerating(subRow.id)" @click="page.handleDelete(subRow)">
              <template #icon><t-icon name="delete" /></template>
              {{ $t("workbench.assets.delete") }}
            </t-button>
          </template>
        </t-table>
      </div>
    </template>
    <template #preview="{ row }">
      <AudioPreviewCell :row="row" />
    </template>
    <template #startTime="{ row }">
      <span>{{ dayjs(row.startTime).format("YYYY-MM-DD HH:mm:ss") }}</span>
    </template>
    <template #operation="{ row }">
      <t-space :size="0">
        <t-button theme="primary" variant="text" @click="page.handleEdit(row)">
          <template #icon><t-icon name="edit" /></template>
          {{ $t("workbench.assets.edit") }}
        </t-button>
        <t-button theme="danger" variant="text" @click="page.handleDelete(row)">
          <template #icon><t-icon name="delete" /></template>
          {{ $t("workbench.assets.delete") }}
        </t-button>
      </t-space>
    </template>
  </t-table>
</template>

<script setup lang="ts">
import { inject } from "vue";
import dayjs from "dayjs";
import AudioPreviewCell from "./AudioPreviewCell.vue";
import { assetsContextKey } from "../composables/assetsContext";

const page = inject(assetsContextKey)!;
</script>

<style lang="scss" scoped>
@use "../styles/assets-page.scss";
</style>
