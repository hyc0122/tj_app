<template>
  <div v-if="open" class="canvas-drawer" role="dialog">
    <h2>导入导出</h2>
    <p>importer={{ importerVersion }} portable={{ portableVersion }}</p>
    <input type="file" accept=".tjcanvas,.json,.txt,.docx" @change="onPick" />
    <button type="button" @click="exportPortable">导出 .tjcanvas</button>
    <button type="button" :disabled="!activeImportUuid" @click="cancelActive">取消导入</button>
    <button type="button" :disabled="!activeImportUuid" @click="reconcileActive">对账</button>
    <button type="button" @click="$emit('close')">关闭</button>
    <p v-if="status">{{ status }}</p>
  </div>
</template>

<script setup lang="ts">
import {
  CANVAS_IMPORTER_SCHEMA_VERSION,
  CANVAS_PORTABLE_FORMAT_VERSION,
  MAX_CANVAS_MULTIPART_FILE_BYTES,
} from "@/features/tianjiang/contracts";
import {
  cancelCanvasImport,
  canvasImportActionDigest,
  exportCanvasPortable,
  getCanvasDocument,
  getCanvasImportByClientMutation,
  getCanvasImportStatus,
  importCanvasJson,
  importCanvasNovel,
  importCanvasTjcanvas,
  listActiveCanvasImports,
  reconcileCanvasImport,
  tjcanvasImportDigest,
} from "@/features/tianjiang/canvas/api";
import {
  commitPendingActionIntent,
  commitPendingImportIntent,
  deleteActionIntent,
  deleteImportIntent,
  listProjectActionIntents,
  listProjectImportIntents,
  upgradeActionIntentAccepted,
  upgradeImportIntentAccepted,
} from "@/features/tianjiang/canvas/import-receipt-store";
import { useCanvasStore } from "@/stores/canvas";
import Sha256Worker from "@/features/tianjiang/canvas/streaming-sha256-worker.ts?worker&inline";

const props = defineProps<{
  open: boolean;
  projectUuid: string;
  accountId: string;
}>();
defineEmits<{ (event: "close"): void }>();

const store = useCanvasStore();
const importerVersion = CANVAS_IMPORTER_SCHEMA_VERSION;
const portableVersion = CANVAS_PORTABLE_FORMAT_VERSION;
const status = ref("");
const activeImportUuid = ref("");
let hashWorker: Worker | undefined;
let pollAbort: AbortController | undefined;

function ensureWorker(): Worker {
  hashWorker ??= new Sha256Worker();
  return hashWorker;
}

function hashFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = ensureWorker();
    const requestId = crypto.randomUUID();
    const onMessage = (event: MessageEvent<{ requestId: string; sha256?: string; error?: string }>) => {
      if (event.data.requestId !== requestId) return;
      worker.removeEventListener("message", onMessage);
      if (event.data.sha256) resolve(event.data.sha256);
      else reject(new Error(event.data.error ?? "hash-failed"));
    };
    worker.addEventListener("message", onMessage);
    worker.postMessage({ requestId, file });
  });
}

async function importTjcanvas(file: File): Promise<void> {
  if (file.size > MAX_CANVAS_MULTIPART_FILE_BYTES) {
    status.value = "文件超过 2GiB 上限";
    return;
  }
  const archiveSha256 = await hashFile(file);
  const clientMutationId = crypto.randomUUID();
  const requestDigest = await tjcanvasImportDigest({
    projectUuid: props.projectUuid,
    archiveSha256,
    archiveSizeBytes: file.size,
    baseRevision: store.revision,
    importerSchemaVersion: CANVAS_IMPORTER_SCHEMA_VERSION,
  });
  // 中文注释：pending intent 未耐久成功前禁止构造/发送 FormData。
  const intent = await commitPendingImportIntent({
    accountId: props.accountId,
    projectUuid: props.projectUuid,
    clientMutationId,
    requestDigest,
    archiveSha256,
    archiveSizeBytes: file.size,
    baseRevision: store.revision,
    importerSchemaVersion: CANVAS_IMPORTER_SCHEMA_VERSION,
  });
  const receipt = await importCanvasTjcanvas(props.projectUuid, {
    baseRevision: store.revision,
    clientMutationId,
    requestDigest,
    archiveSha256,
    archiveSizeBytes: file.size,
    file,
  }) as { code?: number; data?: { importUuid?: string; state?: string } };
  const accepted = await upgradeImportIntentAccepted(intent.key, {
    importUuid: String(receipt.data?.importUuid ?? ""),
    receipt,
  });
  activeImportUuid.value = String(accepted.importUuid ?? "");
  status.value = "已受理";
  await pollImport(accepted.importUuid ?? "", accepted);
}

async function pollImport(importUuid: string, intent: { key: string; clientMutationId: string; requestDigest: string; archiveSha256: string }): Promise<void> {
  pollAbort?.abort();
  pollAbort = new AbortController();
  const signal = pollAbort.signal;
  while (!signal.aborted) {
    const job = await getCanvasImportStatus(props.projectUuid, importUuid) as {
      data?: { state?: string; importUuid?: string };
    };
    const state = String(job.data?.state ?? "");
    if (state === "committed" || state === "failed" || state === "aborted") {
      await getCanvasDocument(props.projectUuid);
      await deleteImportIntent({
        key: intent.key,
        accountId: props.accountId,
        projectUuid: props.projectUuid,
        status: "accepted",
        clientMutationId: intent.clientMutationId,
        requestDigest: intent.requestDigest,
        archiveSha256: intent.archiveSha256,
        archiveSizeBytes: 0,
        baseRevision: store.revision,
        importerSchemaVersion: CANVAS_IMPORTER_SCHEMA_VERSION,
      });
      status.value = state === "committed" ? "导入完成" : `导入${state}`;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
}

async function recover(): Promise<void> {
  const intents = await listProjectImportIntents(props.accountId, props.projectUuid);
  for (const intent of intents) {
    if (intent.status === "pending") {
      const found = await getCanvasImportByClientMutation(props.projectUuid, intent.clientMutationId).catch(() => null) as {
        data?: { importUuid?: string };
      } | null;
      if (found?.data?.importUuid) {
        const accepted = await upgradeImportIntentAccepted(intent.key, found.data);
        activeImportUuid.value = accepted.importUuid ?? "";
        status.value = "已受理";
        await pollImport(accepted.importUuid ?? "", accepted);
      } else {
        status.value = `请重新选择 SHA-256 为 ${intent.archiveSha256} 的同一文件`;
      }
      continue;
    }
    if (intent.importUuid) {
      await pollImport(intent.importUuid, intent);
      await listActiveCanvasImports(props.projectUuid);
    }
  }
  const actions = await listProjectActionIntents(props.accountId, props.projectUuid);
  for (const action of actions) {
    if (action.status !== "pending") continue;
    const replay = action.actionType === "cancel"
      ? cancelCanvasImport(props.projectUuid, action.importUuid, {
        clientActionId: action.clientActionId,
        requestDigest: action.requestDigest,
      })
      : reconcileCanvasImport(props.projectUuid, action.importUuid, {
        clientActionId: action.clientActionId,
        requestDigest: action.requestDigest,
      });
    const receipt = await replay;
    await upgradeActionIntentAccepted(action.key, receipt as never);
    await deleteActionIntent({ ...action, status: "accepted", receipt });
  }
}

async function runAction(actionType: "cancel" | "reconcile"): Promise<void> {
  const importUuid = activeImportUuid.value;
  if (!importUuid) return;
  const clientActionId = crypto.randomUUID();
  const requestDigest = await canvasImportActionDigest(importUuid, actionType, clientActionId);
  const pending = await commitPendingActionIntent({
    accountId: props.accountId,
    projectUuid: props.projectUuid,
    importUuid,
    actionType,
    clientActionId,
    requestDigest,
  });
  const receipt = actionType === "cancel"
    ? await cancelCanvasImport(props.projectUuid, importUuid, { clientActionId, requestDigest })
    : await reconcileCanvasImport(props.projectUuid, importUuid, { clientActionId, requestDigest });
  await upgradeActionIntentAccepted(pending.key, receipt as never);
  await deleteActionIntent({ ...pending, status: "accepted", receipt });
}

function cancelActive(): void {
  void runAction("cancel");
}
function reconcileActive(): void {
  void runAction("reconcile");
}

async function importJsonFile(file: File): Promise<void> {
  const text = await file.text();
  await importCanvasJson(props.projectUuid, {
    baseRevision: store.revision,
    clientMutationId: crypto.randomUUID(),
    document: JSON.parse(text),
  });
  status.value = "JSON 已导入";
}

async function importNovelFile(file: File): Promise<void> {
  const text = await file.text();
  await importCanvasNovel(props.projectUuid, {
    baseRevision: store.revision,
    clientMutationId: crypto.randomUUID(),
    text,
  });
  status.value = "小说已导入";
}

async function onPick(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.name.endsWith(".tjcanvas")) await importTjcanvas(file);
  else if (file.name.endsWith(".json")) await importJsonFile(file);
  else await importNovelFile(file);
}

async function exportPortable(): Promise<void> {
  const blob = await exportCanvasPortable(props.projectUuid);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "canvas.tjcanvas";
  link.click();
  URL.revokeObjectURL(url);
}

onMounted(() => {
  void recover();
});

onBeforeUnmount(() => {
  pollAbort?.abort();
  hashWorker?.terminate();
  hashWorker = undefined;
});
</script>
