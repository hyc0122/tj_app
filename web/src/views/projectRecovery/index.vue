<template>
  <section class="recovery-page">
    <h2>{{ $t("projectCatalog.recoveryAvailable") }}</h2>
    <t-loading :loading="loading">
      <div v-for="item in pending" :key="item.recoveryId" class="recovery-item">
        <span>{{ item.createdAt }} · {{ item.reason }}</span>
        <t-button @click="keep(item.recoveryId)">
          {{ $t("projectCatalog.recoveryAction") }}
        </t-button>
      </div>
    </t-loading>
  </section>
</template>

<script setup lang="ts">
import {
  fetchProjectRecoveries,
  keepProjectRecovery,
  type ProjectRecovery,
} from "@/features/tianjiang/project/catalog";
import projectStore from "@/stores/project";

const router = useRouter();
const store = projectStore();
const { access, project } = storeToRefs(store);
const loading = ref(false);
const recoveries = ref<ProjectRecovery[]>([]);
const pending = computed(() => recoveries.value.filter((item) => !item.resolved));

async function load(): Promise<void> {
  if (!access.value.projectUuid) return;
  loading.value = true;
  try {
    recoveries.value = await fetchProjectRecoveries(access.value.projectUuid);
  } finally {
    loading.value = false;
  }
}

async function keep(recoveryId: string): Promise<void> {
  await keepProjectRecovery(access.value.projectUuid, recoveryId);
  await load();
  if (!pending.value.length && project.value) {
    // 恢复副本保留后先以只读进入；下一次状态轮询确认锁有效才重新开放写入。
    store.setAccessMode("readonly", "recovery_kept");
    await router.push(`/${project.value.projectType}`);
  }
}

onMounted(load);
</script>

<style scoped>
.recovery-page {
  padding: 20px;
}
.recovery-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  margin-top: 12px;
  border: 1px solid var(--td-component-border);
  border-radius: 8px;
}
</style>
