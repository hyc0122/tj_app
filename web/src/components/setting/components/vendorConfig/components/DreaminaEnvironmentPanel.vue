<template>
  <section class="dreaminaEnvironmentPanel" data-section="environment">
    <header class="cardHeader">
      <div>
        <span class="cardHeader__kicker">ENVIRONMENT</span>
        <h4>{{ $t("settings.dreaminaCli.environment") }}</h4>
      </div>
      <t-button
        size="small"
        variant="text"
        data-action="environment-recheck"
        :loading="loading"
        @click="loadEnvironment"
      >
        <template #icon><t-icon name="refresh" /></template>
        重新检测
      </t-button>
    </header>

    <div v-if="loading && dependencies.length === 0" class="environmentSkeleton" aria-label="正在检测环境">
      <i v-for="index in 3" :key="index" />
    </div>
    <div v-else-if="errorMessage" class="environmentError" role="alert">
      <t-icon name="error-circle" />
      <div><strong>环境检测失败</strong><p>{{ errorMessage }}</p></div>
    </div>
    <div v-else class="dependencyList">
      <article v-for="item in dependencies" :key="item.id" class="dependencyItem">
        <span :class="['dependencyItem__icon', item.installed && item.compatible ? 'is-ready' : 'is-missing']">
          <t-icon :name="item.installed && item.compatible ? 'check' : 'close'" />
        </span>
        <div class="dependencyItem__body">
          <div class="dependencyItem__title">
            <strong>{{ item.label }}</strong>
            <span>{{ item.required ? "必需" : "可选" }}</span>
          </div>
          <p>{{ dependencyDescription(item) }}</p>
          <code v-if="item.path">{{ item.path }}</code>
        </div>
        <span :class="['stateBadge', item.installed && item.compatible ? 'statusDot--success' : 'statusDot--neutral']">
          {{ item.installed ? (item.compatible ? "可用" : "不兼容") : "未安装" }}
        </span>
      </article>
      <div v-if="dependencies.length === 0" class="emptyState emptyState--compact">
        <t-icon name="desktop" />
        <strong>尚无环境结果</strong>
        <p>点击重新检测读取当前设备状态。</p>
      </div>
    </div>

    <div v-if="missingLinux || suggestWsl" class="environmentNotice">
      <t-icon name="info-circle" />
      <span v-if="suggestWsl">仅在 Windows 原生明确不兼容时建议 WSL；客户端不会自动安装。</span>
      <span v-else>当前批准清单没有 Linux 发行物，Windows 原生安装不受影响。</span>
    </div>
  </section>
</template>

<script setup lang="ts">
import axios from "@/utils/axios";

interface Dependency {
  id: string;
  label: string;
  required: boolean;
  installed: boolean;
  compatible: boolean;
  version?: string;
  path?: string;
  reason?: string;
}

const dependencies = ref<Dependency[]>([]);
const missingLinux = ref(false);
const suggestWsl = ref(false);
const loading = ref(false);
const errorMessage = ref("");

function unwrapData<T>(payload: unknown): T {
  if (!payload || typeof payload !== "object") return {} as T;
  const record = payload as { data?: T } & T;
  return (record.data ?? record) as T;
}

function dependencyDescription(item: Dependency): string {
  if (item.reason) return item.reason;
  if (item.version) return `版本 ${item.version}`;
  return item.installed ? "已检测到可用环境" : "等待安装或配置";
}

function errorText(error: unknown): string {
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return String((error as { message: string }).message);
  }
  return "无法读取当前设备环境";
}

async function loadEnvironment() {
  if (loading.value) return;
  loading.value = true;
  errorMessage.value = "";
  try {
    // 中文注释：环境检测只读本机状态，不下载 CLI，也不安装 WSL。
    const payload = unwrapData<{ dependencies?: Dependency[]; linuxReleaseAvailable?: boolean; suggestWsl?: boolean }>(
      await axios.get("/setting/dreaminaCli/getEnvironment"),
    );
    dependencies.value = payload.dependencies ?? [];
    missingLinux.value = payload.linuxReleaseAvailable === false;
    suggestWsl.value = payload.suggestWsl === true;
  } catch (error) {
    errorMessage.value = errorText(error);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void loadEnvironment();
});
</script>
