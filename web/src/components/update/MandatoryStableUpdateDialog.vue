<template>
  <t-dialog
    :visible="stableRequired"
    :header="$t('login.stableUpdateTitle')"
    :close-btn="false"
    :close-on-esc-keydown="false"
    :close-on-overlay-click="false"
    :confirm-btn="null"
    :cancel-btn="null"
    :destroy-on-close="false"
    width="600px"
  >
    <section class="mandatory-update" role="alertdialog" aria-modal="true">
      <h2>{{ $t("login.stableUpdateRequired") }}</h2>
      <p>
        {{ $t("settings.about.currentVersion") }}：v{{ snapshot.currentVersion || "-" }}
      </p>
      <p>
        {{ $t("settings.about.latestVersionLabel") }}：v{{ snapshot.stable.latestVersion || "-" }}
      </p>
      <p v-if="formattedPackageSize">安装包大小：{{ formattedPackageSize }}</p>
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
      <p v-if="snapshot.state === 'downloaded'">安装包下载完成，请退出并安装。</p>
      <p v-if="snapshot.state === 'preparing_install'">安装请求已受理，正在安全关闭本地服务。</p>
      <p v-if="snapshot.state === 'installing'">安装程序已启动，请完成安装。</p>
      <p v-if="actionMessage" class="success" role="status">{{ actionMessage }}</p>
      <p v-if="actionError || snapshot.errorMessage" class="error" role="alert">
        {{ actionError || snapshot.errorMessage }}
      </p>
    </section>

    <template #footer>
      <div class="mandatory-actions">
        <template v-if="snapshot.state !== 'downloading' && snapshot.state !== 'downloaded' && snapshot.state !== 'preparing_install' && snapshot.state !== 'installing'">
          <t-button
            theme="primary"
            :loading="busy"
            :disabled="busy || !snapshot.stable.downloadAllowed"
            @click="download('download-differential', 'stable')"
          >
            更新正式版
          </t-button>
          <t-button
            variant="outline"
            :disabled="busy || !snapshot.stable.downloadAllowed"
            @click="download('download-full', 'stable')"
          >
            下载完整安装包
          </t-button>
        </template>
        <t-button
          v-if="snapshot.state === 'downloading'"
          variant="outline"
          :disabled="busy"
          @click="runLocalAction('cancel-download')"
        >
          取消下载
        </t-button>
        <t-button
          v-if="snapshot.state === 'downloaded'"
          theme="primary"
          :loading="busy"
          :disabled="busy"
          @click="runLocalAction('install')"
        >
          退出并安装
        </t-button>
      </div>
    </template>
  </t-dialog>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { storeToRefs } from "pinia";
import tianjiangUpdateStore from "@/stores/tianjiangUpdate";

const updateStore = tianjiangUpdateStore();
const { snapshot, busy, actionMessage, actionError, stableRequired } = storeToRefs(updateStore);
const { download, runLocalAction } = updateStore;

const formattedPackageSize = computed(() => {
  const bytes = snapshot.value.stable.packageSizeBytes;
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const megabytes = bytes / 1024 / 1024;
  return `${Number(megabytes.toFixed(megabytes >= 10 ? 1 : 2))} MB`;
});

const progressPercent = computed(() => Math.max(0, Math.min(100, Number(snapshot.value.progress ?? 0))));

function formatBytes(value: unknown): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB"];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${Number(size.toFixed(size >= 10 ? 1 : 2))} ${units[unit]}`;
}

const progressDetails = computed(() => {
  const transferred = formatBytes(snapshot.value.transferredBytes);
  const total = formatBytes(snapshot.value.totalBytes);
  const speed = formatBytes(snapshot.value.bytesPerSecond);
  const amount = transferred && total ? `${transferred} / ${total}` : "";
  return [amount, speed ? `${speed}/s` : ""].filter(Boolean).join(" · ");
});
</script>

<style lang="scss" scoped>
.mandatory-update {
  line-height: 1.7;

  h2 {
    margin: 0 0 16px;
    color: var(--td-error-color);
  }
}

.mandatory-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}

.success {
  color: var(--td-success-color);
}

.error {
  color: var(--td-error-color);
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

.download-progress-panel p {
  margin: 8px 0 0;
}
</style>
