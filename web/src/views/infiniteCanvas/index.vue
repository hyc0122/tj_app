<template>
  <section class="canvas-home">
    <h1>{{ greeting }}</h1>
    <input v-model="keyword" placeholder="搜索画布" />
    <button type="button" @click="showCreate = true">新建画布</button>
    <CanvasHomeComposer :project-uuid="homeDraftUuid" :port="homePort" />
    <div v-if="filtered.length === 0">还没有画布</div>
    <CanvasProjectCard
      v-for="item in filtered"
      :key="item.projectUuid"
      :project="item"
      @open="open"
    />
    <CreateCanvasDialog v-model="showCreate" @create="create" />
  </section>
</template>

<script setup lang="ts">
import axios from "@/utils/axios";
import {
  canonicalizeJcs,
  createCanvasHomePlanningPort,
  sha256HexUtf8,
  type CanvasHomePlanningPort,
} from "@/features/tianjiang/canvas/api";
import { createPersonalCanvasRequest } from "@/features/tianjiang/canvas/project-lifecycle";
import { canvasEditorPath, type CanvasStarterKind } from "@/features/tianjiang/canvas/navigation";
import CanvasHomeComposer from "./components/CanvasHomeComposer.vue";
import CanvasProjectCard from "./components/CanvasProjectCard.vue";
import CreateCanvasDialog from "./components/CreateCanvasDialog.vue";

const router = useRouter();
const keyword = ref("");
const showCreate = ref(false);
const projects = ref<Array<{ projectUuid: string; name: string; businessType?: string }>>([]);
const nickname = ref("");
const username = ref("用户");
const homeDraftUuid = crypto.randomUUID();

const greeting = computed(() => `你好，${nickname.value.trim() || username.value}`);
const filtered = computed(() => projects.value.filter((item) => {
  if (item.businessType && item.businessType !== "canvas") return false;
  return item.name.includes(keyword.value.trim());
}));

async function load(): Promise<void> {
  const { data } = await axios.get("/tianjiang/runtime/projects").catch(() => ({ data: [] }));
  const rows = Array.isArray(data) ? data : Array.isArray((data as { data?: unknown }).data)
    ? (data as { data: unknown[] }).data
    : [];
  projects.value = rows as Array<{ projectUuid: string; name: string; businessType?: string }>;
}

async function applyHomePlanAndOpen(prompt: string): Promise<void> {
  const body = createPersonalCanvasRequest({ name: prompt.slice(0, 40) || "未命名画布" });
  const { data } = await axios.post("/tianjiang/v1/projects", body);
  const uuid = String((data as { projectUuid?: string })?.projectUuid ?? (data as { data?: { projectUuid?: string } })?.data?.projectUuid ?? "");
  if (!uuid) return;
  const clientChatRequestId = crypto.randomUUID();
  const requestDigest = await sha256HexUtf8(canonicalizeJcs({
    prompt,
    baseRevision: 0,
    clientChatRequestId,
  }));
  const port = createCanvasHomePlanningPort();
  await port.plan(uuid, {
    prompt,
    baseRevision: 0,
    clientChatRequestId,
    requestDigest,
    attachmentAssetUuids: [],
  });
  await router.push(canvasEditorPath(uuid));
}

const homePort: CanvasHomePlanningPort = {
  async plan(_projectUuid, input) {
    await applyHomePlanAndOpen(input.prompt);
  },
};

async function create(input: { name: string; starter: CanvasStarterKind }): Promise<void> {
  const body = createPersonalCanvasRequest({ name: input.name });
  const { data } = await axios.post("/tianjiang/v1/projects", body);
  const uuid = String((data as { projectUuid?: string })?.projectUuid ?? (data as { data?: { projectUuid?: string } })?.data?.projectUuid ?? "");
  if (!uuid) return;
  await router.push({ path: canvasEditorPath(uuid), query: { starter: input.starter } });
}

function open(projectUuid: string): void {
  void router.push(canvasEditorPath(projectUuid));
}

onMounted(load);
</script>
