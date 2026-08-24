<template>
  <div :class="rootClass">
    <div :class="headerClass">
      <span>{{ title }}</span>
      <t-button size="small" variant="outline" @click="$emit('add')">
        <template #icon><i-plus size="14" /></template>
        {{ addLabel }}
      </t-button>
    </div>
    <div class="artStyleContent">
      <div v-if="error" class="manualError">
        <span>{{ error }}</span>
        <t-button size="small" variant="outline" @click="$emit('retry')">
          重试
        </t-button>
      </div>
      <t-loading :loading="loading" :text="$t('workbench.project.dialog.loading')">
        <div class="gridContainer">
          <div
            v-for="(item, index) in items"
            :key="index"
            class="gridItem"
            :class="{ active: selected === itemKey(item) }"
            @click="$emit('select', itemKey(item))"
          >
            <div class="imageWrapper">
              <img
                :src="item.images?.[0]"
                :alt="item.name"
                class="artImage"
                loading="lazy"
                style="aspect-ratio: 1"
              />
              <div class="text">{{ item.name }}</div>
            </div>
            <t-button class="editBtn" shape="square" @click.stop="$emit('edit', item)">
              <i-edit theme="outline" size="14" />
            </t-button>
            <t-button class="delBtn" shape="square" @click.stop="$emit('remove', item)">
              <i-delete theme="outline" size="14" />
            </t-button>
            <t-button class="preview" shape="square" @click.stop="$emit('preview', item.images?.[0])">
              <i-preview-open theme="outline" size="14" />
            </t-button>
          </div>
        </div>
      </t-loading>
    </div>
  </div>
</template>

<script setup lang="ts" generic="T extends { name?: string; images?: string[] }">
defineProps<{
  title: string;
  addLabel: string;
  rootClass: string;
  headerClass: string;
  loading: boolean;
  error: unknown;
  items: T[];
  selected: string;
  itemKey: (item: T) => string;
}>();

defineEmits<{
  add: [];
  retry: [];
  select: [value: string];
  edit: [item: T];
  remove: [item: T];
  preview: [src: string | undefined];
}>();
</script>

<style lang="scss" scoped src="../styles/project-manual-picker.scss"></style>
