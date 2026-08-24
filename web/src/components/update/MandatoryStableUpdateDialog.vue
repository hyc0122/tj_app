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
      <p v-if="snapshot.state === 'downloading'">
        下载进度：{{ snapshot.progress ?? 0 }}%
      </p>
      <p v-if="snapshot.state === 'downloaded'">安装包下载完成，请退出并安装。</p>
      <p v-if="snapshot.state === 'installing'">安装程序已启动，请完成安装。</p>
      <p v-if="actionMessage" class="success" role="status">{{ actionMessage }}</p>
      <p v-if="actionError || snapshot.errorMessage" class="error" role="alert">
        {{ actionError || snapshot.errorMessage }}
      </p>
    </section>

    <template #footer>
      <div class="mandatory-actions">
        <template v-if="snapshot.state !== 'downloaded' && snapshot.state !== 'installing'">
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
</style>
