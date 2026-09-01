import { computed, ref } from "vue";

import {
  cancelCanvasExecution,
  canonicalizeJcs,
  confirmCanvasExecution,
  listCanvasExecutions,
  previewCanvasExecution,
  sha256HexUtf8,
} from "@/features/tianjiang/canvas/api";

export interface CanvasExecutionRow {
  runUuid: string;
  nodeUuid: string;
  state: string;
  runGeneration?: number;
  failureText?: string;
  originDevice?: string;
  fee?: { displayText?: string };
}

const MAX_FAILURE_BYTES = 1048576;

export function sanitizeFailureText(text: string): string {
  const replaced = text
    .replace(/Authorization[:\s]+\S+/gi, "[REDACTED_SECRET]")
    .replace(/AccessKey[=:\s]+\S+/gi, "[REDACTED_SECRET]")
    .replace(/Bearer\s+\S+/gi, "[REDACTED_SECRET]")
    .replace(/https?:\/\/[^\s]+[?&][^\s]*/gi, "[REDACTED_SECRET]")
    .replace(/file:\/\/[^\s]+/gi, "[REDACTED_SECRET]");
  const bytes = new TextEncoder().encode(replaced);
  if (bytes.length <= MAX_FAILURE_BYTES) return replaced;
  return new TextDecoder().decode(bytes.slice(0, MAX_FAILURE_BYTES));
}

export function useCanvasExecution(projectUuid: () => string, baseRevision: () => number) {
  const runs = ref<CanvasExecutionRow[]>([]);
  const preview = ref<Record<string, unknown> | null>(null);
  const confirming = ref(false);
  const originDevice = ref(true);
  const failureText = ref("");
  const lastConfirmationUuid = ref("");
  const lastRequestDigest = ref("");
  const lastClientRequestId = ref("");

  const pendingCount = computed(() => runs.value.filter((row) => [
    "confirmation_required",
    "waiting_for_origin_device",
    "queued",
    "running",
    "failed",
  ].includes(row.state)).length);

  const safeProcessedText = computed(() => sanitizeFailureText(failureText.value));

  async function refreshExecutions(): Promise<void> {
    const listed = await listCanvasExecutions(projectUuid()) as {
      data?: { runs?: CanvasExecutionRow[] };
    };
    runs.value = listed.data?.runs ?? [];
  }

  async function previewNodes(nodeUuids: string[]): Promise<void> {
    preview.value = await previewCanvasExecution(projectUuid(), {
      baseRevision: baseRevision(),
      nodeUuids,
    }) as Record<string, unknown>;
  }

  async function confirmPreview(): Promise<void> {
    if (confirming.value) return;
    const envelope = preview.value as {
      data?: { confirmationUuid?: string; requestDigest?: string };
      confirmationUuid?: string;
      requestDigest?: string;
    } | null;
    const confirmationUuid = String(envelope?.data?.confirmationUuid ?? envelope?.confirmationUuid ?? "");
    const requestDigest = String(envelope?.data?.requestDigest ?? envelope?.requestDigest ?? "");
    if (!confirmationUuid || !requestDigest) return;
    confirming.value = true;
    try {
      const clientRequestId = lastClientRequestId.value || crypto.randomUUID();
      lastClientRequestId.value = clientRequestId;
      lastConfirmationUuid.value = confirmationUuid;
      lastRequestDigest.value = requestDigest;
      const receipt = await confirmCanvasExecution(projectUuid(), {
        confirmationUuid,
        requestDigest,
        baseRevision: baseRevision(),
        clientRequestId,
      }) as { data?: { runs?: CanvasExecutionRow[] } };
      runs.value = (receipt.data?.runs ?? []).map((row) => ({
        ...row,
        state: "waiting_for_origin_device",
      }));
    } finally {
      confirming.value = false;
    }
  }

  async function retryExecution(nodeUuid: string): Promise<void> {
    lastClientRequestId.value = "";
    await previewNodes([nodeUuid]);
    const nextGeneration = Math.max(0, ...runs.value.map((row) => Number(row.runGeneration ?? 0))) + 1;
    void nextGeneration;
    // 中文注释：重试也可能产生费用，只生成权威预览，必须等待用户在弹窗再次确认。
  }

  async function cancelRun(runUuid: string): Promise<void> {
    if (!originDevice.value) return;
    const clientActionId = crypto.randomUUID();
    const requestDigest = await sha256HexUtf8(canonicalizeJcs({
      operation: "cancel",
      runUuid,
      clientActionId,
    }));
    await cancelCanvasExecution(projectUuid(), runUuid, { clientActionId, requestDigest });
    await refreshExecutions();
  }

  function openFailure(text: string): void {
    failureText.value = text;
  }

  return {
    runs,
    preview,
    confirming,
    originDevice,
    failureText,
    pendingCount,
    safeProcessedText,
    lastConfirmationUuid,
    lastRequestDigest,
    refreshExecutions,
    previewNodes,
    confirmPreview,
    retryExecution,
    cancelRun,
    openFailure,
    sanitizeFailureText,
  };
}
