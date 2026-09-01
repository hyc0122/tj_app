import { computed, ref } from "vue";

import {
  applyCanvasChatPlan,
  canonicalizeJcs,
  createCanvasConversation,
  listCanvasConversations,
  postCanvasChat,
  sha256HexUtf8,
} from "@/features/tianjiang/canvas/api";

export interface CanvasChatMessage {
  role: "user" | "assistant";
  text: string;
  planUuid?: string;
  completeDone?: boolean;
}

/** 中文注释：普通对话计划 autoApply 固定 false，必须用户点击 applyPlan。 */
export function useCanvasAiSession(projectUuid: () => string, baseRevision: () => number) {
  const autoApply = false;
  const conversationUuid = ref("");
  const history = ref<Array<{ conversationUuid: string; title: string }>>([]);
  const messages = ref<CanvasChatMessage[]>([]);
  const draft = ref("");
  const modelId = ref("");
  const skill = ref("");
  const shortcut = ref("");
  const isComposing = ref(false);
  const streaming = ref(false);
  const completeDone = ref(false);
  const pendingPlanUuid = ref("");
  const clientChatRequestId = ref("");
  const requestDigest = ref("");
  const attachments = ref<string[]>([]);
  const selectedNodeUuids = ref<string[]>([]);

  const canSend = computed(() => draft.value.trim().length > 0 && !streaming.value);

  async function newChat(): Promise<void> {
    const created = await createCanvasConversation(projectUuid()) as { data?: { conversationUuid?: string } };
    conversationUuid.value = String(created.data?.conversationUuid ?? crypto.randomUUID());
    messages.value = [];
    completeDone.value = false;
    pendingPlanUuid.value = "";
  }

  async function loadHistory(): Promise<void> {
    const listed = await listCanvasConversations(projectUuid()) as {
      data?: Array<{ conversation_uuid?: string; conversationUuid?: string; title?: string }>;
    };
    history.value = (listed.data ?? []).map((row) => ({
      conversationUuid: String(row.conversationUuid ?? row.conversation_uuid ?? ""),
      title: String(row.title ?? "对话"),
    }));
  }

  async function send(): Promise<void> {
    if (!canSend.value || isComposing.value) return;
    if (!conversationUuid.value) await newChat();
    const prompt = draft.value.trim();
    draft.value = "";
    messages.value.push({ role: "user", text: prompt });
    streaming.value = true;
    completeDone.value = false;
    clientChatRequestId.value = crypto.randomUUID();
    requestDigest.value = await sha256HexUtf8(canonicalizeJcs({
      conversationUuid: conversationUuid.value,
      prompt,
      modelId: modelId.value,
      skillId: skill.value,
      baseRevision: baseRevision(),
      clientChatRequestId: clientChatRequestId.value,
    }));
    let assistantIndex = -1;
    const payload = await postCanvasChat(projectUuid(), {
      conversationUuid: conversationUuid.value,
      prompt,
      modelId: modelId.value || undefined,
      skillId: skill.value || undefined,
      attachmentAssetUuids: attachments.value,
      referencedNodeUuids: selectedNodeUuids.value,
      baseRevision: baseRevision(),
      clientChatRequestId: clientChatRequestId.value,
      requestDigest: requestDigest.value,
    }, (event) => {
      if (event.delta) {
        if (assistantIndex < 0) {
          assistantIndex = messages.value.push({ role: "assistant", text: "", completeDone: false }) - 1;
        }
        messages.value[assistantIndex]!.text += String(event.delta);
      }
      if (event.done === true) {
        completeDone.value = true;
        pendingPlanUuid.value = String(event.planUuid ?? "");
        if (assistantIndex >= 0) {
          messages.value[assistantIndex]!.planUuid = pendingPlanUuid.value;
          messages.value[assistantIndex]!.completeDone = true;
        }
      }
    });
    if (payload.done === true) {
      completeDone.value = true;
      pendingPlanUuid.value = String(payload.planUuid ?? "");
      if (assistantIndex < 0) {
        messages.value.push({ role: "assistant", text: "", planUuid: pendingPlanUuid.value, completeDone: true });
      }
    }
    streaming.value = false;
    void autoApply;
  }

  async function applyPlan(): Promise<void> {
    if (!completeDone.value || !pendingPlanUuid.value || autoApply) return;
    await applyCanvasChatPlan(projectUuid(), pendingPlanUuid.value, {
      baseRevision: baseRevision(),
      clientMutationId: crypto.randomUUID(),
    });
  }

  return {
    autoApply,
    conversationUuid,
    history,
    messages,
    draft,
    modelId,
    skill,
    shortcut,
    isComposing,
    streaming,
    completeDone,
    pendingPlanUuid,
    clientChatRequestId,
    requestDigest,
    attachments,
    selectedNodeUuids,
    canSend,
    newChat,
    loadHistory,
    send,
    applyPlan,
  };
}
