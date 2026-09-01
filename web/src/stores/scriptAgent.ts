import axios from "@/utils/axios";
import projectStore from "@/stores/project";
import settingStore from "@/stores/setting";
import { useChat } from "@/utils/useChat";
import { toLocalProjectId } from "@/features/tianjiang/project/local-project-id";
import { mapScriptAgentOutputError } from "@/features/tianjiang/script-agent/output-errors";
import { shouldShowProductError } from "@/features/tianjiang/script-agent/product-error-dedupe";
import {
  applyXmlTagToPreview,
  clearAllPreviews,
  createEmptyPreview,
  mergePreviewDiscard,
  type PlanPreview,
} from "@/features/tianjiang/script-agent/preview-buffer";
import { registerProjectRuntimeReleaser } from "@/features/tianjiang/project/project-runtime-disposal";
import { getActivePinia } from "pinia";

interface PlanData {
  storySkeleton: string;
  adaptationStrategy: string;
  script: { id?: number; name: string; content: string }[];
}

function makeScriptAgentStore(projectId: string) {
  return defineStore(`scriptAgent-${projectId}`, () => {
        const planData = ref<PlanData>({
          storySkeleton: "",
          adaptationStrategy: "",
          script: [],
        });

        /** 按 messageId 隔离的流式预览；禁止直接改 canonical planData */
        const previewByMessageId = ref<Record<string, PlanPreview>>({});

        // 连接错误安全文案（短时间去重）
        let lastConnectErrorAt = 0;
        /** 产物错误按 messageId+errorCode 去重，禁止全局时间窗压掉父消息 */
        const productErrorSeen = new Map<string, number>();

        const { connected, messages, chat, stopGenerate, socket, status, disconnect, connect, reconnect, disposeUiSocket } = useChat({
          url: `${settingStore().baseUrl}/socket/scriptAgent`,
          auth: () => {
            // HTTP/Socket 边界必须发 JSON number；Project.id 仍可为字符串
            const id = toLocalProjectId(projectId);
            return {
              isolationKey: `${id}:scriptAgent`,
              projectId: id,
            };
          },
          manageLifecycle: false,
          xmlTags: [
            { tag: "storySkeleton", keepInMessage: false },
            { tag: "adaptationStrategy", keepInMessage: false },
            { tag: "scriptItem", keepInMessage: false },
          ],
          onXmlTag: (data) => {
            // 仅写预览缓冲，禁止改 planData、禁止 setPlanData
            const mid = data.messageId;
            if (!previewByMessageId.value[mid]) {
              previewByMessageId.value[mid] = createEmptyPreview();
            }
            applyXmlTagToPreview(previewByMessageId.value[mid], {
              tag: data.tag,
              value: data.value,
              attrs: data.attrs ?? {},
              status: data.status,
            });
            // 触发响应式
            previewByMessageId.value = { ...previewByMessageId.value };
          },
          onError: (error) => {
            // 仅连接类错误；产物错误走 message:update error 通道
            const now = Date.now();
            if (now - lastConnectErrorAt < 4000) return;
            lastConnectErrorAt = now;
            try {
              const text = mapScriptAgentOutputError({
                code: (error as { code?: string }).code,
                message: error.message,
              });
              // 连接失败不要用产物文案误导；有安全中文则用
              window.$message?.error?.(text || "剧本 Agent 连接失败");
            } catch {
              // ignore
            }
          },
          autoConnect: false,
        });

        async function loadPlanDataFromServer() {
          const { data } = await axios.post("/scriptAgent/getPlanData", {
            projectId: toLocalProjectId(projectId),
            agentType: "scriptAgent",
          });
          // ApiResponse: { code, data: { data: PlanData, id }, message }
          const payload = data?.data?.data ?? data?.data ?? {};
          planData.value.storySkeleton = payload.storySkeleton ?? "";
          planData.value.adaptationStrategy = payload.adaptationStrategy ?? "";
          planData.value.script = payload.script ?? [];
        }

        watch(
          socket,
          (s, prev) => {
            if (prev && prev !== s) {
              prev.off("getPlanData");
              prev.off("artifactCommitted");
              prev.off("message:update");
            }
            if (s) {
              s.on("getPlanData", (_, callback) => {
                // 工具读取返回 canonical，不含未提交预览
                callback(planData.value);
              });
              // 服务端事务提交成功后，重新拉取正式 getPlanData
              s.on("artifactCommitted", async () => {
                previewByMessageId.value = clearAllPreviews();
                try {
                  await loadPlanDataFromServer();
                } catch {
                  // 读取失败不污染 canonical
                }
              });
              // 产物错误：message:update error 通道读取 errorCode（不用 connect_error）
              s.on("message:update", (data: {
                id?: string;
                status?: string;
                ext?: { error?: string; errorCode?: string; stage?: string };
              }) => {
                if (data.status !== "error") return;
                if (data.id) {
                  previewByMessageId.value = mergePreviewDiscard(previewByMessageId.value, data.id);
                }
                const code = data.ext?.errorCode;
                const stage = data.ext?.stage;
                if (!code && !data.ext?.error) return;
                const now = Date.now();
                if (!shouldShowProductError(productErrorSeen, data.id ?? "", code, now, 1500)) {
                  return;
                }
                try {
                  const text = mapScriptAgentOutputError({
                    code,
                    stage,
                    message: data.ext?.error,
                  });
                  window.$message?.error?.(text);
                } catch {
                  // ignore
                }
              });
            }
          },
          { immediate: true },
        );

        async function setPlanData() {
          await axios.post("/scriptAgent/setPlanData", {
            projectId: toLocalProjectId(projectId),
            agentType: "scriptAgent",
            data: planData.value,
          });
        }

        const thinkLevel = ref(0);

        function updateThinkConfig(value: number) {
          thinkLevel.value = value;
          if (socket.value) {
            socket.value.emit("updateThinkConfig", { think: value > 0, thinlLevel: value });
          }
        }

        function releaseRuntime() {
          disposeUiSocket();
          messages.value = [];
          planData.value = {
            storySkeleton: "",
            adaptationStrategy: "",
            script: [],
          };
          previewByMessageId.value = clearAllPreviews();
          productErrorSeen.clear();
        }

        return {
          connected,
          messages,
          chat,
          stopGenerate,
          socket,
          status,
          planData,
          previewByMessageId,
          setPlanData,
          loadPlanDataFromServer,
          connect,
          disconnect,
          disposeUiSocket,
          releaseRuntime,
          reconnect,
          thinkLevel,
          updateThinkConfig,
        };
      });
}

const storeMap = new Map<string, ReturnType<typeof makeScriptAgentStore>>();

function createScriptAgentStore(projectId: string) {
  if (!storeMap.has(projectId)) {
    storeMap.set(projectId, makeScriptAgentStore(projectId));
  }
  return storeMap.get(projectId)!;
}

export default function useScriptAgentStore() {
  const id = projectStore().project?.id;
  if (!id) throw new Error("No project selected");
  return createScriptAgentStore(id)();
}

export function releaseScriptAgentStore(projectId: string): void {
  const key = String(projectId ?? "").trim();
  if (!key) return;
  const factory = storeMap.get(key);
  if (!factory) return;
  try {
    const store = factory();
    const storeId = store.$id;
    store.releaseRuntime?.();
    store.$dispose();
    // 中文注释：避免切换项目后只剩不可见的 Pinia state 壳持续累积。
    const pinia = getActivePinia();
    if (pinia?.state.value) delete pinia.state.value[storeId];
  } catch {
    // 已销毁或尚未挂到当前 Pinia
  }
  storeMap.delete(key);
}

export function getScriptAgentStoreCount(): number {
  return storeMap.size;
}

export function hasScriptAgentStore(projectId: string): boolean {
  return storeMap.has(String(projectId ?? "").trim());
}

registerProjectRuntimeReleaser("scriptAgent", (projectId) => {
  releaseScriptAgentStore(projectId);
});
