<template>
  <section class="tapcanvas-host" data-tapcanvas-host>
    <div v-if="loading" class="tapcanvas-host__state">正在打开个人画布…</div>
    <div v-else-if="loadError" class="tapcanvas-host__state tapcanvas-host__state--error">
      <strong>画布加载失败</strong>
      <span>{{ loadError }}</span>
    </div>
    <!-- 中文注释：直接加载随安装包发布的同源 TapCanvas 子应用，不允许指向外部站点。 -->
    <iframe
      v-else
      ref="iframeRef"
      class="tapcanvas-frame"
      :src="frameSrc"
      title="无限画布"
      referrerpolicy="no-referrer"
    />
  </section>
</template>

<script setup lang="ts">
import { closeCanvasProject, openCanvasProject } from "@/features/tianjiang/canvas/api";

const props = defineProps<{
  projectUuid?: string;
}>();

const router = useRouter();
const iframeRef = ref<HTMLIFrameElement | null>(null);
const loading = ref(Boolean(props.projectUuid));
const loadError = ref("");
let requestGeneration = 0;
let activeRuntime: { projectUuid: string; runtimeGeneration: number } | null = null;
let closingRuntime: {
  runtime: { projectUuid: string; runtimeGeneration: number };
  promise: Promise<void>;
} | null = null;

const frameSrc = computed(() => {
  if (props.projectUuid) {
    return `/tapcanvas/studio?projectId=${encodeURIComponent(props.projectUuid)}&tjHost=1`;
  }
  return "/tapcanvas/index.html?tjHost=1";
});

async function closeActiveRuntime(): Promise<void> {
  const runtime = activeRuntime;
  if (!runtime) return;
  if (
    closingRuntime
    && closingRuntime.runtime.projectUuid === runtime.projectUuid
    && closingRuntime.runtime.runtimeGeneration === runtime.runtimeGeneration
  ) {
    return closingRuntime.promise;
  }
  const promise = closeCanvasProject(runtime.projectUuid, runtime.runtimeGeneration).then(() => {
    if (activeRuntime === runtime) activeRuntime = null;
  });
  closingRuntime = { runtime, promise };
  try {
    await promise;
  } finally {
    if (closingRuntime?.promise === promise) closingRuntime = null;
  }
}

watch(
  () => props.projectUuid,
  async (projectUuid) => {
    const currentRequest = ++requestGeneration;
    loading.value = Boolean(projectUuid);
    loadError.value = "";
    try {
      await closeActiveRuntime();
    } catch (error) {
      // 中文注释：旧运行时关闭失败时禁止继续打开新项目，并保留原代次供卸载时重试。
      if (currentRequest === requestGeneration) {
        loadError.value = error instanceof Error ? error.message : "关闭项目运行时失败";
        loading.value = false;
      }
      return;
    }
    // 中文注释：旧请求完成时不得改写新请求的加载状态，否则会提前挂载尚未打开运行时的 iframe。
    if (currentRequest !== requestGeneration) return;
    if (!projectUuid) {
      loading.value = false;
      return;
    }
    try {
      const opened = await openCanvasProject(projectUuid);
      if (currentRequest !== requestGeneration) {
        await closeCanvasProject(opened.projectUuid, opened.runtimeGeneration).catch(() => undefined);
        return;
      }
      activeRuntime = opened;
      loading.value = false;
    } catch (error) {
      if (currentRequest !== requestGeneration) return;
      loadError.value = error instanceof Error ? error.message : "项目不存在或不可见";
      loading.value = false;
    }
  },
  { immediate: true },
);

function onHostNavigation(event: MessageEvent): void {
  if (event.origin !== window.location.origin || event.source !== iframeRef.value?.contentWindow) return;
  const data = event.data && typeof event.data === "object"
    ? event.data as Record<string, unknown>
    : null;
  if (data?.type !== "tianjiang:tapcanvas:navigate") return;
  const navigate = data.replace === true ? router.replace : router.push;
  if (data.destination === "home") {
    void navigate("/infinite-canvas");
    return;
  }
  const projectUuid = typeof data.projectUuid === "string" ? data.projectUuid.trim() : "";
  // 中文注释：只接受标准 UUID 结构，禁止由 iframe 注入任意宿主路由片段。
  if (data.destination !== "studio" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(projectUuid)) return;
  void navigate(`/infinite-canvas/${encodeURIComponent(projectUuid)}`);
}

onMounted(() => window.addEventListener("message", onHostNavigation));
onBeforeUnmount(() => {
  requestGeneration += 1;
  window.removeEventListener("message", onHostNavigation);
  void closeActiveRuntime().catch(() => undefined);
});
</script>

<style scoped>
.tapcanvas-host {
  display: flex;
  width: 100%;
  height: 100%;
  min-height: 0;
  background: #1a1b1e;
}
.tapcanvas-frame {
  flex: 1;
  width: 100%;
  height: 100%;
  border: 0;
  background: #1a1b1e;
}
.tapcanvas-host__state {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #c8c9cc;
}
.tapcanvas-host__state--error {
  color: #ff7b7b;
}
</style>
