<template>
  <t-table
    :columns="page.columns"
    :data="page.tableData.value"
    :selected-row-keys="page.selectedRowKeys.value"
    :expanded-row-keys="page.expandedRowKeys.value"
    row-key="id"
    hover
    height="calc(100vh - 300px)"
    stripe
    size="small"
    :pagination="page.pagination.value"
    :loading="page.loading.value"
    lazy-load
    table-layout="fixed"
    :select-on-row-click="false"
    @select-change="page.handleSelectChange"
    @expand-change="page.handleExpandChange"
    @page-change="page.handlePageChange">
    <template #expandedRow="{ row }">
      <div class="expandedContent">
        <t-table
          :columns="page.subColumns"
          :data="row.sonAssets || []"
          :selected-row-keys="page.selectedSubRowKeys.value"
          row-key="id"
          hover
          size="small"
          table-layout="fixed"
          :select-on-row-click="false"
          @select-change="page.handleSubSelectChange">
          <template #previewWithLoading="{ row: subRow }">
            <AssetImageCell :row="subRow" :loading="subRow.state === '生成中'" />
          </template>
          <template #prompt="{ row: subRow }">
            <div class="promptCell">
              <t-loading v-if="subRow.promptState === '生成中'" size="small" />
              <span :class="{ 'generating-text': subRow.promptState === '生成中' }">{{ subRow.prompt }}</span>
            </div>
          </template>
          <template #operation="{ row: subRow }">
            <AssetRowActions :row="subRow" />
          </template>
        </t-table>
      </div>
    </template>
    <template #previewWithLoading="{ row }">
      <AssetImageCell :row="row" :loading="row.state === '生成中'" />
    </template>
    <template #prompt="{ row }">
      <div class="promptCell">
        <t-loading v-if="row.promptState === '生成中'" size="small" />
        <span :class="{ 'generating-text': row.promptState === '生成中' }">{{ row.prompt }}</span>
      </div>
    </template>
    <template #startTime="{ row }">
      <span>{{ dayjs(row.startTime).format("YYYY-MM-DD HH:mm:ss") }}</span>
    </template>
    <template #operation="{ row }">
      <AssetRowActions :row="row" />
    </template>
  </t-table>
</template>

<script setup lang="ts">
import { inject } from "vue";
import dayjs from "dayjs";
import AssetImageCell from "./AssetImageCell.vue";
import AssetRowActions from "./AssetRowActions.vue";
import { assetsContextKey } from "../composables/assetsContext";

const page = inject(assetsContextKey)!;
</script>

<style lang="scss" scoped>
@use "../styles/assets-page.scss";
</style>
