import axios from "@/utils/axios";
import type { AxiosResponse } from "axios";
import projectStore from "@/stores/project";
import { normalizeStoryboardAssetEnvelope } from "./storyboard-asset-normalizer";
import { buildStoryboardMediaUrl } from "./storyboard-media-url";
import { isStoryboardClientOperationId } from "./storyboard-client-operation";
import { normalizeStoryboardGenerationResponse } from "./storyboard-generation-response";
import {
  DEFAULT_STORYBOARD_VIDEO_RESOLUTION,
  normalizeStoryboardVideoResolution,
  type AutoMatchAssetsResult,
  type BatchReplacePromptResult,
  type BindStoryboardAssetInput,
  type StoryboardGenerationItem,
  type StoryboardGenerationSettings,
  type StoryboardQueueState,
  type WorkspaceAsset,
  type WorkspaceShot,
} from "./storyboard-workbench-types";
import { getCurrentInstance, onUnmounted } from "vue";

function unwrapData(payload: unknown): unknown {
  let current = payload;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!current || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, "data")) break;
    current = (current as { data?: unknown }).data;
  }
  return current;
}

function safeNonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

interface StoryboardProjectRequestOwner {
  projectUuid: string;
  epoch: number;
  runtimeBase: string;
}

type StoryboardRequestResource = "shots" | "assets" | "queue";
type StoryboardRefreshOutcome = "success" | "error" | "superseded";

interface StoryboardWorkspaceOptions {
  onProjectEpochChanged?: () => void;
  onGenerationAccepted?: () => void;
}

function createDefaultQueueState(): StoryboardQueueState {
  return {
    paused: false,
    maxConcurrency: 1,
    queued: 0,
    active: 0,
    unknown: 0,
  };
}

function buildRuntimeBase(projectUuid: string): string {
  return `/tianjiang/runtime/projects/${encodeURIComponent(projectUuid)}/storyboard`;
}

export function useStoryboardWorkspace(options: StoryboardWorkspaceOptions = {}) {
  const onGenerationAccepted = options.onGenerationAccepted;
  const store = projectStore();
  const projectUuid = computed(() => store.project?.projectUuid || "");
  const moduleName = ref<"shots" | "assets" | "settings">("shots");
  const shots = ref<WorkspaceShot[]>([]);
  const assets = ref<WorkspaceAsset[]>([]);
  const assetSourceProjectUuid = ref("");
  const queue = ref<StoryboardQueueState>(createDefaultQueueState());
  const generationSettings = ref<StoryboardGenerationSettings>({
    mediaType: "video",
    // 中文注释：项目模型只在工作区首次进入时初始化；后续用户选择是唯一真源。
    providerModel: String(store.project?.videoModel ?? ""),
    mode: "text2video",
    resolution: normalizeStoryboardVideoResolution(store.project?.resolution)
      || DEFAULT_STORYBOARD_VIDEO_RESOLUTION,
  });
  const selectedShotUuid = ref("");
  const errorMessage = ref("");
  const actionFeedback = ref("");
  const loading = ref(false);
  const inserting = ref(false);
  const autoMatchBusy = ref(false);
  const batchReplaceBusy = ref(false);
  let disposed = false;
  let autoMatchToken = 0;
  let batchReplaceToken = 0;

  let projectEpoch = 0;
  const requestGenerations = new Map<string, number>();

  if (getCurrentInstance()) {
    onUnmounted(() => {
      disposed = true;
    });
  }

  function captureProjectOwner(): StoryboardProjectRequestOwner | null {
    const ownerProjectUuid = projectUuid.value.trim();
    if (!ownerProjectUuid) return null;
    return {
      projectUuid: ownerProjectUuid,
      epoch: projectEpoch,
      runtimeBase: buildRuntimeBase(ownerProjectUuid),
    };
  }

  function ownsCurrentProject(owner: StoryboardProjectRequestOwner): boolean {
    return owner.projectUuid === projectUuid.value.trim() && owner.epoch === projectEpoch;
  }

  function requestGenerationKey(
    owner: StoryboardProjectRequestOwner,
    resource: StoryboardRequestResource,
  ): string {
    return `${owner.projectUuid}:${owner.epoch}:${resource}`;
  }

  function beginRequest(
    owner: StoryboardProjectRequestOwner,
    resource: StoryboardRequestResource,
  ): number {
    const key = requestGenerationKey(owner, resource);
    const generation = (requestGenerations.get(key) ?? 0) + 1;
    requestGenerations.set(key, generation);
    return generation;
  }

  function ownsLatestRequest(
    owner: StoryboardProjectRequestOwner,
    resource: StoryboardRequestResource,
    generation: number,
  ): boolean {
    return ownsCurrentProject(owner)
      && requestGenerations.get(requestGenerationKey(owner, resource)) === generation;
  }

  // 项目切换必须同步推进 epoch；仅比较 UUID 无法阻止 A→B→A 的旧响应回写。
  watch(projectUuid, () => {
    projectEpoch += 1;
    requestGenerations.clear();
    shots.value = [];
    assets.value = [];
    assetSourceProjectUuid.value = "";
    queue.value = createDefaultQueueState();
    selectedShotUuid.value = "";
    errorMessage.value = "";
    actionFeedback.value = "";
    loading.value = false;
    inserting.value = false;
    autoMatchBusy.value = false;
    batchReplaceBusy.value = false;
    autoMatchToken += 1;
    batchReplaceToken += 1;
    generationSettings.value = {
      mediaType: "video",
      providerModel: String(store.project?.videoModel ?? ""),
      mode: "text2video",
      resolution: normalizeStoryboardVideoResolution(store.project?.resolution)
        || DEFAULT_STORYBOARD_VIDEO_RESOLUTION,
    };
    // 中文注释：由同一个同步 epoch 边界通知页面清理携带旧项目身份的弹窗与确认对象。
    options.onProjectEpochChanged?.();
  }, { flush: "sync" });

  const selectedShot = computed(() => (
    shots.value.find((shot) => shot.shotUuid === selectedShotUuid.value) ?? null
  ));
  const totalDurationMs = computed(() => shots.value.reduce(
    (sum, shot) => sum + Math.max(0, Number(shot.durationMs) || 0),
    0,
  ));

  async function refreshShotsForOwner(
    owner: StoryboardProjectRequestOwner,
    preferredShotUuid = "",
  ): Promise<StoryboardRefreshOutcome> {
    const requestGeneration = beginRequest(owner, "shots");
    if (ownsCurrentProject(owner)) {
      loading.value = true;
      errorMessage.value = "";
    }
    try {
      const response = await axios.get(`${owner.runtimeBase}/shots`);
      if (!ownsLatestRequest(owner, "shots", requestGeneration)) return "superseded";
      const payload = unwrapData(response);
      const rows = Array.isArray(payload) ? payload : [];
      shots.value = rows as WorkspaceShot[];
      const nextSelection = preferredShotUuid || selectedShotUuid.value;
      if (nextSelection && shots.value.some((shot) => shot.shotUuid === nextSelection)) {
        selectedShotUuid.value = nextSelection;
      } else {
        selectedShotUuid.value = shots.value[0]?.shotUuid ?? "";
      }
      return "success";
    } catch {
      // 项目已切换或被后发请求抢占属于正常并发，不得伪报成网络失败。
      if (!ownsLatestRequest(owner, "shots", requestGeneration)) return "superseded";
      errorMessage.value = "读取分镜列表失败，请重试";
      return "error";
    } finally {
      if (ownsLatestRequest(owner, "shots", requestGeneration)) {
        loading.value = false;
      }
    }
  }

  async function refreshShots(preferredShotUuid = ""): Promise<boolean> {
    const owner = captureProjectOwner();
    if (!owner) {
      shots.value = [];
      selectedShotUuid.value = "";
      return false;
    }
    return (await refreshShotsForOwner(owner, preferredShotUuid)) === "success";
  }

  function refreshShotsAfterAcceptedGeneration(
    owner: StoryboardProjectRequestOwner,
    preferredShotUuid: string,
  ): void {
    // 中文注释：受理成功与状态刷新解耦；刷新失败只能追加提示，绝不能推翻已耐久提交。
    void refreshShotsForOwner(owner, preferredShotUuid).then((outcome) => {
      if (!ownsCurrentProject(owner) || outcome === "superseded") return;
      if (outcome === "error") {
        errorMessage.value = "提交完成，状态刷新失败，请手动刷新";
      }
    }).catch(() => {
      if (ownsCurrentProject(owner)) {
        errorMessage.value = "提交完成，状态刷新失败，请手动刷新";
      }
    });
  }

  async function insertAfter(afterShotUuid: string | null): Promise<void> {
    const owner = captureProjectOwner();
    if (inserting.value || !owner) return;
    errorMessage.value = "";
    actionFeedback.value = "";
    inserting.value = true;
    try {
      const response = await axios.post(`${owner.runtimeBase}/shots`, { afterShotUuid });
      const created = unwrapData(response) as { shotUuid?: string; displayOrder?: number } | null;
      await refreshShotsForOwner(owner, created?.shotUuid ?? "");
      if (!ownsCurrentProject(owner)) return;
      const order = Number(created?.displayOrder);
      actionFeedback.value = Number.isFinite(order) ? `已插入分镜 ${String(order).padStart(2, "0")}` : "已插入新分镜";
    } catch {
      if (ownsCurrentProject(owner)) {
        errorMessage.value = "插入分镜失败，请重试";
      }
    } finally {
      if (ownsCurrentProject(owner)) {
        inserting.value = false;
      }
    }
  }

  function selectShot(shotUuid: string) {
    selectedShotUuid.value = shotUuid;
    actionFeedback.value = "";
  }

  async function refreshAssetsForOwner(owner: StoryboardProjectRequestOwner): Promise<void> {
    const requestGeneration = beginRequest(owner, "assets");
    try {
      const response = await axios.get(`${owner.runtimeBase}/assets`);
      if (!ownsLatestRequest(owner, "assets", requestGeneration)) return;
      const payload = unwrapData(response);
      // 中文注释：资产归一化必须使用请求捕获的项目身份，切换项目后旧响应不得借用新 projectUuid。
      const normalized = normalizeStoryboardAssetEnvelope(payload, owner.projectUuid);
      assetSourceProjectUuid.value = normalized.sourceProjectUuid;
      assets.value = normalized.assets;
    } catch {
      if (ownsLatestRequest(owner, "assets", requestGeneration)) {
        assets.value = [];
        errorMessage.value = "读取资产列表失败，请重试";
      }
    }
  }

  async function refreshQueueForOwner(owner: StoryboardProjectRequestOwner): Promise<void> {
    const requestGeneration = beginRequest(owner, "queue");
    try {
      const response = await axios.get("/setting/dreaminaCli/getStatus");
      if (!ownsLatestRequest(owner, "queue", requestGeneration)) return;
      const payload = unwrapData(response);
      const state = payload && typeof payload === "object"
        ? (payload as { queue?: Record<string, unknown> }).queue
        : null;
      queue.value = {
        paused: state?.paused === true,
        maxConcurrency: safeNonNegativeInteger(state?.maxConcurrency, 1),
        queued: safeNonNegativeInteger(state?.queued, 0),
        active: safeNonNegativeInteger(state?.active, 0),
        unknown: safeNonNegativeInteger(state?.unknown, 0),
      };
    } catch {
      if (ownsLatestRequest(owner, "queue", requestGeneration)) {
        errorMessage.value = "读取本机生成队列失败，请重试";
      }
    }
  }

  async function refreshProductionState(preferredShotUuid = ""): Promise<void> {
    const owner = captureProjectOwner();
    if (!owner) return;
    errorMessage.value = "";
    await Promise.all([
      refreshShotsForOwner(owner, preferredShotUuid),
      refreshAssetsForOwner(owner),
      refreshQueueForOwner(owner),
    ]);
  }

  async function unbindAsset(shotUuid: string, input: BindStoryboardAssetInput): Promise<boolean> {
    const owner = captureProjectOwner();
    if (!owner || !shotUuid || !input.assetUuid) {
      errorMessage.value = "取消关联失败，请重试";
      return false;
    }
    errorMessage.value = "";
    actionFeedback.value = "";
    try {
      await axios.delete(
        `${owner.runtimeBase}/shots/${encodeURIComponent(shotUuid)}/bindings/${encodeURIComponent(input.assetUuid)}`,
        { params: { sourceProjectUuid: input.sourceProjectUuid, assetType: input.assetType } },
      );
      const refreshOutcome = await refreshShotsForOwner(owner, shotUuid);
      if (!ownsCurrentProject(owner)) return false;
      if (refreshOutcome === "superseded") return true;
      if (refreshOutcome === "error") {
        errorMessage.value = "资产已取消关联，但刷新最新状态失败，请手动刷新";
        return false;
      }
      actionFeedback.value = "资产已取消关联";
      return true;
    } catch {
      if (ownsCurrentProject(owner)) errorMessage.value = "取消关联失败，请重试";
      return false;
    }
  }

  async function updateBindingVoice(shotUuid: string, input: BindStoryboardAssetInput & { voiceEnabled: boolean }): Promise<boolean> {
    const owner = captureProjectOwner();
    if (!owner || !shotUuid || !input.assetUuid) {
      errorMessage.value = "更新音色开关失败，请重试";
      return false;
    }
    errorMessage.value = "";
    actionFeedback.value = "";
    try {
      await axios.patch(
        `${owner.runtimeBase}/shots/${encodeURIComponent(shotUuid)}/bindings/${encodeURIComponent(input.assetUuid)}`,
        {
          sourceProjectUuid: input.sourceProjectUuid,
          assetType: input.assetType,
          relationRole: input.relationRole,
          voiceEnabled: input.voiceEnabled,
        },
        { params: { sourceProjectUuid: input.sourceProjectUuid, assetType: input.assetType, relationRole: input.relationRole } },
      );
      const refreshOutcome = await refreshShotsForOwner(owner, shotUuid);
      if (!ownsCurrentProject(owner)) return false;
      if (refreshOutcome === "superseded") return true;
      if (refreshOutcome === "error") {
        errorMessage.value = "音色开关已更新，但刷新最新状态失败，请手动刷新";
        return false;
      }
      actionFeedback.value = input.voiceEnabled ? "已开启角色音色" : "已关闭角色音色";
      return true;
    } catch {
      if (ownsCurrentProject(owner)) errorMessage.value = "更新音色开关失败，请重试";
      return false;
    }
  }

  async function bindAsset(shotUuid: string, input: BindStoryboardAssetInput): Promise<boolean> {
    const owner = captureProjectOwner();
    if (!owner || !shotUuid || !input.assetUuid) {
      errorMessage.value = "绑定资产失败，请重试";
      return false;
    }
    errorMessage.value = "";
    actionFeedback.value = "";
    const sourceProjectUuid = input.sourceProjectUuid || assetSourceProjectUuid.value || owner.projectUuid;
    try {
      await axios.post(`${owner.runtimeBase}/shots/${encodeURIComponent(shotUuid)}/bindings`, {
        sourceProjectUuid,
        assetUuid: input.assetUuid,
        assetType: input.assetType,
        relationRole: input.relationRole,
      });
      const refreshOutcome = await refreshShotsForOwner(owner, shotUuid);
      if (!ownsCurrentProject(owner)) return false;
      if (refreshOutcome === "superseded") return true;
      if (refreshOutcome === "error") {
        errorMessage.value = "资产已绑定，但刷新最新状态失败，请手动刷新";
        return false;
      }
      actionFeedback.value = "资产已绑定";
      return true;
    } catch {
      // 不把 Axios 响应、本机路径或供应商密钥回显到页面。
      if (ownsCurrentProject(owner)) {
        errorMessage.value = "绑定资产失败，请重试";
      }
      return false;
    }
  }

  async function selectCandidate(shotUuid: string, candidateUuid: string): Promise<boolean> {
    const owner = captureProjectOwner();
    if (!owner || !shotUuid || !candidateUuid) {
      errorMessage.value = "采用候选失败，请重试";
      return false;
    }
    errorMessage.value = "";
    actionFeedback.value = "";
    try {
      await axios.post(
        `${owner.runtimeBase}/shots/${encodeURIComponent(shotUuid)}/candidates/${encodeURIComponent(candidateUuid)}/select`,
        {},
      );
      const refreshOutcome = await refreshShotsForOwner(owner, shotUuid);
      if (!ownsCurrentProject(owner)) return false;
      if (refreshOutcome === "superseded") return true;
      if (refreshOutcome === "error") {
        errorMessage.value = "候选已采用，但刷新最新状态失败，请手动刷新";
        return false;
      }
      actionFeedback.value = "候选已采用";
      return true;
    } catch {
      if (ownsCurrentProject(owner)) {
        errorMessage.value = "采用候选失败，请重试";
      }
      return false;
    }
  }

  async function generateShot(
    shotUuid: string,
    mediaType: StoryboardGenerationItem["mediaType"],
    options: Omit<StoryboardGenerationItem, "shotUuid" | "mediaType">,
    clientOperationId: string,
  ): Promise<boolean> {
    const owner = captureProjectOwner();
    const resolution = mediaType === "video"
      ? normalizeStoryboardVideoResolution(options.resolution)
      : "";
    if (
      !owner
      || !shotUuid
      || !options.providerModel
      || (mediaType === "video" && !resolution)
      || !isStoryboardClientOperationId(clientOperationId)
      || !/^[0-9a-f]{64}$/.test(String(options.expectedPreviewDigest ?? ""))
    ) {
      errorMessage.value = mediaType === "video" && !resolution
        ? "当前选择的视频分辨率不受支持"
        : !/^[0-9a-f]{64}$/.test(String(options.expectedPreviewDigest ?? ""))
          ? "生成前必须先完成最终请求预览确认"
          : "提交生成失败，请重试";
      return false;
    }
    errorMessage.value = "";
    actionFeedback.value = "";
    try {
      const response = await axios.post<unknown, AxiosResponse>(
        `${owner.runtimeBase}/generate`,
        {
          clientOperationId,
          shotUuid,
          mediaType,
          providerModel: options.providerModel,
          ...(options.routeKind ? { routeKind: options.routeKind } : {}),
          mode: options.mode,
          ...(typeof options.durationMs === "number" ? { durationMs: options.durationMs } : {}),
          ...(typeof options.aspectRatio === "string" ? { aspectRatio: options.aspectRatio } : {}),
          ...(mediaType === "video" ? { resolution } : {}),
          expectedPreviewDigest: options.expectedPreviewDigest,
          paidBatchConfirmed: false,
        },
        { preserveResponse: true },
      );
      // 中文注释：200 数组必须逐项同 ID；202 恢复对象必须同 ID 且携带完整任务数组。
      normalizeStoryboardGenerationResponse(unwrapData(response.data), clientOperationId, response.status);
      if (!ownsCurrentProject(owner)) return false;
      actionFeedback.value = "提交完成，已进入任务队列";
      if (onGenerationAccepted) onGenerationAccepted();
      else refreshShotsAfterAcceptedGeneration(owner, shotUuid);
      return true;
    } catch (error) {
      if (ownsCurrentProject(owner)) {
        const { readSafeGenerationSubmitError } = await import("./storyboard-generation-preview");
        errorMessage.value = readSafeGenerationSubmitError(error, "提交生成失败，请重试");
      }
      return false;
    }
  }

  async function updateShotFields(
    shotUuid: string,
    patch: Partial<Pick<WorkspaceShot, "videoPrompt" | "durationMs" | "aspectRatio" | "era" | "cameraMovement">>,
  ): Promise<boolean> {
    const owner = captureProjectOwner();
    if (!owner || !shotUuid) {
      errorMessage.value = "保存分镜失败，请重试";
      return false;
    }
    errorMessage.value = "";
    actionFeedback.value = "";
    try {
      await axios.patch(`${owner.runtimeBase}/shots/${encodeURIComponent(shotUuid)}`, patch);
      const refreshOutcome = await refreshShotsForOwner(owner, shotUuid);
      if (!ownsCurrentProject(owner)) return false;
      if (refreshOutcome === "error") {
        errorMessage.value = "分镜已保存，但刷新最新状态失败，请手动刷新";
        return false;
      }
      actionFeedback.value = "分镜已保存";
      return true;
    } catch {
      if (ownsCurrentProject(owner)) errorMessage.value = "保存分镜失败，请重试";
      return false;
    }
  }

  async function reorderShots(orderedShotUuids: string[]): Promise<boolean> {
    const owner = captureProjectOwner();
    if (!owner || orderedShotUuids.length === 0) {
      errorMessage.value = "调整分镜顺序失败，请重试";
      return false;
    }
    errorMessage.value = "";
    actionFeedback.value = "";
    try {
      await axios.put(`${owner.runtimeBase}/shots/reorder`, { orderedShotUuids });
      const refreshOutcome = await refreshShotsForOwner(owner, selectedShotUuid.value);
      if (!ownsCurrentProject(owner)) return false;
      if (refreshOutcome === "error") {
        errorMessage.value = "分镜已重排，但刷新最新状态失败，请手动刷新";
        return false;
      }
      actionFeedback.value = "分镜顺序已更新";
      return true;
    } catch {
      if (ownsCurrentProject(owner)) errorMessage.value = "调整分镜顺序失败，请重试";
      return false;
    }
  }

  async function deleteShots(shotUuids: string[]): Promise<boolean> {
    const owner = captureProjectOwner();
    if (!owner || shotUuids.length === 0) {
      errorMessage.value = "删除分镜失败，请重试";
      return false;
    }
    errorMessage.value = "";
    actionFeedback.value = "";
    const remaining = shots.value.filter((shot) => !shotUuids.includes(shot.shotUuid));
    const preferred = remaining.find((shot) => shot.shotUuid === selectedShotUuid.value)?.shotUuid
      ?? remaining[0]?.shotUuid
      ?? "";
    try {
      await axios.delete(`${owner.runtimeBase}/shots`, { data: { shotUuids } });
      const refreshOutcome = await refreshShotsForOwner(owner, preferred);
      if (!ownsCurrentProject(owner)) return false;
      if (refreshOutcome === "error") {
        errorMessage.value = "分镜已删除，但刷新最新状态失败，请手动刷新";
        return false;
      }
      actionFeedback.value = "分镜已删除";
      return true;
    } catch {
      if (ownsCurrentProject(owner)) errorMessage.value = "删除分镜失败，请重试";
      return false;
    }
  }

  async function createAsset(input: { type: "role" | "scene" | "tool"; name: string; describe?: string }): Promise<WorkspaceAsset | null> {
    const owner = captureProjectOwner();
    if (!owner) {
      errorMessage.value = "新建资产失败，请重试";
      return null;
    }
    try {
      const response = await axios.post(`${owner.runtimeBase}/assets`, input);
      const created = unwrapData(response) as WorkspaceAsset;
      await refreshAssetsForOwner(owner);
      if (!ownsCurrentProject(owner)) return created ?? null;
      actionFeedback.value = "资产已创建";
      return created ?? null;
    } catch {
      if (ownsCurrentProject(owner)) errorMessage.value = "新建资产失败，请重试";
      return null;
    }
  }

  async function uploadAssetImage(assetUuid: string, file: File): Promise<boolean> {
    const owner = captureProjectOwner();
    if (!owner || !assetUuid) {
      errorMessage.value = "上传资产图片失败，请重试";
      return false;
    }
    try {
      const form = new FormData();
      form.append("file", file);
      await axios.post(`${owner.runtimeBase}/assets/${encodeURIComponent(assetUuid)}/image`, form);
      await refreshAssetsForOwner(owner);
      if (!ownsCurrentProject(owner)) return true;
      actionFeedback.value = "资产图片已上传";
      return true;
    } catch {
      if (ownsCurrentProject(owner)) errorMessage.value = "资产已创建，但图片上传失败，可重试";
      return false;
    }
  }

  async function generateBatch(
    items: StoryboardGenerationItem[],
    paidBatchConfirmed: boolean,
    clientOperationId: string,
  ): Promise<boolean> {
    const owner = captureProjectOwner();
    errorMessage.value = "";
    actionFeedback.value = "";
    if (items.length > 1 && !paidBatchConfirmed) {
      actionFeedback.value = "批量付费生成前请先确认";
      return false;
    }
    if (
      !owner
      || items.length === 0
      || !isStoryboardClientOperationId(clientOperationId)
      || items.some((item) => !/^[0-9a-f]{64}$/.test(String(item.expectedPreviewDigest ?? "")))
    ) {
      errorMessage.value = "提交批量生成失败，请重试";
      return false;
    }
    const preferredShotUuid = selectedShotUuid.value || items[0].shotUuid;
    try {
      const response = await axios.post<unknown, AxiosResponse>(
        `${owner.runtimeBase}/generate`,
        {
          clientOperationId,
          items,
          paidBatchConfirmed,
        },
        { preserveResponse: true },
      );
      normalizeStoryboardGenerationResponse(unwrapData(response.data), clientOperationId, response.status);
      if (!ownsCurrentProject(owner)) return false;
      actionFeedback.value = "提交完成，已进入任务队列";
      if (onGenerationAccepted) onGenerationAccepted();
      else refreshShotsAfterAcceptedGeneration(owner, preferredShotUuid);
      return true;
    } catch (error) {
      if (ownsCurrentProject(owner)) {
        const { readSafeGenerationSubmitError } = await import("./storyboard-generation-preview");
        errorMessage.value = readSafeGenerationSubmitError(error, "提交批量生成失败，请重试");
      }
      return false;
    }
  }

  function readSafeBatchToolError(error: unknown, fallback: string): string {
    const payload = (error as { response?: { data?: { message?: unknown } } })?.response?.data;
    const message = String(payload?.message ?? "").trim();
    if (
      message
      && message.length <= 80
      && /^[\u4e00-\u9fffA-Za-z0-9，。、：；！？“”‘’（）\s]+$/.test(message)
      && !/[\\/]/.test(message)
    ) {
      return message;
    }
    return fallback;
  }

  function mergeSelectedShots(incoming: AutoMatchAssetsResult["shots"] | BatchReplacePromptResult["shots"]): void {
    const rows = Array.isArray(incoming) ? incoming : [];
    if (!rows.length) return;
    const nextByUuid = new Map(shots.value.map((shot) => [shot.shotUuid, shot] as const));
    for (const row of rows) {
      if (!row || typeof row.shotUuid !== "string") continue;
      const current = nextByUuid.get(row.shotUuid);
      if (!current) continue;
      nextByUuid.set(row.shotUuid, {
        ...current,
        ...row,
        shotUuid: current.shotUuid,
        bindings: Array.isArray(row.bindings) ? row.bindings : current.bindings,
        candidates: Array.isArray(row.candidates) ? row.candidates : current.candidates,
        generationTasks: Array.isArray(row.generationTasks) ? row.generationTasks : current.generationTasks,
      });
    }
    shots.value = shots.value.map((shot) => nextByUuid.get(shot.shotUuid) ?? shot);
  }

  function summarizeAutoMatch(result: AutoMatchAssetsResult): string {
    const names = (result.conflictAssetNames ?? []).filter(Boolean).slice(0, 6);
    const conflictHint = result.conflictCount > 0
      ? `，跳过 ${result.conflictCount} 处歧义${names.length ? `：${names.join("、")}` : ""}`
      : "";
    return `已为 ${result.processedCount} 条分镜匹配 ${result.createdBindingCount} 个新关联${conflictHint}`;
  }

  async function autoMatchAssets(shotUuids: readonly string[]): Promise<boolean> {
    const owner = captureProjectOwner();
    const unique = [...new Set(shotUuids.map((item) => String(item ?? "").trim()).filter(Boolean))];
    if (!owner || unique.length === 0 || autoMatchBusy.value || batchReplaceBusy.value) {
      if (owner && unique.length === 0 && !disposed) errorMessage.value = "请选择要匹配资产的分镜";
      return false;
    }
    const token = ++autoMatchToken;
    errorMessage.value = "";
    actionFeedback.value = "";
    autoMatchBusy.value = true;
    try {
      const response = await axios.post(`${owner.runtimeBase}/shots/actions/auto-match-assets`, {
        shotUuids: unique,
      });
      if (!ownsCurrentProject(owner) || disposed) return false;
      const payload = unwrapData(response) as AutoMatchAssetsResult;
      if (!ownsCurrentProject(owner) || disposed) return false;
      mergeSelectedShots(payload?.shots);
      actionFeedback.value = summarizeAutoMatch({
        selectedCount: Number(payload?.selectedCount ?? unique.length),
        processedCount: Number(payload?.processedCount ?? unique.length),
        matchedCount: Number(payload?.matchedCount ?? 0),
        createdBindingCount: Number(payload?.createdBindingCount ?? 0),
        existingBindingCount: Number(payload?.existingBindingCount ?? 0),
        emptyPromptCount: Number(payload?.emptyPromptCount ?? 0),
        conflictCount: Number(payload?.conflictCount ?? 0),
        conflictAssetNames: Array.isArray(payload?.conflictAssetNames) ? payload.conflictAssetNames : [],
      });
      return true;
    } catch (error) {
      if (ownsCurrentProject(owner) && !disposed) {
        errorMessage.value = readSafeBatchToolError(error, "自动匹配资产失败，请重试");
      }
      return false;
    } finally {
      if (ownsCurrentProject(owner) && autoMatchToken === token) {
        autoMatchBusy.value = false;
      }
    }
  }

  async function batchReplacePrompt(
    shotUuids: readonly string[],
    findText: string,
    replaceText: string,
  ): Promise<boolean> {
    const owner = captureProjectOwner();
    const unique = [...new Set(shotUuids.map((item) => String(item ?? "").trim()).filter(Boolean))];
    if (!owner || unique.length === 0 || autoMatchBusy.value || batchReplaceBusy.value) {
      if (owner && unique.length === 0 && !disposed) errorMessage.value = "请选择要替换的分镜";
      return false;
    }
    if (!findText) {
      if (!disposed && ownsCurrentProject(owner)) errorMessage.value = "查找文本不能为空";
      return false;
    }
    if (findText === replaceText) {
      if (!disposed && ownsCurrentProject(owner)) errorMessage.value = "替换后内容没有变化";
      return false;
    }
    const token = ++batchReplaceToken;
    errorMessage.value = "";
    actionFeedback.value = "";
    batchReplaceBusy.value = true;
    try {
      const response = await axios.post(`${owner.runtimeBase}/shots/actions/batch-replace-prompt`, {
        shotUuids: unique,
        findText,
        replaceText,
      });
      if (!ownsCurrentProject(owner) || disposed) return false;
      const payload = unwrapData(response) as BatchReplacePromptResult;
      if (!ownsCurrentProject(owner) || disposed) return false;
      mergeSelectedShots(payload?.shots);
      const selectedCount = Number(payload?.selectedCount ?? unique.length);
      const affectedShotCount = Number(payload?.affectedShotCount ?? 0);
      const replacementCount = Number(payload?.replacementCount ?? 0);
      actionFeedback.value = `选中 ${selectedCount} 条、影响 ${affectedShotCount} 条、共替换 ${replacementCount} 处`;
      return true;
    } catch (error) {
      if (ownsCurrentProject(owner) && !disposed) {
        errorMessage.value = readSafeBatchToolError(error, "批量替换失败，请重试");
      }
      return false;
    } finally {
      if (ownsCurrentProject(owner) && batchReplaceToken === token) {
        batchReplaceBusy.value = false;
      }
    }
  }

  function mediaUrl(relativePath: string): string {
    return buildStoryboardMediaUrl(projectUuid.value, relativePath);
  }

  return {
    moduleName,
    shots,
    assets,
    queue,
    generationSettings,
    selectedShot,
    selectedShotUuid,
    totalDurationMs,
    errorMessage,
    actionFeedback,
    loading,
    inserting,
    autoMatchBusy,
    batchReplaceBusy,
    autoMatchAssets,
    batchReplacePrompt,
    refreshShots,
    refreshProductionState,
    insertAfter,
    selectShot,
    bindAsset,
    unbindAsset,
    updateBindingVoice,
    selectCandidate,
    generateShot,
    generateBatch,
    updateShotFields,
    reorderShots,
    deleteShots,
    createAsset,
    uploadAssetImage,
    mediaUrl,
  };
}
