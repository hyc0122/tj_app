<template>
  <t-table
    :columns="page.clipColumns"
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
    <template #preview="{ row }">
      <div class="previewCell">
        <t-image-viewer v-if="page.getMediaType(row.src) === 'image'" :images="[row.src]">
          <template #trigger="{ open }">
            <div class="mediaTrigger" @click="row.src && open()">
              <img :src="row.src" :alt="row.name" />
              <div class="mediaHoverOverlay">
                <t-icon name="browse" size="20px" />
                <span class="hoverText">{{ $t("workbench.assets.preview") }}</span>
              </div>
            </div>
          </template>
        </t-image-viewer>
        <div
          v-else-if="page.getMediaType(row.src) === 'video'"
          class="mediaTrigger videoThumb"
          @click="page.openMediaPreview(row.src, row.name)">
          <video :src="row.src" class="thumbVideo" />
          <div class="mediaHoverOverlay">
            <t-icon name="play-circle" size="24px" />
            <span class="hoverText">{{ $t("workbench.assets.play") }}</span>
          </div>
        </div>
        <div
          v-else-if="page.getMediaType(row.src) === 'audio'"
          class="mediaTrigger audioThumb"
          @click="page.openMediaPreview(row.src, row.name)">
          <t-icon name="music" size="28px" />
          <div class="mediaHoverOverlay">
            <t-icon name="play-circle" size="24px" />
            <span class="hoverText">{{ $t("workbench.assets.play") }}</span>
          </div>
        </div>
        <div v-else class="mediaTrigger noMedia"><t-icon name="image" size="24px" /></div>
      </div>
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
import { assetsContextKey } from "../composables/assetsContext";

const page = inject(assetsContextKey)!;
</script>

<style lang="scss" scoped>
@use "../styles/assets-page.scss";
</style>
