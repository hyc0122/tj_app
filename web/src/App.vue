<template>
  <titleBar v-if="isElectron" />
  <t-config-provider :global-config="globalConfig">
    <main v-if="runtimeStartupError" class="startup-error-page">
      <section class="startup-error-card" role="alert">
        <h1>本地服务启动失败</h1>
        <p class="startup-error-message">{{ runtimeStartupError.message }}</p>
        <p class="startup-error-help">
          运行组件由官方安装程序统一部署，不需要手工下载运行库，也不需要以管理员身份启动应用。
        </p>
        <dl>
          <div>
            <dt>诊断代码</dt>
            <dd>{{ runtimeStartupError.code }}</dd>
          </div>
          <div v-if="runtimeStartupError.logPath">
            <dt>诊断日志</dt>
            <dd>{{ runtimeStartupError.logPath }}</dd>
          </div>
        </dl>
        <div class="startup-error-actions">
          <t-button theme="primary" @click="restartApplication">重新启动应用</t-button>
          <t-button
            v-if="runtimeStartupError.logPath"
            variant="outline"
            @click="openStartupLog"
          >
            打开诊断日志
          </t-button>
        </div>
      </section>
    </main>
    <router-view v-else></router-view>
    <SyncProgressOverlay
      v-if="syncProgress"
      :progress="syncProgress"
      @return="dismissFailedProgress"
    />
    <MandatoryStableUpdateDialog />
  </t-config-provider>
</template>

<script setup lang="ts">
import settingStore from "@/stores/setting";
import { merge } from "lodash";
import zhConfig from "tdesign-vue-next/es/locale/zh_CN";
import enConfig from "tdesign-vue-next/es/locale/en_US";
import { cachedLocale, languageList } from "@/locales";
import { initTheme } from "@/utils/theme";
import { type GlobalConfigProvider } from "tdesign-vue-next";
import { useI18n } from "vue-i18n";
import SyncProgressOverlay from "@/components/tianjiang/SyncProgressOverlay.vue";
import MandatoryStableUpdateDialog from "@/components/update/MandatoryStableUpdateDialog.vue";
import type { SyncProgressSnapshot } from "@/features/tianjiang/sync/progress";
import { onMounted, onUnmounted, ref } from "vue";

const { locale } = useI18n();
const { isElectron, runtimeStartupError } = storeToRefs(settingStore());
import { config } from "md-editor-v3";

const syncProgress = ref<SyncProgressSnapshot | null>(null);
let progressTimer: ReturnType<typeof setInterval> | undefined;

async function pollSyncProgress(): Promise<void> {
  try {
    const response = await fetch("/api/tianjiang/runtime/sync-progress", {
      credentials: "include",
    });
    if (!response.ok) return;
    const body = await response.json();
    const data = body?.data as SyncProgressSnapshot | undefined;
    if (!data) return;
    if (data.state === "idle" || data.state === "succeeded") {
      if (data.state === "succeeded") syncProgress.value = null;
      return;
    }
    syncProgress.value = data;
  } catch {
    // 轮询失败不打断应用
  }
}

function dismissFailedProgress(): void {
  syncProgress.value = null;
}

onMounted(() => {
  void pollSyncProgress();
  progressTimer = setInterval(() => {
    void pollSyncProgress();
  }, 400);
});

onUnmounted(() => {
  if (progressTimer) clearInterval(progressTimer);
});

watch(
  () => isElectron.value,
  (newVal) => {
    if (newVal) {
      document.body.classList.add("is-electron");
    } else {
      document.body.classList.remove("is-electron");
    }
  },
  { immediate: true },
);

onBeforeMount(() => {
  document.addEventListener("keydown", function (event) {
    if (event.key === "F8") {
      event.preventDefault();
      debugger;
    }
  });
});

async function handleLinkClick(event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();

  const target = event.currentTarget as HTMLAnchorElement | null;
  const url = target?.getAttribute("data-link") || target?.getAttribute("href");
  if (!url) return false;

  if (isElectron.value) {
    await fetch(`tianjiang://openurlwithbrowser?url=${encodeURIComponent(url)}`);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }

  return false;
}

onMounted(() => {
  (window as any).handleLinkClick = handleLinkClick;
  config({
    markdownItConfig(md) {
      // 自定义链接渲染
      const defaultRender =
        md.renderer.rules.link_open ||
        function (tokens, idx, options, env, self) {
          return self.renderToken(tokens, idx, options);
        };
      md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
        const token = tokens[idx];
        const href = token.attrGet("href");

        if (href) {
          // 添加 target="_blank" 在新窗口打开
          token.attrSet("target", "_blank");
          token.attrSet("rel", "noopener noreferrer");

          // 或者添加自定义点击事件的标识
          token.attrSet("data-link", href);
          token.attrSet("onclick", "return handleLinkClick(event)");
        }

        return defaultRender(tokens, idx, options, env, self);
      };
    },
  });

  try {
    const language = navigator.language;
    if (language && languageList.some((item) => item.value === language)) {
      cachedLocale.value = language;
      locale.value = language;
    }
  } catch (e) {
    console.error("获取语言失败", e);
  }
});

async function restartApplication(): Promise<void> {
  await fetch("tianjiang://appRestart");
}

async function openStartupLog(): Promise<void> {
  await fetch("tianjiang://openStartupLog");
}

const tdesignLocaleMap: Record<string, object> = {
  "zh-CN": zhConfig,
  en: enConfig,
};

const customConfig: GlobalConfigProvider = {
  calendar: {},
  table: {},
  pagination: {},
};
const globalConfig = computed<GlobalConfigProvider>(() => merge({}, tdesignLocaleMap[cachedLocale.value] || zhConfig, customConfig));

onBeforeMount(() => {
  initTheme();
});
</script>

<style lang="scss">
.startup-error-page {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: calc(100dvh - var(--app-titlebar-height, 42px));
  padding: 32px;
  background: var(--td-bg-color-page, #f5f5f5);
}

.startup-error-card {
  width: min(640px, 100%);
  padding: 36px;
  border-radius: 16px;
  background: var(--td-bg-color-container, #fff);
  box-shadow: var(--td-shadow-3);

  h1 {
    margin: 0 0 16px;
    color: var(--td-error-color, #d54941);
  }

  p {
    line-height: 1.7;
  }

  .startup-error-help {
    color: var(--td-text-color-secondary);
  }

  dl {
    margin: 24px 0;
  }

  dl > div {
    display: grid;
    grid-template-columns: 88px minmax(0, 1fr);
    gap: 12px;
    margin-top: 10px;
  }

  dt {
    color: var(--td-text-color-secondary);
  }

  dd {
    margin: 0;
    overflow-wrap: anywhere;
    font-family: Consolas, "Courier New", monospace;
  }
}

.startup-error-actions {
  display: flex;
  gap: 12px;
}
</style>
