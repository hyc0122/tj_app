<template>
  <section class="canvas-editor">
    <p v-if="error">{{ error }}</p>
    <CanvasTopToolbar
      :title="projectUuid"
      @save="flow.flush()"
      @layout="flow.applyLayout('flow')"
      @import-export="showImport = true"
      @history="openHistory"
      @assets="showAssets = true"
    />
    <CanvasViewport
      :nodes="nodes"
      :edges="edges"
      :viewport="viewport"
      @nodes-change="flow.onNodesChange"
      @edges-change="flow.onEdgesChange"
      @node-drag-start="flow.onNodeDragStart"
      @node-drag-stop="flow.onNodeDragStop"
      @moveend="flow.onMoveend"
      @connect="flow.connectEdge"
      @pane-context-menu="flow.openContextMenu"
      @drop-files="onDropFiles"
    />
    <CanvasStarterCards v-if="showCards" @select="applyStarter" />
    <CanvasBottomToolbar
      @add="flow.addNode"
      @group="flow.groupSelection"
      @ungroup="flow.ungroupSelection"
      @undo="flow.undo"
      @redo="flow.redo"
    />
    <CanvasContextMenu
      :visible="contextMenu.visible"
      :x="contextMenu.x"
      :y="contextMenu.y"
      @add="onContextAdd"
      @copy="flow.copySelection"
      @paste="flow.pasteClipboard"
      @delete="flow.deleteSelection"
      @group="flow.groupSelection"
      @ungroup="flow.ungroupSelection"
    />
    <CanvasHistoryDrawer
      :open="showHistory"
      :revisions="revisions"
      @close="showHistory = false"
      @restore="restoreRevision"
    />
    <CanvasAssetManager
      :open="showAssets"
      :assets="assets"
      :error="assetError"
      @close="showAssets = false"
      @upload="uploadAsset"
      @insert="insertAsset"
      @remove="removeAsset"
    />
    <CanvasImportExportDialog
      v-if="showImport"
      :open="showImport"
      :project-uuid="projectUuid"
      :account-id="accountId"
      @close="showImport = false"
    />
    <CanvasAiPanel
      :project-uuid="projectUuid"
      :base-revision="store.revision"
      :greeting-name="greetingName"
      :selected-context="selectedContext"
    />
    <CanvasExecutionDesk
      :runs="execution.runs.value"
      :pending-count="execution.pendingCount.value"
      :origin-device="execution.originDevice.value"
      @locate="locateNode"
      @cancel="execution.cancelRun"
      @retry="openExecutionPreview"
      @failure="openFailure"
    />
    <CanvasExecutionPreviewDialog
      :open="showPreview"
      :confirming="execution.confirming.value"
      :items="previewItems"
      @confirm="confirmExecutionPreview"
      @close="showPreview = false"
    />
    <CanvasFailureDialog
      :open="showFailure"
      :raw-text="failureRaw"
      @close="showFailure = false"
    />
  </section>
</template>

<script setup lang="ts">
import {
  canonicalizeJcs,
  deleteCanvasAsset,
  listCanvasAssets,
  listCanvasRevisions,
  restoreCanvasRevision,
  sha256HexUtf8,
  uploadCanvasAsset,
} from "@/features/tianjiang/canvas/api";
import { canvasEditorPath } from "@/features/tianjiang/canvas/navigation";
import type { CanvasStarterKind } from "@/features/tianjiang/canvas/navigation";
import type { CanvasNodeKind } from "@/features/tianjiang/canvas/types";
import { serializeCanvasDocument } from "@/features/tianjiang/canvas/document";
import { MAX_CANVAS_GROUP_DEPTH } from "@/features/tianjiang/canvas/limits";
import { createCanvasHistory } from "@/features/tianjiang/canvas/history";
import { createLayoutRequestId } from "@/features/tianjiang/canvas/layout";
import CanvasLayoutWorker from "@/features/tianjiang/canvas/canvas-layout.worker.ts?worker&inline";
import { useCanvasStore } from "@/stores/canvas";
import { useInfiniteCanvasWorkspace } from "./composables/useInfiniteCanvasWorkspace";
import { useCanvasFlow } from "./composables/useCanvasFlow";
import CanvasStarterCards from "./components/CanvasStarterCards.vue";
import CanvasTopToolbar from "./components/CanvasTopToolbar.vue";
import CanvasBottomToolbar from "./components/CanvasBottomToolbar.vue";
import CanvasContextMenu from "./components/CanvasContextMenu.vue";
import CanvasHistoryDrawer from "./components/CanvasHistoryDrawer.vue";
import CanvasAssetManager from "./components/CanvasAssetManager.vue";
import CanvasImportExportDialog from "./components/CanvasImportExportDialog.vue";
import CanvasViewport from "./components/CanvasViewport.vue";
import CanvasAiPanel from "./components/ai/CanvasAiPanel.vue";
import CanvasExecutionDesk from "./components/execution/CanvasExecutionDesk.vue";
import CanvasExecutionPreviewDialog from "./components/execution/CanvasExecutionPreviewDialog.vue";
import CanvasFailureDialog from "./components/execution/CanvasFailureDialog.vue";
import { useCanvasExecution } from "@/features/tianjiang/canvas/useCanvasExecution";
import TextCanvasNode from "./components/nodes/TextCanvasNode.vue";
import MediaCanvasNode from "./components/nodes/MediaCanvasNode.vue";
import FileCanvasNode from "./components/nodes/FileCanvasNode.vue";
import GenerationCanvasNode from "./components/nodes/GenerationCanvasNode.vue";
import StoryboardCanvasNode from "./components/nodes/StoryboardCanvasNode.vue";
import GroupCanvasNode from "./components/nodes/GroupCanvasNode.vue";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import "@vue-flow/controls/dist/style.css";
import "@vue-flow/minimap/dist/style.css";
import "./styles/canvas.scss";

void TextCanvasNode;
void MediaCanvasNode;
void FileCanvasNode;
void GenerationCanvasNode;
void StoryboardCanvasNode;
void GroupCanvasNode;
void serializeCanvasDocument;
void MAX_CANVAS_GROUP_DEPTH;

const history = createCanvasHistory();
const layoutWorker = new CanvasLayoutWorker();
const historyLimit = 100;
const requestId = createLayoutRequestId();
void history.undo;
void history.redo;
void historyLimit;
void requestId;
void layoutWorker;

const route = useRoute();
const router = useRouter();
const store = useCanvasStore();
const workspace = useInfiniteCanvasWorkspace();
const flow = useCanvasFlow();
const nodes = flow.nodes;
const edges = flow.edges;
const viewport = flow.viewport;
const contextMenu = flow.contextMenu;
const error = ref("");
const showCards = ref(true);
const openedUuid = ref("");
const showHistory = ref(false);
const showAssets = ref(false);
const showImport = ref(false);
const revisions = ref<Array<{ revisionUuid: string; documentRevision: number }>>([]);
const assets = ref<Array<{ assetUuid: string; sha256?: string }>>([]);
const assetError = ref("");
const accountId = computed(() => "personal-local");
const projectUuid = computed(() => String(route.params.projectUuid ?? ""));
const greetingName = computed(() => "用户");
const selectedContext = computed(() => nodes.value.map((node) => node.id).join(","));
const execution = useCanvasExecution(() => projectUuid.value, () => store.revision);
const showPreview = ref(false);
const showFailure = ref(false);
const failureRaw = ref("");
const previewItems = computed(() => {
  const envelope = execution.preview.value as {
    data?: { items?: Array<{ nodeUuid: string; modelId?: string; fee?: { displayText?: string } }> };
  } | null;
  return envelope?.data?.items ?? [];
});

function locateNode(nodeUuid: string): void {
  void nodeUuid;
}

function openFailure(text: string): void {
  failureRaw.value = text;
  showFailure.value = true;
}

async function openCurrent(): Promise<void> {
  if (!projectUuid.value) return;
  error.value = "";
  try {
    await workspace.open(projectUuid.value);
    openedUuid.value = projectUuid.value;
    flow.hydrateFromStore();
    if (typeof route.query.starter === "string") {
      applyStarter(route.query.starter as CanvasStarterKind);
      await router.replace({ path: canvasEditorPath(projectUuid.value) });
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "打开画布失败";
  }
}

function applyStarter(kind: CanvasStarterKind): void {
  showCards.value = false;
  if (kind === "text-to-image") flow.addNode("image_generation");
  else if (kind === "first-frame-to-video") flow.addNode("video_generation");
  else if (kind === "storyboard-guide") flow.addNode("storyboard");
  else if (kind === "novel-upload") flow.addNode("file");
}

function onContextAdd(kind: CanvasNodeKind): void {
  flow.contextMenu.visible = false;
  flow.addNode(kind);
}

async function openHistory(): Promise<void> {
  const payload = await listCanvasRevisions(projectUuid.value) as {
    data?: { revisions?: Array<{ revisionUuid: string; documentRevision: number }> };
  };
  revisions.value = payload.data?.revisions ?? [];
  showHistory.value = true;
}

async function restoreRevision(revisionUuid: string): Promise<void> {
  // 中文注释：恢复前先把当前图写入历史，作为可回退快照。
  store.history.push({
    label: "恢复前快照",
    before: JSON.parse(JSON.stringify(store.document)),
    after: JSON.parse(JSON.stringify(store.document)),
  });
  await restoreCanvasRevision(projectUuid.value, revisionUuid, {
    baseRevision: store.revision,
    clientMutationId: crypto.randomUUID(),
  });
  await store.open(projectUuid.value);
  flow.hydrateFromStore();
}

async function refreshAssets(): Promise<void> {
  const payload = await listCanvasAssets(projectUuid.value) as {
    data?: { assets?: Array<{ assetUuid: string; sha256?: string }> };
  };
  assets.value = payload.data?.assets ?? [];
}

async function uploadAsset(file: File): Promise<void> {
  const clientAssetMutationId = crypto.randomUUID();
  const requestDigest = await sha256HexUtf8(canonicalizeJcs({
    operation: "asset-upload",
    projectUuid: projectUuid.value,
    sha256: await sha256HexUtf8(`${file.name}:${file.size}:${file.type}`),
    sizeBytes: file.size,
    mimeType: file.type || "image/png",
  }));
  try {
    const uploaded = await uploadCanvasAsset(projectUuid.value, {
      clientAssetMutationId,
      requestDigest,
      file,
    }) as { data?: { assetUuid?: string } };
    const assetUuid = String(uploaded.data?.assetUuid ?? "");
    if (assetUuid) flow.attachAssetNode(assetUuid, "image", file.name);
    await refreshAssets();
    assetError.value = "";
  } catch (cause) {
    assetError.value = cause instanceof Error ? cause.message : "素材上传失败";
  }
}

function insertAsset(assetUuid: string): void {
  flow.attachAssetNode(assetUuid, "image", "素材");
}

async function removeAsset(asset: { assetUuid: string; sha256?: string }): Promise<void> {
  try {
    const clientAssetMutationId = crypto.randomUUID();
    const expectedSha256 = asset.sha256 ?? "0".repeat(64);
    const requestDigest = await sha256HexUtf8(canonicalizeJcs({
      operation: "asset-delete",
      projectUuid: projectUuid.value,
      assetUuid: asset.assetUuid,
      expectedSha256,
    }));
    await deleteCanvasAsset(projectUuid.value, asset.assetUuid, {
      clientAssetMutationId,
      requestDigest,
      expectedSha256,
    });
    await refreshAssets();
    assetError.value = "";
  } catch (cause) {
    assetError.value = cause instanceof Error ? cause.message : "素材仍被引用，无法删除";
  }
}

function onDropFiles(files: File[]): void {
  for (const file of files) void uploadAsset(file);
}

onMounted(openCurrent);
watch(projectUuid, (next, previous) => {
  void previous;
  void openCurrent();
});

async function openExecutionPreview(nodeUuid: string): Promise<void> {
  await execution.retryExecution(nodeUuid);
  showPreview.value = true;
}

async function confirmExecutionPreview(): Promise<void> {
  await execution.confirmPreview();
  showPreview.value = false;
}

// 中文注释：生成节点通过注入调用统一预览入口，不能从节点直接确认收费任务。
provide("canvas-execution-preview", openExecutionPreview);
onBeforeUnmount(() => {
  void flow.flush();
  flow.destroy();
  if (openedUuid.value) void workspace.close().catch(() => undefined);
});
</script>
