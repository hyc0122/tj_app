<template>
  <section class="tapcanvas-host" data-tapcanvas-host>
    <!-- 中文注释：直接加载随安装包发布的同源 TapCanvas 子应用，不允许指向外部站点。 -->
    <iframe
      class="tapcanvas-frame"
      :src="frameSrc"
      title="无限画布"
      referrerpolicy="no-referrer"
    />
  </section>
</template>

<script setup lang="ts">
const props = defineProps<{
  projectUuid?: string;
}>();

const frameSrc = computed(() => {
  if (props.projectUuid) {
    return `/tapcanvas/studio?projectId=${encodeURIComponent(props.projectUuid)}`;
  }
  return "/tapcanvas/index.html";
});
</script>

<style scoped>
.tapcanvas-host {
  display: flex;
  width: 100%;
  height: 100%;
  min-height: 0;
  background: #1a1b1e;
}
.tapcanvas-frame {
  flex: 1;
  width: 100%;
  height: 100%;
  border: 0;
  background: #1a1b1e;
}
</style>
