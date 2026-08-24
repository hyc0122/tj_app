<template>
  <section class="settings-page">
    <header>
      <div>
        <h2>设置</h2>
        <p>个人模型、供应商、主题、语言和客户端参数仅同步到当前账号。</p>
      </div>
      <t-button variant="outline" :loading="retrying" @click="retryProfileSync">重试同步</t-button>
    </header>

    <div class="sync-grid">
      <div><span>配置版本</span><strong>{{ syncStatus.version }}</strong></div>
      <div><span>同步状态</span><strong>{{ statusLabel }}</strong></div>
      <div><span>最后成功</span><strong>{{ syncStatus.lastSuccessAt || "尚未成功同步" }}</strong></div>
      <div><span>失败原因</span><strong>{{ syncStatus.failureMessage || "无" }}</strong></div>
    </div>

    <div class="settings-content">
      <setting-panel />
    </div>
  </section>
</template>

<script setup lang="ts">
import settingPanel from "@/components/setting/index.vue";
import settingStore from "@/stores/setting";
import axios from "@/utils/axios";

interface SyncStatus {
  state: string;
  version: number;
  lastSuccessAt?: string | null;
  failureCode?: string | null;
  failureMessage?: string | null;
  retryable?: boolean;
}

const retrying = ref(false);
const syncStatus = reactive<SyncStatus>({ state: "idle", version: 0 });
const statusLabel = computed(() => {
  const map: Record<string, string> = {
    idle: "等待同步",
    syncing: "同步中",
    synced: "已同步",
    failed: "同步失败",
  };
  return map[syncStatus.state] ?? syncStatus.state;
});

async function loadProfileSyncStatus(): Promise<void> {
  try {
    const response = await axios.get("/tianjiang/runtime/profile-sync/status");
    const data = response?.data ?? response;
    Object.assign(syncStatus, {
      state: data.state ?? "idle",
      version: Number(data.version ?? 0),
      lastSuccessAt: data.lastSuccessAt,
      failureCode: data.failureCode,
      failureMessage: data.failureMessage,
      retryable: data.retryable === true,
    });
  } catch (error) {
    syncStatus.state = "failed";
    syncStatus.failureMessage = error instanceof Error ? error.message : "个人配置同步失败";
  }
}

async function retryProfileSync(): Promise<void> {
  retrying.value = true;
  syncStatus.state = "syncing";
  try {
    await axios.post("/tianjiang/runtime/profile-sync/retry");
    await loadProfileSyncStatus();
  } catch (error) {
    syncStatus.state = "failed";
    syncStatus.failureMessage = error instanceof Error ? error.message : "个人配置同步失败";
  } finally {
    retrying.value = false;
  }
}

const settings = settingStore();
watch(
  () => [settings.themeSetting, settings.language, settings.otherSetting],
  () => window.dispatchEvent(new CustomEvent("tianjiang:profile-setting-changed")),
  { deep: true },
);

onMounted(() => {
  void loadProfileSyncStatus();
});
</script>

<style scoped lang="scss">
.settings-page {
  height: 100%;
  padding: 20px 0;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.sync-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 16px;
  div {
    padding: 12px;
    border-radius: 10px;
    background: var(--td-bg-color-secondarycontainer);
    display: flex;
    flex-direction: column;
    gap: 6px;
    span {
      color: var(--td-text-color-secondary);
      font-size: 12px;
    }
  }
}
.settings-content {
  min-height: 0;
}
</style>
