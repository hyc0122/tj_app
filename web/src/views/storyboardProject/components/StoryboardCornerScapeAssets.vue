<template>
  <div class="storyboardCornerScape">
    <CornerScapeWorkspace @changed="onChanged" />
  </div>
</template>

<script setup lang="ts">
import { provide } from "vue";
import CornerScapeWorkspace from "@/views/cornerScape/components/CornerScapeWorkspace.vue";
import { cornerScapeContextKey } from "@/views/cornerScape/composables/cornerScapeContext";
import { useCornerScapePage } from "@/views/cornerScape/composables/useCornerScapePage";

defineProps<{ readonly?: boolean }>();
const emit = defineEmits<{ changed: [] }>();

if (typeof window !== "undefined" && typeof (window as { $t?: unknown }).$t !== "function") {
  // 中文注释：嵌入分镜页时若测试/启动尚未挂 window.$t，回退为 key，禁止拖垮资产页。
  (window as { $t: (key: string) => string }).$t = (key: string) => key;
}

// 中文注释：分镜资产管理必须复用塑角造景同一套页面状态，而不是再挂一套 AssetManager。
const page = useCornerScapePage();
provide(cornerScapeContextKey, page);

function onChanged(): void {
  void page.getFilteredData();
  emit("changed");
}
</script>
