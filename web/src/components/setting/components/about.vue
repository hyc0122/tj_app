<template>
  <div class="about">
    <t-card bordered :style="{ width: '100%' }" class="logoCard module-interactive--panel">
      <div class="f">
        <img src="@/assets/logo.png" alt="天将漫创 Logo" class="logo" />
        <div class="appName">
          <div class="name">天将漫创</div>
          <div class="data">{{ $t("settings.about.slogan") }}</div>
          <div class="version">
            <t-tag theme="primary" shape="round" size="small" style="padding: 10px">v{{ version }}</t-tag>
          </div>
        </div>
        <div class="renew ac">
          <t-badge :count="needUpdate ? 1 : 0" dot :offset="[-4, -4]">
            <t-button theme="primary" :loading="busy" :disabled="busy" @click="checkUpdate">
              <template #icon><i-refresh theme="outline" size="18" /></template>
              <span style="margin-left: 5px">{{ $t("settings.about.checkUpdate") }}</span>
            </t-button>
          </t-badge>
        </div>
      </div>
    </t-card>

    <div class="channel-grid">
      <t-card bordered class="channel-card">
        <div class="channel-title">
          <strong>正式版 Stable</strong>
          <t-tag :theme="snapshot.stable.required ? 'danger' : 'primary'">
            {{ snapshot.stable.required ? "强制更新" : channelStatus(snapshot.stable.status) }}
          </t-tag>
        </div>
        <p>当前版本：v{{ snapshot.currentVersion || version }}</p>
        <p>正式版版本：v{{ snapshot.stable.latestVersion || "-" }}</p>
        <p v-if="snapshot.stable.packageSizeBytes">
          安装包大小：{{ formatPackageSize(snapshot.stable.packageSizeBytes) }}
        </p>
        <p v-if="snapshot.stable.errorCode" class="error">
          {{ channelErrorMessage(snapshot.stable.errorCode) }}
        </p>
        <t-button
          theme="primary"
          :loading="busy && snapshot.selectedChannel === 'stable'"
          :disabled="updateLocked || !snapshot.stable.downloadAllowed"
          @click="downloadChannel('stable')"
        >
          更新正式版
        </t-button>
        <t-button
          variant="outline"
          :disabled="updateLocked || !snapshot.stable.downloadAllowed"
          @click="downloadChannel('stable', 'download-full')"
        >
          正式版完整包
        </t-button>
      </t-card>

      <t-card bordered class="channel-card">
        <div class="channel-title">
          <strong>测试版 Beta</strong>
          <t-tag theme="warning">可选更新</t-tag>
        </div>
        <p>当前版本：v{{ snapshot.currentVersion || version }}</p>
        <p>测试版版本：v{{ snapshot.beta.latestVersion || "-" }}</p>
        <p v-if="snapshot.beta.sourceChannel === 'stable'">当前 Beta 通道指向正式版</p>
        <p v-if="snapshot.beta.packageSizeBytes">
          安装包大小：{{ formatPackageSize(snapshot.beta.packageSizeBytes) }}
        </p>
        <p v-if="snapshot.beta.errorCode" class="error">
          {{ channelErrorMessage(snapshot.beta.errorCode) }}
        </p>
        <t-button
          theme="primary"
          :loading="busy && snapshot.selectedChannel === 'beta'"
          :disabled="updateLocked || snapshot.stableRequired || !snapshot.beta.downloadAllowed"
          @click="downloadChannel('beta')"
        >
          更新测试版
        </t-button>
        <t-button
          variant="outline"
          :disabled="updateLocked || snapshot.stableRequired || !snapshot.beta.downloadAllowed"
          @click="downloadChannel('beta', 'download-full')"
        >
          测试版完整包
        </t-button>
      </t-card>
    </div>

    <div class="operation-status" aria-live="polite">
      <div v-if="snapshot.state === 'downloading'" class="download-progress-panel">
        <div
          class="download-progress-track"
          role="progressbar"
          aria-label="更新下载进度"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="progressPercent"
        >
          <div class="download-progress-value" :style="{ width: `${progressPercent}%` }" />
        </div>
        <p>下载进度：{{ progressPercent }}%</p>
        <p v-if="progressDetails">{{ progressDetails }}</p>
      </div>
      <p v-if="actionMessage" class="success">{{ actionMessage }}</p>
      <p v-if="actionError || snapshot.errorMessage" class="error" role="alert">
        {{ actionError || snapshot.errorMessage }}
      </p>
      <p v-if="snapshot.state === 'preparing_install'">安装请求已受理，正在安全关闭本地服务。</p>
      <div v-if="snapshot.state === 'downloaded'" class="downloaded-actions">
        <t-button theme="primary" :disabled="busy" @click="runAction('install')">
          退出并安装
        </t-button>
        <t-button variant="outline" :disabled="busy" @click="runAction('show-file')">
          打开安装包位置
        </t-button>
      </div>
      <div v-if="snapshot.state === 'downloading'" class="downloaded-actions">
        <t-button variant="outline" :disabled="busy" @click="runAction('cancel-download')">
          取消下载
        </t-button>
      </div>
    </div>

    <t-dialog
      v-model:visible="updateDialogVisible"
      :header="$t('settings.about.checkUpdate')"
      :confirm-btn="null"
      :cancel-btn="null"
      width="560px"
    >
      <div class="updateDialog">
        <p>当前版本：v{{ snapshot.currentVersion || version }}</p>
        <p v-if="snapshot.latestVersion">最新版本：v{{ snapshot.latestVersion }}</p>
        <p v-if="formattedPackageSize">安装包大小：{{ formattedPackageSize }}</p>
        <p v-if="snapshot.releaseNotes" class="notes">{{ snapshot.releaseNotes }}</p>
        <div v-if="snapshot.state === 'downloading'" class="download-progress-panel">
          <div
            class="download-progress-track"
            role="progressbar"
            aria-label="更新下载进度"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuenow="progressPercent"
          >
            <div class="download-progress-value" :style="{ width: `${progressPercent}%` }" />
          </div>
          <p>下载进度：{{ progressPercent }}%</p>
          <p v-if="progressDetails">{{ progressDetails }}</p>
        </div>
        <p v-if="snapshot.state === 'error'" class="error">
          {{ actionError || snapshot.errorMessage }}
        </p>
        <p v-if="snapshot.state === 'available'">发现可用更新，请在对应通道卡片中选择更新。</p>
        <p v-if="snapshot.state === 'downloaded'">下载完成，可退出并安装或打开安装包位置。</p>
        <p v-if="snapshot.state === 'preparing_install'">安装请求已受理，正在安全关闭本地服务。</p>
      </div>
      <template #footer>
        <div class="footer-actions">
          <t-button variant="outline" :disabled="busy" @click="updateDialogVisible = false">
            {{ snapshot.state === "downloaded" ? "稍后安装" : "稍后" }}
          </t-button>
          <t-button
            v-if="snapshot.state === 'idle' || snapshot.state === 'checking' || snapshot.state === 'error'"
            theme="primary"
            :loading="busy"
            :disabled="busy"
            @click="runAction('check')"
          >
            {{ $t("settings.about.checkUpdate") }}
          </t-button>
        </div>
      </template>
    </t-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import axios from "@/utils/axios";
import store from "@/stores/index";
import settingStore from "@/stores/setting";
import tianjiangUpdateStore from "@/stores/tianjiangUpdate";
import type {
  TianjiangDownloadAction,
  TianjiangUpdateChannel,
} from "@/api/tianjiang/update";

const { version } = storeToRefs(store());
const { needUpdate } = storeToRefs(settingStore());
const updateStore = tianjiangUpdateStore();
const { snapshot, busy, actionMessage, actionError } = storeToRefs(updateStore);
const updateDialogVisible = ref(false);

const formattedPackageSize = computed(() => {
  const selected = snapshot.value.selectedChannel
    ? snapshot.value[snapshot.value.selectedChannel].packageSizeBytes
    : undefined;
  return formatPackageSize(selected ?? snapshot.value.packageSizeBytes);
});

const progressPercent = computed(() => Math.max(0, Math.min(100, Number(snapshot.value.progress ?? 0))));

const progressDetails = computed(() => {
  const transferred = formatPackageSize(snapshot.value.transferredBytes);
  const total = formatPackageSize(snapshot.value.totalBytes);
  const speed = formatPackageSize(snapshot.value.bytesPerSecond);
  const amount = transferred && total ? `${transferred} / ${total}` : "";
  return [amount, speed ? `${speed}/s` : ""].filter(Boolean).join(" · ");
});

/** 字节格式化只负责展示，不参与更新候选或版本裁定。 */
function formatPackageSize(value: unknown): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${Number(size.toFixed(size >= 10 ? 1 : 2))} ${units[unitIndex]}`;
}

function channelStatus(status: string): string {
  const labels: Record<string, string> = {
    idle: "未检查",
    unsupported: "不支持",
    checking: "检查中",
    available: "可更新",
    current: "已是最新",
    error: "检查失败",
  };
  return labels[status] ?? status;
}

const CHANNEL_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  CATALOG_UNAVAILABLE: "更新目录暂不可用，请稍后重试",
  CATALOG_STALE_CACHE: "远端检查失败，当前显示本地缓存结果",
  NETWORK_ERROR: "网络连接异常，请稍后重试",
  PLATFORM_UNSUPPORTED: "当前设备暂不支持自动更新",
  UPDATE_SERVICE_NOT_READY: "更新服务尚未就绪，请稍后重试",
};

/** 中文注释：内部错误码留在快照中供诊断使用，用户界面只展示稳定中文分类。 */
function channelErrorMessage(errorCode: string): string {
  return CHANNEL_ERROR_MESSAGES[errorCode] ?? "更新检查失败，请稍后重试";
}

function checkUpdate(): void {
  updateDialogVisible.value = true;
  void runAction("check");
}

const updateLocked = computed(() => busy.value || ["downloading", "installing"].includes(snapshot.value.state));

async function runAction(action: "check" | "cancel-download" | "install" | "show-file"): Promise<void> {
  if (action === "check") {
    await updateStore.check();
    return;
  }
  await updateStore.runLocalAction(action);
}

async function downloadChannel(
  channel: TianjiangUpdateChannel,
  action: TianjiangDownloadAction = "download-differential",
): Promise<void> {
  // 中文注释：页面只提交枚举动作与通道，禁止拼接 URL 或在 renderer 比较版本。
  await updateStore.download(action, channel);
}

watch(
  snapshot,
  (next) => {
    needUpdate.value = next.state === "available" || next.state === "downloaded";
  },
  { deep: true, immediate: true },
);

onMounted(async () => {
  try {
    const { data } = await axios.get("/other/getVersion");
    version.value = data;
  } catch {
    // 本机版本读取失败不影响用户重试双通道检查。
  }
});
</script>

<style lang="scss" scoped>
.about {
  .logoCard {
    margin-bottom: 16px;
  }

  .logo {
    width: 72px;
    height: 72px;
    object-fit: contain;
  }

  .appName {
    margin-left: 16px;
    flex: 1;

    .name {
      font-size: 20px;
      font-weight: 700;
    }
  }
}

.channel-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.channel-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.operation-status {
  margin-top: 16px;
}

.downloaded-actions,
.footer-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

.success {
  color: var(--td-success-color);
}

.error {
  color: var(--td-error-color);
}

.notes {
  white-space: pre-wrap;
}

.download-progress-track {
  height: 10px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--td-bg-color-component);
}

.download-progress-value {
  height: 100%;
  border-radius: inherit;
  background: var(--td-brand-color);
  transition: width 0.2s ease;
}

@media (max-width: 900px) {
  .channel-grid {
    grid-template-columns: 1fr;
  }
}
</style>
