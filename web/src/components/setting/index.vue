<template>
  <section class="settingPanel">
      <t-menu class="settingMenu" v-model:value="activeMenu" :style="{ height: '70vh' }">
        <!-- 二级菜单：统一 module-interactive--sm，禁止父子同时 transform -->
        <t-menu-item
          v-for="item in menuItems"
          :key="item.key"
          :value="item.key"
          class="setting-menu-item module-interactive--sm"
        >
          <template #icon>
            <t-badge :count="needUpdate && item.key === 'about' ? 1 : 0" dot>
              <component :is="item.icon" class="icon" />
            </t-badge>
          </template>
          {{ $t(item.label) }}
        </t-menu-item>
      </t-menu>
      <div class="settingRight">
        <div v-if="allMenusClosed" class="sectionTitle">当前功能由管理员关闭</div>
        <template v-else>
          <div class="sectionTitle">{{ currentMenuItem ? $t(currentMenuItem.label) : "" }}</div>
          <div class="settingContent">
            <uiConfig v-if="activeMenu === 'ui'" />
            <languageConfig v-if="activeMenu === 'language'" />
            <vendorConfig v-if="activeMenu === 'vendorConfig'" />
            <agentConfog v-if="activeMenu === 'agentConfog'" />
            <promptManage v-if="activeMenu === 'promptManage'" />
            <otherConfig v-if="activeMenu === 'otherConfig'" />
            <dbConfig v-if="activeMenu === 'dbConfig'" />
            <about v-if="activeMenu === 'about'" />
            <logoutConfig v-if="activeMenu === 'logoutConfig'" />
            <memoryConfig v-if="activeMenu === 'memoryConfig'" />
            <fileManagement v-if="activeMenu === 'fileManagement'" />
            <skillManagement v-if="activeMenu === 'skillManagement'" />
            <devConfig v-if="activeMenu === 'devConfig'" />
            <modelMap v-if="activeMenu === 'modelMap'" />
          </div>
        </template>
      </div>
  </section>
</template>

<script setup lang="ts">
import settingStore from "@/stores/setting";
const { activeMenu, needUpdate, activeWorkspaceProviderId } = storeToRefs(settingStore());

import uiConfig from "./components/uiConfig.vue";
import languageConfig from "./components/languageConfig.vue";
import agentConfog from "./components/agentConfog.vue";
import dbConfig from "./components/dbConfig.vue";
import otherConfig from "./components/otherConfig.vue";
import about from "./components/about.vue";
import logoutConfig from "./components/logoutConfig.vue";
import vendorConfig from "./components/vendorConfig.vue";
import memoryConfig from "./components/memoryConfig.vue";
import fileManagement from "./components/fileManagement.vue";
import skillManagement from "./components/skillManagement.vue";
import devConfig from "./components/devConfig.vue";
import promptManage from "./components/promptManage.vue";
import modelMap from "./components/modelMap.vue";

const allMenuItems = [
  { key: "ui", label: "settings.menu.ui", icon: "i-theme", flag: "uiSettings" },
  { key: "language", label: "settings.menu.language", icon: "i-translate", flag: "languageSettings" },
  { key: "vendorConfig", label: "settings.menu.vendorConfig", icon: "i-computer", flag: "modelServices" },
  { key: "modelMap", label: "settings.menu.modelMap", icon: "i-computer", flag: "modelMapping" },
  { key: "agentConfog", label: "settings.menu.agentConfig", icon: "i-color-filter", flag: "agentConfig" },
  { key: "promptManage", label: "settings.menu.promptManage", icon: "i-tips", flag: "promptManagement" },
  { key: "skillManagement", label: "settings.menu.skillsSkillsManagement", icon: "i-ring", flag: "skillsManagement" },
  { key: "memoryConfig", label: "settings.menu.memoryConfig", icon: "i-memory-card-one", flag: "agentMemory" },
  { key: "dbConfig", label: "settings.menu.dbConfig", icon: "i-data", flag: "databaseOperations" },
  { key: "fileManagement", label: "settings.menu.fileManagement", icon: "i-hard-disk", flag: "fileManagement" },
  { key: "otherConfig", label: "settings.menu.otherConfig", icon: "i-application-menu", flag: "otherConfiguration" },
  { key: "devConfig", label: "settings.menu.devConfig", icon: "i-flask", flag: "developerOptions" },
  { key: "about", label: "settings.menu.about", icon: "i-info", flag: "checkUpdates" },
  { key: "logoutConfig", label: "settings.menu.logoutConfig", icon: "i-logout", flag: "logout" },
];

const featureFlags = ref<Record<string, boolean>>({});
const menuItems = computed(() =>
  allMenuItems.filter((item) => featureFlags.value[item.flag] !== false),
);
const currentMenuItem = computed(() => menuItems.value.find((item) => item.key === activeMenu.value));
const allMenusClosed = computed(() => menuItems.value.length === 0);

function migrateLegacyDreaminaMenu() {
  // 中文注释：独立即梦菜单已并入模型服务；旧 deep link 只激活原生供应商卡片。
  if (activeMenu.value === "dreaminaCli") {
    activeMenu.value = "vendorConfig";
    activeWorkspaceProviderId.value = "native:dreamina-cli";
  }
}

migrateLegacyDreaminaMenu();
watch(activeMenu, migrateLegacyDreaminaMenu);

onMounted(async () => {
  try {
    const res = await (await import("@/utils/axios")).default.get("/tianjiang/public/client-config");
    const payload = (res as { data?: { config?: { featureFlags?: Record<string, boolean> }; featureFlags?: Record<string, boolean> } })?.data;
    const flags = payload?.config?.featureFlags ?? payload?.featureFlags;
    if (flags && typeof flags === "object") featureFlags.value = flags;
  } catch {
    featureFlags.value = {};
  }
  migrateLegacyDreaminaMenu();
  if (!menuItems.value.some((item) => item.key === activeMenu.value) && menuItems.value[0]) {
    activeMenu.value = menuItems.value[0].key;
  }
});
</script>

<style lang="scss" scoped>
.settingPanel {
  display: flex;
  height: 100%;
  overflow: hidden;

  .settingMenu {
    width: 200px;
    min-width: 200px;
    border-right: 1px solid var(--td-component-border);
    flex-shrink: 0;
    // 使用主题变量，禁止硬编码 #000 作为选中背景。
    :deep(.t-menu__item.t-is-active) {
      background-color: var(--td-brand-color-light);
      color: var(--td-brand-color);
    }
    // 选中项悬浮后仍保持清晰（不靠再套一层 transform）
    :deep(.t-menu__item.setting-menu-item.t-is-active:hover) {
      background-color: var(--td-brand-color-light-hover, var(--td-brand-color-light));
      color: var(--td-brand-color);
    }
    :deep(.t-menu__item.setting-menu-item) {
      // 菜单项自身承担悬浮；内部图标不挂 interactive 类
      border-radius: var(--td-radius-default, 3px);
    }
    .icon {
      font-size: 20px;
      margin-right: 8px;
    }
  }

  .settingRight {
    flex: 1;
    padding-left: 16px;
    padding-right: 16px;
      height: 100%;
    overflow-y: auto;

    .sectionTitle {
      font-size: 16px;
      font-weight: 600;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--td-component-border);
      margin-bottom: 1vh;
      height: 4vh;
    }

    .settingContent {
      width: 100%;
      min-height: calc(100vh - 210px);
    }
  }
}
:deep(.t-menu) {
  padding: 0;
  padding-right: 8px;
}
:deep(.t-is-active) {
  .t-badge {
    color: var(--td-brand-color) !important;
  }
}
</style>
