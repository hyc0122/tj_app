<template>
  <div
    class="main"
    data-page-shell
    :style="{
      height: isElectron ? 'calc(100dvh - var(--app-titlebar-height, 42px))' : '100dvh',
      overflow: 'hidden',
    }"
  >
    <!-- 左侧主导航：桌面展开为「图标+文字」，窄窗口折叠为图标模式 -->
    <nav
      class="menu fc jb"
      :class="{ collapsed: menuCollapsed }"
      :aria-label="$t('workbench.menu.navAria')"
    >
      <div class="logoBox c">
        <div class="logo" aria-hidden="true"></div>
      </div>
      <div class="itemBox fc ac">
        <template v-for="(menu, index) in menuList" :key="index">
          <t-tooltip
            v-if="menu.type === 'btn'"
            :content="menu.labelKey ? $t(menu.labelKey) : ''"
            placement="right"
            destroyOnClose
            :showArrow="false"
            :disabled="!menuCollapsed"
          >
            <div
              class="item module-interactive"
              role="button"
              tabindex="0"
              :class="{ active: activeMenu == menu.path }"
              :aria-label="menu.labelKey ? $t(menu.labelKey) : undefined"
              :aria-current="activeMenu == menu.path ? 'page' : undefined"
              @click="handleClick(menu)"
              @keydown.enter.prevent="handleClick(menu)"
              @keydown.space.prevent="handleClick(menu)"
            >
              <component :is="menu.icon" class="icon" aria-hidden="true" />
              <span class="label" v-if="menu.labelKey">{{ $t(menu.labelKey) }}</span>
            </div>
          </t-tooltip>
          <div class="divider" v-else-if="menu.type === 'divider'" role="separator"></div>
        </template>
      </div>
      <div class="footItem fc ac">
        <!-- 底部反馈 / 设置与主导航统一结构与动效 -->
        <t-tooltip
          :content="$t('workbench.menu.feedbackQuestions')"
          placement="right"
          destroyOnClose
          :showArrow="false"
          :disabled="!menuCollapsed"
        >
          <div
            class="item module-interactive"
            role="button"
            tabindex="0"
            :aria-label="$t('workbench.menu.feedbackQuestions')"
            @click="openFeedback"
            @keydown.enter.prevent="openFeedback"
            @keydown.space.prevent="openFeedback"
          >
            <i-bill class="icon" aria-hidden="true" />
            <span class="label">{{ $t("workbench.menu.feedbackQuestions") }}</span>
          </div>
        </t-tooltip>
        <t-tooltip
          :content="$t('workbench.menu.settings')"
          placement="right"
          destroyOnClose
          :showArrow="false"
          :disabled="!menuCollapsed"
        >
          <div
            class="item module-interactive"
            role="button"
            tabindex="0"
            :class="{ active: activeMenu === '/settings' }"
            :aria-label="$t('workbench.menu.settings')"
            :aria-current="activeMenu === '/settings' ? 'page' : undefined"
            @click="router.push('/settings')"
            @keydown.enter.prevent="router.push('/settings')"
            @keydown.space.prevent="router.push('/settings')"
          >
            <t-badge :count="needUpdate ? 1 : 0" dot>
              <i-setting-one class="icon" aria-hidden="true" />
            </t-badge>
            <span class="label">{{ $t("workbench.menu.settings") }}</span>
          </div>
        </t-tooltip>
      </div>
    </nav>
    <div class="view">
      <div class="topMenu f ac" v-if="project?.id">
        <div class="title" data-page-title>
          <h2>{{ project?.name || $t("workbench.selectProject") }}</h2>
        </div>
        <nav class="businessNav f ac" data-business-nav :aria-label="$t('workbench.menu.navAria')">
          <template v-for="(menu, index) in visibleRightBtnList" :key="index">
            <button
              type="button"
              class="item module-interactive"
              style="display: flex; align-items: center; cursor: pointer"
              v-if="menu.type === 'btn' && (project.projectType === 'novel' || !menu.nodelOnly)"
              :data-nav-path="menu.path"
              :class="{ active: activeMenu == menu.path }"
              :aria-label="menu.labelKey ? $t(menu.labelKey) : undefined"
              :title="menu.labelKey ? $t(menu.labelKey) : undefined"
              :aria-current="activeMenu == menu.path ? 'page' : undefined"
              @click="handleClick(menu)"
              @keydown.enter.prevent="handleClick(menu)"
              @keydown.space.prevent="handleClick(menu)"
            >
              <component :is="menu.icon" class="icon" aria-hidden="true" />
              <span class="label" v-if="menu.labelKey">{{ $t(menu.labelKey) }}</span>
            </button>
            <div class="divider" v-else-if="menu.type === 'divider'"></div>
          </template>
        </nav>
      </div>
      <div class="viewBox" data-content-scroll style="overflow: auto">
        <router-view v-slot="{ Component }">
          <ProjectWorkspaceGate v-if="isProjectWorkspace">
            <component :is="Component" :key="$route.fullPath" />
          </ProjectWorkspaceGate>
          <component v-else :is="Component" :key="$route.fullPath" />
        </router-view>
      </div>
    </div>
  </div>
  <hello />
</template>

<script setup lang="ts">
import axios from "@/utils/axios";
import hello from "@/components/hello.vue";
import projectStore from "@/stores/project";
import { closeCatalogProject } from "@/features/tianjiang/project/catalog";
import ProjectWorkspaceGate from "@/components/tianjiang/ProjectWorkspaceGate.vue";
import { recoverActiveProjectAfterRuntimeRestart } from "@/features/tianjiang/runtime/project-recovery";
const activeProjectStore = projectStore();
const { project, access } = storeToRefs(activeProjectStore);
import settingStore from "@/stores/setting";
import { NotifyPlugin } from "tdesign-vue-next";
const { showSetting, isElectron, needUpdate } = storeToRefs(settingStore());
const menuList = ref([
  { type: "btn", path: "/project", labelKey: "workbench.menu.myProject", icon: "i-folder-close" },
  { type: "btn", path: "/task", labelKey: "workbench.menu.taskCenter", icon: "i-view-list" },
  { type: "btn", path: "/team", labelKey: "workbench.menu.team", icon: "i-people" },
  { type: "btn", path: "/infinite-canvas", labelKey: "workbench.menu.infiniteCanvas", icon: "i-all-application" },
  // canvas starters: blank novel-upload storyboard-guide text-to-image first-frame-to-video
]);

const rightBtnList = ref([
  { type: "btn", path: "/novel", labelKey: "workbench.menu.novel", icon: "i-notebook", nodelOnly: true },
  { type: "btn", path: "/scriptAgent", labelKey: "workbench.menu.scriptAgent", icon: "i-color-filter", nodelOnly: true },
  { type: "btn", path: "/script", labelKey: "workbench.menu.scriptManage", icon: "i-document-folder" },
  { type: "btn", path: "/cornerScape", labelKey: "workbench.menu.cornerScape", icon: "i-peoples-two" },
  { type: "btn", path: "/production", labelKey: "workbench.menu.production", icon: "i-carousel-video" },
  { type: "divider" },
  { type: "btn", path: "/assets", labelKey: "workbench.menu.assetCenter", icon: "i-receive" },
]);

const router = useRouter();
const route = useRoute();
const hiddenStoryboardBusinessPaths = new Set(["/script", "/cornerScape", "/production", "/assets"]);
const visibleRightBtnList = computed(() => {
  if (route.path !== "/storyboard-project") return rightBtnList.value;
  return rightBtnList.value.filter((menu) => {
    if (menu.type !== "btn") return false;
    const path = typeof menu.path === "string" ? menu.path : "";
    return !hiddenStoryboardBusinessPaths.has(path);
  });
});
const activeMenu = ref(route.path);
const projectWorkspacePaths = new Set([
  "/novel", "/script", "/scriptAgent", "/cornerScape", "/production", "/assets",
]);
const isProjectWorkspace = computed(() => projectWorkspacePaths.has(route.path));

/** 窄窗口自动折叠为图标模式；阈值参考桌面侧栏密度，避免内容区横向滚动 */
const SIDEBAR_COLLAPSE_MAX = 1100;
const menuCollapsed = ref(
  typeof window !== "undefined" ? window.innerWidth <= SIDEBAR_COLLAPSE_MAX : false,
);

function updateMenuCollapsed() {
  menuCollapsed.value = window.innerWidth <= SIDEBAR_COLLAPSE_MAX;
}

// 兼容旧组件发出的设置请求，但完整设置界面只由独立路由承载。
watch(showSetting, (visible) => {
  if (!visible) return;
  showSetting.value = false;
  void router.push("/settings");
});

watch(
  () => route.path,
  (newPath) => {
    activeMenu.value = newPath.startsWith("/infinite-canvas") ? "/infinite-canvas" : newPath;
  },
);

function handleClick(menu: any) {
  if (menu.needProject && !project.value) return;
  router.push(menu.path);
  activeMenu.value = menu.path;
}

/** 与 app 内置包一致的反馈降级地址（仅 support 缺失且无缓存时使用）。 */
const PACKAGED_FEEDBACK_URL =
  "https://docs.qq.com/smartsheet/form/EmvmQBrmlPmr%2Fss_vsqk2v%2FvhiGzE?tab=ss_vsqk2v";

function isSafeFeedbackUrl(raw: unknown): raw is string {
  if (typeof raw !== "string" || !raw.trim()) return false;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:") return false;
    if (u.username || u.password) return false;
    const host = u.hostname.toLowerCase();
    if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function resolveFeedbackUrl(): Promise<string> {
  try {
    const res = await axios.get("/tianjiang/public/client-config");
    const payload = (res as { data?: { config?: { support?: { feedbackUrl?: string } }; support?: { feedbackUrl?: string } } })?.data;
    const config = (payload as { config?: { support?: { feedbackUrl?: string } } })?.config ?? payload;
    const url = config?.support?.feedbackUrl;
    if (isSafeFeedbackUrl(url)) return url.trim();
  } catch {
    // 网络失败时使用内置降级；本地代理已缓存时会返回缓存配置。
  }
  return PACKAGED_FEEDBACK_URL;
}

async function openFeedback() {
  const url = await resolveFeedbackUrl();
  if (!isSafeFeedbackUrl(url)) {
    NotifyPlugin.warning({
      title: $t("workbench.feedback.invalidUrl") as string,
      content: $t("workbench.feedback.invalidUrlHint") as string,
      placement: "bottom-right",
      closeBtn: true,
    });
    return;
  }
  if (isElectron.value) {
    await fetch(`tianjiang://openurlwithbrowser?url=${encodeURIComponent(url)}`);
    return;
  }
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (!opened) {
    NotifyPlugin.warning({
      title: $t("workbench.feedback.openFailed") as string,
      content: $t("workbench.feedback.openFailedHint") as string,
      placement: "bottom-right",
      closeBtn: true,
    });
  }
}

async function checkVersion() {
  try {
    const { data } = await axios.post("/setting/about/checkUpdate", {
      source: "tianjiang",
    });
    if (data.needUpdate) {
      needUpdate.value = true;
      const { activeMenu: settingActiveMenu } = storeToRefs(settingStore());
      const notifyInstance = NotifyPlugin.success({
        title: $t("version.newVersion") as string,
        content: () =>
          h(
            "div",
            { style: "text-align: right; padding-top: 4px;" },
            h(
              "span",
              {
                style: "color: #ed7b2f; font-size: 12px; cursor: pointer;",
                onClick: () => {
                  settingActiveMenu.value = "about";
                  showSetting.value = true;
                  NotifyPlugin.close(notifyInstance);
                },
              },
              $t("skillScan.openSettings"),
            ),
          ),
        closeBtn: true,
        placement: "bottom-right",
      });
    } else {
      needUpdate.value = false;
    }
  } catch {
    // 未配置或暂不可达的更新清单不影响工作台，其余网络状态由独立运行时探测负责。
    needUpdate.value = false;
  }
}

let checkVersionTimer: ReturnType<typeof setInterval> | null = null;
let accessMonitorTimer: ReturnType<typeof setInterval> | null = null;

/** 仅在项目工作区且存在有效 active projectUuid 时轮询访问态。 */
function shouldMonitorProjectAccess(): boolean {
  if (!isProjectWorkspace.value) return false;
  const uuid = String(access.value.projectUuid ?? "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid);
}

async function refreshProjectAccess(): Promise<void> {
  if (!shouldMonitorProjectAccess()) return;
  const watchedUuid = access.value.projectUuid;
  try {
    const response = await axios.get("/tianjiang/runtime/status", {
      // 供全局错误层识别：预期的项目关闭/回收站 404 不重复 toast。
      headers: { "X-Tianjiang-Access-Poll": "1" },
    } as any);
    // 离开工作区后丢弃过期响应。
    if (!shouldMonitorProjectAccess() || access.value.projectUuid !== watchedUuid) return;
    const rows = Array.isArray(response.data?.projects) ? response.data.projects : [];
    const state = rows.find((item: any) => item.projectUuid === watchedUuid);
    if (!state) {
      // 新 Node 进程没有旧项目的内存打开态：按原 UUID 重新打开并恢复真实权限。
      await recoverActiveProjectAfterRuntimeRestart(watchedUuid);
      return;
    }
    activeProjectStore.setAccessMode(
      state.recoveryRequired ? "recovery" : state.editable ? "readwrite" : "readonly",
      state.readonlyReason ?? "",
      state.lockHolder ?? "",
    );
  } catch {
    if (!shouldMonitorProjectAccess() || access.value.projectUuid !== watchedUuid) return;
    // 状态探测失败时保守降级；Node 后端仍会对每次写请求重新授权。
    activeProjectStore.setAccessMode("readonly", "runtime_unreachable");
  }
}

function startVersionCheck() {
  checkVersion();
  checkVersionTimer = setInterval(
    () => {
      checkVersion();
    },
    2 * 60 * 1000,
  );
}

function stopVersionCheck() {
  if (checkVersionTimer) {
    clearInterval(checkVersionTimer);
    checkVersionTimer = null;
  }
}

function startAccessMonitor() {
  if (accessMonitorTimer) return;
  accessMonitorTimer = setInterval(() => void refreshProjectAccess(), 5_000);
}

function stopAccessMonitor() {
  if (accessMonitorTimer) {
    clearInterval(accessMonitorTimer);
    accessMonitorTimer = null;
  }
}

watch(needUpdate, (val) => {
  if (val) stopVersionCheck();
});

// 进入/离开项目工作区时启停访问轮询；回首页必须停止子资源相关轮询。
watch(
  () => [isProjectWorkspace.value, access.value.projectUuid] as const,
  ([inWorkspace, uuid]) => {
    if (inWorkspace && uuid) {
      startAccessMonitor();
      void refreshProjectAccess();
    } else {
      stopAccessMonitor();
    }
  },
  { immediate: true },
);

// 路由回到 /project 等非工作区时：立即释放前端大对象，再异步关闭后端 runtime。
watch(
  () => route.path,
  (path, prev) => {
    if (projectWorkspacePaths.has(path)) return;
    if (prev && projectWorkspacePaths.has(prev)) {
      stopAccessMonitor();
      const uuid = String(access.value.projectUuid ?? "").trim();
      const runtimeGeneration = access.value.runtimeGeneration;
      // 中文注释：不能等待网络请求，否则旧 Socket、Store 与媒体对象会继续占用内存。
      activeProjectStore.clearActiveProject();
      if (uuid) {
        void closeCatalogProject(uuid, runtimeGeneration).catch(() => undefined);
      }
    }
  },
);

onMounted(() => {
  startVersionCheck();
  // cyber-ui: 窄窗侧栏折叠监听；访问轮询由 project-state 的 startAccessMonitor watch 负责
  updateMenuCollapsed();
  window.addEventListener("resize", updateMenuCollapsed);
});

onUnmounted(() => {
  stopVersionCheck();
  // project-state: 条件访问轮询清理
  stopAccessMonitor();
  // cyber-ui: 侧栏 resize 监听清理
  window.removeEventListener("resize", updateMenuCollapsed);
});
</script>

<style lang="scss" scoped>
.main {
  /* 中文注释：宽度跟宿主走，禁止 100vw 把滚动条宽度再算进去。 */
  width: 100%;
  max-width: 100%;
  min-height: 0;
  padding: 16px;
  display: flex;
  overflow: hidden;
  box-sizing: border-box;

  .menu {
    /* 展开态：图标 + 文字；宽度固定，不挤压内容区到横向溢出 */
    --menu-width: 168px;
    width: var(--menu-width);
    min-width: var(--menu-width);
    max-width: var(--menu-width);
    flex-shrink: 0;
    height: 100%;
    overflow-x: hidden;
    overflow-y: auto;
    background-color: var(--page);
    border-radius: 16px;
    padding: 16px 10px;
    color: var(--td-text-color-primary);
    border: 1px solid var(--td-border-level-1-color);
    transition: width 180ms ease, min-width 180ms ease, max-width 180ms ease;

    &.collapsed {
      --menu-width: 64px;
      padding-left: 7px;
      padding-right: 7px;

      .item {
        justify-content: center;
        padding-left: 0;
        padding-right: 0;
        gap: 0;
      }

      .label {
        /* 折叠时隐藏文字，保留 DOM 供读屏在 aria-label 中读取 */
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }
    }

    .logoBox {
      width: 100%;
      height: fit-content;
      .logo {
        width: 40px;
        max-width: 60%;
        aspect-ratio: 1/1;
        background-color: var(--td-text-color-primary);
        background: url("@/assets/logo.png") no-repeat center / contain;
      }
    }
    .itemBox {
      flex: 1;
      margin-top: 16px;
      margin-bottom: 16px;
      padding-bottom: 16px;
      width: 100%;
      height: 100%;
      gap: 2px;
    }
    .footItem {
      width: 100%;
      height: fit-content;
      gap: 2px;
      /* 与主导航激活态一致：使用品牌 token，保证浅色/深色/赛博对比 */
      .active {
        background-color: var(--td-brand-color) !important;
        color: var(--td-font-white-1);
        border-radius: 12px;
      }
    }

    .item {
      cursor: pointer;
      width: 100%;
      min-height: 44px;
      height: auto;
      padding: 8px 10px;
      border-radius: 12px;
      display: flex;
      flex-direction: row;
      align-items: center;
      justify-content: flex-start;
      gap: 10px;
      margin-bottom: 2px;
      margin-top: 2px;
      position: relative;
      outline: none;
      box-sizing: border-box;

      .icon {
        font-size: 22px;
        flex-shrink: 0;
        display: inline-flex;
      }

      .label {
        font-size: 13px;
        line-height: 1.2;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        color: inherit;
        max-width: 100px;
      }

      &:hover {
        background-color: var(--td-bg-color-container-hover);
      }

      /* 键盘焦点环，与 hover 兼容 */
      &:focus-visible {
        outline: 2px solid var(--td-brand-color);
        outline-offset: 2px;
        background-color: var(--td-bg-color-container-hover);
      }

      &.active {
        background-color: var(--td-brand-color) !important;
        color: var(--td-font-white-1);
      }
    }
  }
  .menu::-webkit-scrollbar {
    width: 4px;
  }
  .menu::-webkit-scrollbar-thumb {
    background-color: var(--td-scrollbar-color, #d5d5d5);
    border-radius: 4px;
    &:hover {
      background-color: var(--td-scrollbar-hover-color, #bbb);
    }
  }
  .menu::-webkit-scrollbar-track {
    background-color: transparent;
  }
  .view {
    flex: 1;
    min-width: 0;
    min-height: 0;
    margin-left: 16px;
    background-color: var(--page);
    border-radius: 16px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    padding-left: 32px;
    padding-right: 32px;
    .topMenu {
      flex-shrink: 0;
      min-height: 50px;
      height: auto;
      flex-wrap: wrap;
      justify-content: flex-start;
      align-items: center;
      gap: 8px 12px;
      .title {
        flex-shrink: 0;
      }
      .businessNav {
        flex: 1 1 auto;
        min-width: 0;
        flex-wrap: wrap;
        justify-content: flex-start;
        gap: 4px;
        .item {
          display: flex;
          align-items: center;
          justify-content: flex-start;
          cursor: pointer;
          margin: 0;
          width: auto;
          min-height: 36px;
          height: auto;
          padding: 6px 10px;
          gap: 6px;
          border: 0;
          background: transparent;
          color: inherit;
          font: inherit;
          border-radius: 12px;
          &:hover {
            background-color: var(--td-bg-color-container-hover);
          }
          &:focus-visible {
            outline: 2px solid var(--td-brand-color);
            outline-offset: 2px;
          }
          &.active {
            background-color: var(--td-brand-color) !important;
            color: var(--td-font-white-1);
          }
          .label {
            display: inline;
            max-width: none;
            font-size: 13px;
          }
        }
        .divider {
          width: 1px;
          height: 24px;
          background-color: var(--td-border-level-1-color);
          margin: 0 4px;
        }
      }
    }
    /* 中文注释：只有内容区滚动，body/主壳不再叠一层。 */
    .viewBox {
      flex: 1 1 auto;
      min-height: 0;
      width: 100%;
      overflow: auto;
    }
  }
}

.divider {
  width: 100%;
  height: 1px;
  background-color: var(--td-border-level-1-color);
  margin: 8px 0;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* 减少动态时关闭侧栏宽度过渡与位移动画 */
@media (prefers-reduced-motion: reduce) {
  .main .menu {
    transition: none;
  }
}
</style>
