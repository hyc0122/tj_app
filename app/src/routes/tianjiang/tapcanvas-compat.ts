/**
 * TapCanvas 前端兼容层：不引入 new-api / PostgreSQL / 独立账号后台。
 * 登录身份、项目画布、模型与生成全部落到天将现有 Runtime。
 * TAPCANVAS_HIDE_TEAM：暂不实现团队模式。收费任务必须复用天将权威确认链。
 */
import crypto from "node:crypto";
import express from "express";

import { centralAuthGateway } from "@/tianjiang/auth/auth-runtime";
import type { CentralSession } from "@/tianjiang/auth/central-session";
import { emptyCanvasDocument } from "@/tianjiang/canvas/canvas-contracts";
import { listCanvasAssets } from "@/tianjiang/canvas/canvas-asset-service";
import { confirmCanvasExecution, previewCanvasExecution } from "@/tianjiang/canvas/canvas-execution-service";
import { listCanvasExecutions } from "@/tianjiang/canvas/canvas-execution-events";
import { CanvasRuntimeError, readCanvasDocument, saveCanvasDocument, type CanvasDocumentEnvelope } from "@/tianjiang/canvas/canvas-document-service";
import { db } from "@/utils/db";
import { runHomePlan } from "@/tianjiang/canvas/canvas-chat-service";
import { uploadTapCanvasAsset } from "@/tianjiang/canvas/tapcanvas-asset-upload";
import {
  applyCodexFallback,
  createCodexPairing,
  createCodexTask,
  createCodexTaskMessage,
  getCodexTask,
  listCodexBridges,
  listCodexTaskMessages,
  listCodexTasks,
  resolveCodexPreview,
} from "@/tianjiang/canvas/tapcanvas-codex-store";
import {
  appendMemoryTurns,
  emptyMemoryContext,
  listMemoryArtifacts,
  listMemorySessions,
  loadRecentConversation,
  newMemoryIds,
} from "@/tianjiang/canvas/tapcanvas-memory-store";
import {
  GenerationPrefsError,
  readGenerationPrefs,
  writeGenerationPrefs,
} from "@/tianjiang/canvas/tapcanvas-generation-prefs";
import {
  decodeTapCanvasTaskId,
  encodeTapCanvasTaskId,
  mapCanvasRunState,
  parseTapCanvasTaskRequest,
  TapCanvasTaskContractError,
} from "@/tianjiang/canvas/tapcanvas-task-contract";
import { listNativeDreaminaModels } from "@/tianjiang/model-providers/native-provider-registry";
import { initializeCanvasWorkspace } from "@/utils/db";
import { syncCoordinator } from "@/tianjiang/runtime/runtime";
import { withOpenPersonalCanvasProject } from "@/tianjiang/runtime/project-operation-port";
import u from "@/utils";

const router = express.Router();
const TAPCANVAS_HIDE_TEAM = true;

/** 中文注释：personal / personal_* 是前端个人作用域哨兵，不是团队 ID。 */
function isPersonalCanvasTeamId(teamId: unknown): boolean {
  if (teamId == null) return true;
  const value = String(teamId).trim();
  return value === "" || value === "personal" || value.startsWith("personal_");
}

function rejectDisabledTeamCanvas(res: express.Response, teamId: unknown): boolean {
  if (TAPCANVAS_HIDE_TEAM && !isPersonalCanvasTeamId(teamId)) {
    res.status(403).send({ error: "team_disabled", message: "暂不支持团队画布" });
    return true;
  }
  return false;
}

type OverlayProject = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  owner: string;
  ownerName: string;
  access: "owner";
  projectKind: "creative";
  teamShared: false;
};

type ProjectDirectorySnapshot = {
  assetId: string | null;
  updatedAt: string | null;
  state: {
    version: 1;
    rootId: string;
    nodesById: Record<string, Record<string, unknown>>;
  };
};

type ProjectAliasState = Record<string, { name: string; updatedAt: string }>;

const TAPCANVAS_DIRECTORY_SETTING_KEY = "tapcanvas.projectDirectory.v1";
const TAPCANVAS_PROJECT_ALIAS_SETTING_KEY = "tapcanvas.projectAliases.v1";
const MAX_DIRECTORY_BYTES = 2 * 1024 * 1024;
const MAX_DIRECTORY_NODES = 10_000;
const MAX_PROJECT_ALIASES = 2_000;

function sessionOf(req: express.Request): CentralSession | undefined {
  return (req as { centralSession?: CentralSession }).centralSession;
}

function userDto(session: CentralSession) {
  return {
    sub: session.user.id,
    login: session.user.username,
    name: session.user.nickname || session.user.username,
  };
}

function projectDtoFromCatalog(item: {
  projectUuid: string;
  name: string;
  updatedAt: string;
}, session: CentralSession): OverlayProject {
  return {
    id: item.projectUuid,
    name: item.name,
    createdAt: item.updatedAt,
    updatedAt: item.updatedAt,
    owner: session.user.username,
    ownerName: session.user.nickname || session.user.username,
    access: "owner",
    projectKind: "creative",
    teamShared: false,
  };
}

async function readAccountJsonSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await u.accountDb("o_setting").where({ key }).first();
  if (!row || typeof row.value !== "string" || !row.value.trim()) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

async function writeAccountJsonSetting(key: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value);
  const exists = await u.accountDb("o_setting").where({ key }).first();
  if (exists) {
    await u.accountDb("o_setting").where({ key }).update({ value: serialized });
    return;
  }
  await u.accountDb("o_setting").insert({ key, value: serialized });
}

function normalizeProjectDirectory(input: unknown): ProjectDirectorySnapshot {
  const fallback = emptyDirectory();
  if (!input || typeof input !== "object") return fallback;
  const record = input as Record<string, unknown>;
  const state = record.state && typeof record.state === "object"
    ? record.state as Record<string, unknown>
    : null;
  const nodesById = state?.nodesById && typeof state.nodesById === "object" && !Array.isArray(state.nodesById)
    ? state.nodesById as Record<string, Record<string, unknown>>
    : null;
  if (!nodesById || Object.keys(nodesById).length > MAX_DIRECTORY_NODES) {
    throw Object.assign(new Error("画布项目目录格式无效或节点数量超限"), { status: 400 });
  }
  const normalized: ProjectDirectorySnapshot = {
    assetId: typeof record.assetId === "string" && record.assetId.trim() ? record.assetId.trim() : null,
    updatedAt: typeof record.updatedAt === "string" && record.updatedAt.trim() ? record.updatedAt : null,
    state: {
      version: 1,
      rootId: typeof state?.rootId === "string" && state.rootId.trim() ? state.rootId : "root",
      nodesById,
    },
  };
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_DIRECTORY_BYTES) {
    throw Object.assign(new Error("画布项目目录超过 2 MiB 限制"), { status: 413 });
  }
  return normalized;
}

async function readProjectAliases(): Promise<ProjectAliasState> {
  const raw = await readAccountJsonSetting<unknown>(TAPCANVAS_PROJECT_ALIAS_SETTING_KEY, {});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const entries = Object.entries(raw as Record<string, unknown>).slice(0, MAX_PROJECT_ALIASES);
  return Object.fromEntries(entries.flatMap(([projectUuid, value]) => {
    if (!/^[0-9a-f-]{36}$/i.test(projectUuid) || !value || typeof value !== "object") return [];
    const record = value as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim().slice(0, 120) : "";
    if (!name) return [];
    return [[projectUuid, {
      name,
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date(0).toISOString(),
    }]];
  }));
}

function isOwnedPersonalCanvas(item: {
  kind?: string;
  businessType?: string;
  ownerUserId?: number;
  myRole?: string;
}, session: CentralSession): boolean {
  return item.kind === "personal"
    && item.businessType === "canvas"
    && Number(item.ownerUserId) === Number(session.user.id)
    && item.myRole === "owner";
}

async function listUserProjects(session: CentralSession): Promise<OverlayProject[]> {
  const aliases = await readProjectAliases();
  const catalog = syncCoordinator.listProjects(session)
    .filter((item) => isOwnedPersonalCanvas(item, session))
    .map((item) => {
      const dto = projectDtoFromCatalog(item, session);
      const alias = aliases[item.projectUuid];
      return alias ? { ...dto, name: alias.name, updatedAt: alias.updatedAt } : dto;
    });
  return catalog;
}

type NovelRow = {
  id?: number;
  chapterIndex?: number | null;
  chapter?: string | null;
  chapterData?: string | null;
  projectId?: number | null;
  createTime?: number | null;
};

function compatBookId(projectUuid: string, novelProjectId: string): string {
  return `tj-novel:${projectUuid}:${novelProjectId}`;
}

function parseCompatBookId(bookId: string): { projectUuid: string; novelProjectId: string } | null {
  const match = /^tj-novel:([0-9a-f-]{36}):([0-9]+|default)$/i.exec(String(bookId ?? "").trim());
  if (!match) return null;
  return { projectUuid: match[1]!, novelProjectId: match[2]! };
}

function novelGroupKey(row: NovelRow): string {
  return Number.isFinite(Number(row.projectId)) ? String(Number(row.projectId)) : "default";
}

function chapterOffsetBounds(rows: NovelRow[]): Array<{
  chapter: number;
  title: string;
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
  length: number;
}> {
  let offset = 0;
  let line = 1;
  return rows.map((row, index) => {
    const text = String(row.chapterData ?? "");
    const length = text.length;
    const startOffset = offset;
    const endOffset = offset + length;
    const lineCount = text.length === 0 ? 1 : text.split(/\r?\n/).length;
    const startLine = line;
    const endLine = line + lineCount - 1;
    offset = endOffset + (index === rows.length - 1 ? 0 : 1);
    line = endLine + 1;
    return {
      chapter: Number(row.chapterIndex ?? index + 1) || index + 1,
      title: String(row.chapter ?? "").trim() || `第 ${index + 1} 章`,
      startLine,
      endLine,
      startOffset,
      endOffset,
      length,
    };
  });
}

async function readProjectNovels(): Promise<NovelRow[]> {
  return db("o_novel")
    .select("id", "chapterIndex", "chapter", "chapterData", "projectId", "createTime")
    .orderBy("chapterIndex", "asc") as Promise<NovelRow[]>;
}

function toBookListItems(projectUuid: string, rows: NovelRow[]): Array<{
  bookId: string;
  title: string;
  chapterCount: number;
  updatedAt: string;
}> {
  const groups = new Map<string, NovelRow[]>();
  for (const row of rows) {
    const key = novelGroupKey(row);
    const current = groups.get(key) ?? [];
    current.push(row);
    groups.set(key, current);
  }
  return [...groups.entries()].map(([novelProjectId, chapters]) => {
    const latest = Math.max(0, ...chapters.map((row) => Number(row.createTime ?? 0)));
    return {
      bookId: compatBookId(projectUuid, novelProjectId),
      title: String(chapters[0]?.chapter ?? "").trim() || "未命名小说",
      chapterCount: chapters.length,
      updatedAt: latest > 0 ? new Date(latest * (latest < 1e12 ? 1000 : 1)).toISOString() : new Date(0).toISOString(),
    };
  });
}

function emptyExecutionHealth() {
  return {
    status: "healthy" as const,
    staleAfterSeconds: 0,
    totalTraceCount: 0,
    runningTraceCount: 0,
    waitingAsyncTraceCount: 0,
    staleRunningTraceCount: 0,
    sequenceMismatchCount: 0,
    terminalIntegrityIssueCount: 0,
    orphanParentTraceCount: 0,
    persistenceDegradedTraceCount: 0,
    totalEventCount: 0,
    totalPayloadBytes: 0,
    oldestActiveStartedAt: null as string | null,
    calculatedAt: new Date().toISOString(),
  };
}

function emptyDiagnosticsMetrics() {
  return {
    traceCount: 0,
    succeededCount: 0,
    failedCount: 0,
    partialCount: 0,
    needsInputCount: 0,
    persistedCount: 0,
    degradedCount: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    totalDurationMs: 0,
    averageDurationMs: null as number | null,
    p50DurationMs: null as number | null,
    p95DurationMs: null as number | null,
    acceptedAsyncCount: 0,
    materializedAsyncCount: 0,
    staleAsyncCount: 0,
  };
}

function mapCanvasRunStatus(state: string): "running" | "succeeded" | "failed" | "suspended" {
  if (state === "succeeded") return "succeeded";
  if (state === "failed") return "failed";
  if (
    state === "canceled"
    || state === "cancelled"
    || state === "waiting_for_origin_device"
    || state === "confirmation_required"
  ) return "suspended";
  return "running";
}

function emptyAgentDiagnostics(projectId: string | null, extra: {
  traces?: Array<Record<string, unknown>>;
  spans?: Array<Record<string, unknown>>;
} = {}) {
  const traces = extra.traces ?? [];
  const spans = extra.spans ?? [];
  const statuses = traces.map((trace) => String(trace.status ?? ""));
  const waitingAsyncTraceCount = traces.filter((trace) => {
    const meta = trace.meta && typeof trace.meta === "object" ? trace.meta as Record<string, unknown> : {};
    const state = String(meta.state ?? "");
    return state === "waiting_for_origin_device" || state === "queued";
  }).length;
  const activeStartedAt = traces
    .filter((trace) => trace.status === "running" || trace.status === "suspended")
    .map((trace) => String(trace.startedAt ?? ""))
    .filter(Boolean)
    .sort()[0] ?? null;
  return {
    projectId,
    bookId: null,
    chapterId: null,
    flowId: null,
    nodeId: null,
    label: null,
    traces,
    executionHealth: {
      ...emptyExecutionHealth(),
      totalTraceCount: traces.length,
      runningTraceCount: statuses.filter((status) => status === "running").length,
      waitingAsyncTraceCount,
      oldestActiveStartedAt: activeStartedAt,
    },
    publicChatRuns: [],
    storyboardDiagnostics: [],
    spans,
    metrics: {
      ...emptyDiagnosticsMetrics(),
      traceCount: traces.length,
      succeededCount: statuses.filter((status) => status === "succeeded").length,
      failedCount: statuses.filter((status) => status === "failed").length,
      persistedCount: traces.length,
    },
    evaluations: [],
    humanFeedback: [],
    annotationQueue: [],
    regressionExamples: [],
    nextCursor: null,
  };
}

function emptyDirectory() {
  const now = Date.now();
  return {
    assetId: null as string | null,
    updatedAt: null as string | null,
    state: {
      version: 1 as const,
      rootId: "root",
      nodesById: {
        root: {
          id: "root",
          kind: "folder",
          parentId: null,
          name: "项目",
          createdAt: now,
          updatedAt: now,
        },
      },
    },
  };
}

function mapTapKind(node: Record<string, unknown>): string {
  const data = node.data && typeof node.data === "object" ? node.data as Record<string, unknown> : {};
  const kind = String(node.kind ?? data.kind ?? node.type ?? "text");
  if (kind === "image" || kind === "imageEdit" || kind === "image_generation") return "image_generation";
  if (kind === "video" || kind === "video_generation") return "video_generation";
  if (kind === "audio") return "audio";
  return kind;
}

function normalizeGraph(data: Record<string, unknown> | undefined): {
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
  viewport: { x: number; y: number; zoom: number };
} {
  const rawNodes = Array.isArray(data?.nodes) ? data.nodes as Array<Record<string, unknown>> : [];
  const rawEdges = Array.isArray(data?.edges) ? data.edges as Array<Record<string, unknown>> : [];
  const viewport = (data?.viewport && typeof data.viewport === "object")
    ? data.viewport as { x: number; y: number; zoom: number }
    : { x: 0, y: 0, zoom: 1 };
  return {
    nodes: rawNodes.map((node) => {
      const id = String(node.nodeUuid ?? node.id ?? crypto.randomUUID());
      const dataNode = node.data && typeof node.data === "object" ? node.data as Record<string, unknown> : {};
      const selectedModel = [
        dataNode.modelId,
        dataNode.modelKey,
        dataNode.imageModel,
        dataNode.videoModel,
      ].find((value) => typeof value === "string" && value.trim().includes(":"));
      return {
        ...node,
        id,
        nodeUuid: id,
        type: node.type ?? "taskNode",
        kind: mapTapKind(node),
        position: node.position ?? { x: 80, y: 80 },
        data: {
          ...dataNode,
          ...(typeof selectedModel === "string" ? { modelId: selectedModel.trim() } : {}),
        },
      };
    }),
    edges: rawEdges.map((edge) => {
      const id = String(edge.edgeUuid ?? edge.id ?? crypto.randomUUID());
      const source = String(edge.sourceNodeUuid ?? edge.source ?? "");
      const target = String(edge.targetNodeUuid ?? edge.target ?? "");
      return {
        ...edge,
        id,
        edgeUuid: id,
        source,
        target,
        sourceNodeUuid: source,
        targetNodeUuid: target,
        type: edge.type ?? "typed",
      };
    }),
    viewport,
  };
}

let createProjectHookForTests: ((session: CentralSession, name: string) => Promise<OverlayProject>) | undefined;
let homePlanHookForTests: ((projectUuid: string, input: Parameters<typeof runHomePlan>[1]) => Promise<unknown>) | undefined;
let textInvokeHookForTests: ((modelKey: string, input: Record<string, unknown>) => Promise<{ text?: unknown }>) | undefined;

export function setTapCanvasCreateProjectForTests(
  hook: ((session: CentralSession, name: string) => Promise<OverlayProject>) | null,
): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  createProjectHookForTests = hook ?? undefined;
}

export function setTapCanvasHomePlanForTests(
  hook: ((projectUuid: string, input: Parameters<typeof runHomePlan>[1]) => Promise<unknown>) | null,
): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  homePlanHookForTests = hook ?? undefined;
}

export function setTapCanvasTextInvokeForTests(
  hook: ((modelKey: string, input: Record<string, unknown>) => Promise<{ text?: unknown }>) | null,
): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  textInvokeHookForTests = hook ?? undefined;
}

async function invokeHomePlan(projectUuid: string, input: Parameters<typeof runHomePlan>[1]): Promise<unknown> {
  if (homePlanHookForTests) return homePlanHookForTests(projectUuid, input);
  return runHomePlan(projectUuid, input);
}

async function invokeTextModel(modelKey: string, input: Record<string, unknown>): Promise<{ text?: unknown }> {
  if (textInvokeHookForTests) return textInvokeHookForTests(modelKey, input);
  return u.Ai.Text(modelKey as never).invoke(input as never) as Promise<{ text?: unknown }>;
}

async function persistFlow(
  projectId: string,
  session: CentralSession | undefined,
  data: Record<string, unknown>,
  expectedRevision?: number,
): Promise<CanvasDocumentEnvelope> {
  const graph = normalizeGraph(data);
  return withOpenPersonalCanvasProject(projectId, "write", async () => {
    const current = await readCanvasDocument(projectId).catch(() => ({
      revision: 0,
      document: emptyCanvasDocument(),
    }));
    return saveCanvasDocument(projectId, {
      baseRevision: Number(expectedRevision ?? current.revision),
      clientMutationId: crypto.randomUUID(),
      document: {
        schemaVersion: 1,
        graph: { nodes: graph.nodes, edges: graph.edges },
        viewport: graph.viewport,
        preferences: current.document.preferences,
      },
    });
  }, session);
}

async function createCanvasProject(session: CentralSession, name: string): Promise<OverlayProject> {
  if (createProjectHookForTests) return createProjectHookForTests(session, name);
  const now = new Date().toISOString();
  const created = await centralAuthGateway.forwardBusinessRequest(
    session,
    "/api/tianjiang/v1/projects",
    "POST",
    {
      name,
      scope: "personal",
      businessType: "canvas",
      description: "",
      artStyle: "",
      aspectRatio: "",
      defaultLanguage: "",
      clientCreateRequestId: crypto.randomUUID(),
    },
  ) as { projectUuid?: string; name?: string };
  const projectUuid = String(created?.projectUuid ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(projectUuid)) {
    throw Object.assign(new Error("云端没有返回有效的画布项目 ID"), { status: 502 });
  }
  // 中文注释：项目必须进入云端目录并成功打开，禁止创建重启即丢失的内存项目。
  await syncCoordinator.refreshProjectCatalog(session);
  await syncCoordinator.openProject(session, projectUuid);
  await initializeCanvasWorkspace(projectUuid);
  const dto: OverlayProject = {
    id: projectUuid,
    name,
    createdAt: now,
    updatedAt: now,
    owner: session.user.username,
    ownerName: session.user.nickname || session.user.username,
    access: "owner",
    projectKind: "creative",
    teamShared: false,
  };
  return dto;
}

type CatalogModel = {
  id: number;
  modelName: string;
  requestModelKey: string;
  routingAliases: string[];
  displayLabel: string;
  description: string;
  icon: null;
  tags: string[];
  vendorId: string | null;
  endpoints: string[];
  runtimeEndpoints: string[];
  kind: "text" | "image" | "video" | "audio";
  enabled: boolean;
  syncOfficial: boolean;
  nameRule: number;
  createdTime: number;
  updatedTime: number;
  meta: Record<string, unknown>;
  pricing: { cost: number; enabled: boolean; specCosts: unknown[] };
};

async function tianjiangModels(): Promise<CatalogModel[]> {
  const mapped: CatalogModel[] = [];
  try {
    const native = listNativeDreaminaModels("all");
    for (const [index, item] of native.entries()) {
      const kind = String((item as { type?: string }).type ?? "image");
      const value = String((item as { value?: string }).value ?? (item as { modelName?: string }).modelName ?? `native-${index}`);
      mapped.push({
        id: 1000 + index,
        modelName: value,
        requestModelKey: value,
        routingAliases: [value],
        displayLabel: String((item as { label?: string }).label ?? value),
        description: "天将当前账号的即梦本地模型",
        icon: null,
        tags: ["tianjiang", kind],
        vendorId: String((item as { providerId?: string }).providerId ?? "dreamina-cli"),
        endpoints: [],
        runtimeEndpoints: [],
        kind: (kind === "video" || kind === "audio" || kind === "text" ? kind : "image") as "text" | "image" | "video" | "audio",
        enabled: true,
        syncOfficial: false,
        nameRule: 0,
        createdTime: Date.now(),
        updatedTime: Date.now(),
        meta: {
          providerId: String((item as { providerId?: string }).providerId ?? "dreamina-cli"),
          tianjiang: true,
          catalog: "native",
        },
        pricing: { cost: 0, enabled: true, specCosts: [] },
      });
    }
  } catch {
    // 中文注释：原生目录失败时继续读取账号供应商，但不伪造可执行模型。
  }
  try {
    const dataList = await u.accountDb("o_vendorConfig").select("id").where("enable", 1);
    const vendorRows = Array.isArray(dataList) ? dataList : [];
    let offset = 2000;
    for (const row of vendorRows) {
      try {
        const providerId = String(row.id ?? "").trim();
        if (!providerId) continue;
        const vendorData = u.vendor.getVendor(providerId);
        const models = await u.vendor.getModelList(providerId);
        for (const item of models as Array<{ name: string; modelName: string; type: string }>) {
          const kind = item.type === "video" || item.type === "audio" || item.type === "text" ? item.type : "image";
          mapped.push({
            id: offset++,
            modelName: item.modelName,
            requestModelKey: `${providerId}:${item.modelName}`,
            routingAliases: [item.modelName],
            displayLabel: item.name || item.modelName,
            description: `${vendorData.name} 当前账号已启用模型`,
            icon: null,
            tags: ["tianjiang", kind, String(row.id)],
            vendorId: providerId,
            endpoints: [],
            runtimeEndpoints: [],
            kind,
            enabled: true,
            syncOfficial: false,
            nameRule: 0,
            createdTime: Date.now(),
            updatedTime: Date.now(),
            meta: { providerId, tianjiang: true, catalogVendor: providerId },
            pricing: { cost: 0, enabled: true, specCosts: [] },
          });
        }
      } catch {
        // 中文注释：单个供应商模板失败不得拖垮其他真实供应商目录。
      }
    }
  } catch {
    // 中文注释：账号库不可用时返回已读取到的原生目录，不得声明虚假 readiness。
  }
  return mapped;
}

async function catalogModels(filters: {
  kind?: string;
  enabled?: boolean;
  selectable?: boolean;
} = {}) {
  const live = await tianjiangModels();
  const seen = new Set<string>();
  return live.filter((item) => {
    if (seen.has(item.requestModelKey)) return false;
    seen.add(item.requestModelKey);
    if (filters.kind && item.kind !== filters.kind) return false;
    if (filters.enabled === true && !item.enabled) return false;
    if (filters.enabled === false && item.enabled) return false;
    if (filters.selectable === true && !item.enabled) return false;
    return true;
  });
}

function flowEnvelopeDto(
  projectId: string,
  envelope: { revision: number; updatedAt?: string; document: { graph: { nodes: unknown[]; edges: unknown[] }; viewport?: unknown } },
  name = "画布",
  dataAdjusted = false,
) {
  const data = {
    nodes: envelope.document.graph.nodes ?? [],
    edges: envelope.document.graph.edges ?? [],
    viewport: envelope.document.viewport ?? { x: 0, y: 0, zoom: 1 },
  };
  const updatedAt = envelope.updatedAt ?? new Date().toISOString();
  return {
    id: projectId,
    name,
    ownerType: "project" as const,
    ownerId: projectId,
    data,
    dataAdjusted,
    canvasRevision: envelope.revision,
    revision: envelope.revision,
    createdAt: updatedAt,
    updatedAt,
  };
}

function catalogProvider(item: CatalogModel): string {
  return String(item.meta.providerId ?? item.vendorId ?? "").trim();
}

router.get("/auth/session", (req, res) => {
  const session = sessionOf(req);
  if (!session?.user) {
    res.status(401).send({ error: "unauthenticated" });
    return;
  }
  res.status(200).send({ authenticated: true, user: userDto(session) });
});

router.get("/projects", async (req, res) => {
  const session = sessionOf(req);
  if (!session) {
    res.status(401).send({ error: "unauthenticated" });
    return;
  }
  if (TAPCANVAS_HIDE_TEAM && req.query.teamId && !isPersonalCanvasTeamId(req.query.teamId)) {
    res.status(200).send(req.query.limit ? { items: [], nextCursor: null } : []);
    return;
  }
  const items = await listUserProjects(session);
  if (req.query.limit) {
    res.status(200).send({ items, nextCursor: null });
    return;
  }
  res.status(200).send(items);
});

router.post("/projects", async (req, res) => {
  const session = sessionOf(req);
  if (!session) {
    res.status(401).send({ error: "unauthenticated" });
    return;
  }
  if (rejectDisabledTeamCanvas(res, req.body?.teamId)) return;
  const name = String(req.body?.name ?? "未命名画布").trim() || "未命名画布";
  if (req.body?.id) {
    const id = String(req.body.id);
    const current = (await listUserProjects(session)).find((item) => item.id === id);
    if (!current) {
      res.status(404).send({ error: "project_not_found", message: "画布项目不存在或当前账号无权访问" });
      return;
    }
    const aliases = await readProjectAliases();
    const updatedAt = new Date().toISOString();
    aliases[id] = { name: name.slice(0, 120), updatedAt };
    await writeAccountJsonSetting(TAPCANVAS_PROJECT_ALIAS_SETTING_KEY, aliases);
    res.status(200).send({ ...current, name: aliases[id].name, updatedAt });
    return;
  }
  const created = await createCanvasProject(session, name);
  res.status(200).send(created);
});

router.post("/projects/bootstrap", async (req, res) => {
  const session = sessionOf(req);
  if (!session) {
    res.status(401).send({ error: "unauthenticated" });
    return;
  }
  if (rejectDisabledTeamCanvas(res, req.body?.teamId)) return;
  const name = String(req.body?.name ?? "未命名画布").trim() || "未命名画布";
  const generatePrompt = String(req.body?.prompt ?? "").trim();
  let created: OverlayProject;
  try {
    created = await createCanvasProject(session, name.slice(0, 40));
  } catch (error) {
    writeTapCanvasError(res, error);
    return;
  }
  const incoming = req.body?.flow?.data && typeof req.body.flow.data === "object"
    ? req.body.flow.data as Record<string, unknown>
    : {};
  try {
    let envelope: CanvasDocumentEnvelope;
    if (Array.isArray(incoming.nodes) && (incoming.nodes as unknown[]).length > 0) {
      envelope = await persistFlow(created.id, session, normalizeGraph(incoming), 0);
    } else if (generatePrompt) {
      const clientChatRequestId = crypto.randomUUID();
      const requestDigest = crypto.createHash("sha256").update(JSON.stringify({
        projectUuid: created.id,
        prompt: generatePrompt,
        clientChatRequestId,
      })).digest("hex");
      await withOpenPersonalCanvasProject(created.id, "write", () => invokeHomePlan(created.id, {
        prompt: generatePrompt,
        ...(typeof req.body?.modelId === "string" && req.body.modelId.trim()
          ? { modelId: req.body.modelId.trim() }
          : {}),
        attachmentAssetUuids: [],
        baseRevision: 0,
        clientChatRequestId,
        requestDigest,
      }), session);
      envelope = await withOpenPersonalCanvasProject(created.id, "read", () => readCanvasDocument(created.id), session);
    } else {
      envelope = await persistFlow(created.id, session, normalizeGraph(incoming), 0);
    }
    res.status(200).send({
      status: "complete",
      project: created,
      flow: flowEnvelopeDto(created.id, envelope, String(req.body?.flow?.name ?? "画布")),
    });
  } catch (error) {
    res.status(200).send({
      status: "partial",
      project: created,
      error: error instanceof Error ? error.message : "画布初始化未完成，可稍后打开项目恢复",
    });
  }
});

router.get("/projects/public", (_req, res) => {
  res.status(200).send([]);
});

router.get("/projects/:id/default-entry", (req, res) => {
  res.status(200).send({
    projectId: req.params.id,
    ownerType: "project",
    ownerId: req.params.id,
  });
});

router.get("/projects/:id/chapters", (_req, res) => {
  res.status(200).send({ items: [] });
});

router.get("/projects/:id", async (req, res) => {
  const session = sessionOf(req);
  if (!session) {
    res.status(401).send({ error: "unauthenticated" });
    return;
  }
  const found = (await listUserProjects(session)).find((item) => item.id === req.params.id);
  if (!found) {
    res.status(404).send({ error: "project not found" });
    return;
  }
  res.status(200).send(found);
});

router.get("/flows", async (req, res) => {
  const projectId = String(req.query.projectId ?? "");
  if (!projectId) {
    res.status(200).send([]);
    return;
  }
  try {
    const envelope = await withOpenPersonalCanvasProject(projectId, "read", async () => readCanvasDocument(projectId), sessionOf(req));
    res.status(200).send([flowEnvelopeDto(projectId, envelope)]);
  } catch (error) {
    writeTapCanvasError(res, error);
  }
});

router.get("/flows/:id", async (req, res) => {
  const projectId = String(req.params.id ?? "");
  try {
    const envelope = await withOpenPersonalCanvasProject(projectId, "read", async () => readCanvasDocument(projectId), sessionOf(req));
    res.status(200).send(flowEnvelopeDto(projectId, envelope));
  } catch (error) {
    res.status(404).send({ error: error instanceof Error ? error.message : "flow not found" });
  }
});

router.post("/flows", async (req, res) => {
  const projectId = String(req.body?.projectId ?? req.body?.ownerId ?? req.body?.id ?? "");
  try {
    const rawData = req.body?.data && typeof req.body.data === "object"
      ? req.body.data as Record<string, unknown>
      : {};
    const normalized = normalizeGraph(rawData);
    const inputGraph = {
      nodes: Array.isArray(rawData.nodes) ? rawData.nodes : [],
      edges: Array.isArray(rawData.edges) ? rawData.edges : [],
      viewport: rawData.viewport ?? { x: 0, y: 0, zoom: 1 },
    };
    const dataAdjusted = JSON.stringify(inputGraph) !== JSON.stringify(normalized);
    const saved = await persistFlow(
      projectId,
      sessionOf(req),
      normalized,
      req.body?.expectedRevision,
    );
    const dto = flowEnvelopeDto(projectId, saved, String(req.body?.name ?? "画布"), dataAdjusted);
    res.status(200).send(dto);
  } catch (error) {
    if (error instanceof CanvasRuntimeError && error.errorCode === "CANVAS_REVISION_CONFLICT") {
      try {
        const current = await withOpenPersonalCanvasProject(projectId, "read", () => readCanvasDocument(projectId), sessionOf(req));
        res.status(409).send({
          code: "flow_revision_conflict",
          message: error.message,
          canvasRevision: current.revision,
          data: flowEnvelopeDto(projectId, current).data,
        });
        return;
      } catch {
        // 读取失败仍返回稳定冲突码。
      }
      res.status(409).send({
        code: "flow_revision_conflict",
        message: error instanceof Error ? error.message : "画布版本冲突",
      });
      return;
    }
    writeTapCanvasError(res, error);
  }
});

router.get("/public/projects", (_req, res) => {
  res.status(200).send([]);
});

router.get("/models/available", async (_req, res) => {
  const items = await catalogModels();
  res.status(200).send(items.map((item) => ({
    id: item.requestModelKey,
    name: item.displayLabel,
    kind: item.kind,
    providerId: catalogProvider(item),
    vendor: catalogProvider(item),
  })));
});

router.get("/model-catalog/models", async (_req, res) => {
  const items = await catalogModels();
  res.status(200).send({
    items: items.map((item) => ({
      key: item.requestModelKey,
      name: item.displayLabel,
      kind: item.kind,
      providerId: catalogProvider(item),
    })),
  });
});

router.get("/new-api-models/readiness", async (_req, res) => {
  const items = await catalogModels({ enabled: true, selectable: true });
  const providerCount = new Set(items.map(catalogProvider).filter(Boolean)).size;
  const ready = items.length > 0;
  res.status(200).send({
    ready,
    enabledModelCount: items.length,
    configuredChannelCount: providerCount,
    executableModelCount: items.length,
    reasons: ready ? [] : ["no_enabled_models"],
    setupUrl: "https://tianjiang.local/settings/models",
  });
});

router.get("/new-api-models", async (req, res) => {
  const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
  const enabled = req.query.enabled === "true" ? true : req.query.enabled === "false" ? false : undefined;
  const selectable = req.query.selectable === "true";
  res.status(200).send(await catalogModels({ kind, enabled, selectable }));
});

router.get("/billing/models", async (_req, res) => {
  const items = await catalogModels();
  res.status(200).send(items.map((item) => ({
    modelKey: item.requestModelKey,
    labelZh: item.displayLabel,
    kind: item.kind,
    vendor: catalogProvider(item),
  })));
});

router.get("/billing/model-costs", (_req, res) => {
  res.status(200).send([]);
});

router.get("/project-directory", async (req, res) => {
  if (!sessionOf(req)) {
    res.status(401).send({ error: "unauthenticated" });
    return;
  }
  const raw = await readAccountJsonSetting<unknown>(TAPCANVAS_DIRECTORY_SETTING_KEY, emptyDirectory());
  try {
    res.status(200).send(normalizeProjectDirectory(raw));
  } catch {
    // 中文注释：损坏的历史目录只影响目录视图，不得阻断账号登录和画布打开。
    res.status(200).send(emptyDirectory());
  }
});

router.put("/project-directory", async (req, res) => {
  if (!sessionOf(req)) {
    res.status(401).send({ error: "unauthenticated" });
    return;
  }
  const incomingId = req.body?.assetId;
  const next = normalizeProjectDirectory({
    assetId: typeof incomingId === "string" && incomingId.trim() ? incomingId : crypto.randomUUID(),
    updatedAt: new Date().toISOString(),
    state: req.body?.state ?? emptyDirectory().state,
  });
  await writeAccountJsonSetting(TAPCANVAS_DIRECTORY_SETTING_KEY, next);
  res.status(200).send(next);
});

router.post("/assets/upload", async (req, res) => {
  const projectId = String(req.query.projectId ?? "").trim();
  const session = sessionOf(req);
  if (!projectId || !session) {
    writeTapCanvasError(res, Object.assign(new Error("项目不存在或不可见"), {
      status: 403,
      errorCode: "PERMISSION_DENIED",
    }));
    return;
  }
  try {
    const queryName = String(req.query.name ?? "").trim();
    const headerName = String(req.headers["x-file-name"] ?? "").trim();
    const result = await withOpenPersonalCanvasProject(projectId, "write", () => uploadTapCanvasAsset(req, projectId, {
      declaredMime: String(req.headers["content-type"] ?? ""),
      originalName: queryName || headerName || "未命名素材",
      userId: String(session.user.id),
      ownerNodeId: String(req.query.ownerNodeId ?? ""),
    }), session);
    res.status(201).send(result);
  } catch (error) {
    writeTapCanvasError(res, error);
  }
});

router.get("/assets/books", async (req, res) => {
  const session = sessionOf(req);
  const projectId = String(req.query.projectId ?? "").trim();
  if (!session) {
    res.status(401).send({ error: "unauthenticated" });
    return;
  }
  if (!projectId) {
    res.status(400).send({ code: "project_id_required", message: "必须指定个人画布项目" });
    return;
  }
  try {
    const items = await withOpenPersonalCanvasProject(projectId, "read", async () => {
      const rows = await readProjectNovels();
      return toBookListItems(projectId, rows);
    }, session);
    res.status(200).send(items);
  } catch (error) {
    writeTapCanvasError(res, error);
  }
});

router.get("/assets/books/:bookId/index", async (req, res) => {
  const session = sessionOf(req);
  const projectId = String(req.query.projectId ?? "").trim();
  const bookId = String(req.params.bookId ?? "").trim();
  if (!session) {
    res.status(401).send({ error: "unauthenticated" });
    return;
  }
  if (!projectId) {
    res.status(400).send({ code: "project_id_required", message: "必须指定个人画布项目" });
    return;
  }
  const parsed = parseCompatBookId(bookId);
  if (!parsed) {
    res.status(400).send({ code: "book_id_invalid", message: "书籍 ID 无效" });
    return;
  }
  if (parsed.projectUuid.toLowerCase() !== projectId.toLowerCase()) {
    res.status(403).send({ code: "book_project_mismatch", message: "书籍不属于当前个人画布项目" });
    return;
  }
  try {
    const index = await withOpenPersonalCanvasProject(projectId, "read", async () => {
      const rows = await readProjectNovels();
      const grouped = toBookListItems(projectId, rows);
      const found = grouped.find((item) => item.bookId === compatBookId(projectId, parsed.novelProjectId));
      if (!found) {
        throw Object.assign(new Error("书籍不存在或不属于当前项目"), {
          status: 404,
          errorCode: "book_not_found",
        });
      }
      const chapters = rows.filter((row) => novelGroupKey(row) === parsed.novelProjectId);
      const bounds = chapterOffsetBounds(chapters);
      return {
        bookId: found.bookId,
        projectId,
        title: found.title,
        chapterCount: found.chapterCount,
        updatedAt: found.updatedAt,
        rawPath: "",
        chapters: bounds,
      };
    }, session);
    res.status(200).send(index);
  } catch (error) {
    writeTapCanvasError(res, error);
  }
});

router.get("/assets", async (req, res) => {
  const projectId = String(req.query.projectId ?? "");
  if (!projectId) {
    res.status(200).send({ items: [], cursor: null });
    return;
  }
  try {
    const rows = await withOpenPersonalCanvasProject(projectId, "read", async () => listCanvasAssets(), sessionOf(req));
    res.status(200).send({
      items: rows.map((row) => ({
        id: row.assetUuid,
        name: String(row.metadata?.originalName ?? row.relativePath),
        data: {
          url: publicTaskAssetUrl(projectId, row.relativePath),
          kind: "upload",
          assetKind: row.relativePath.includes("/videos/")
            ? "video"
            : row.relativePath.includes("/audio/")
              ? "audio"
              : row.relativePath.includes("/documents/")
                ? "document"
                : "image",
          mimeType: row.mimeType,
          contentType: row.mimeType,
          originalName: String(row.metadata?.originalName ?? row.relativePath),
          size: row.sizeBytes,
          sizeBytes: row.sizeBytes,
          sha256: row.sha256,
          md5: row.md5,
          lifecycleState: row.lifecycleState,
        },
        createdAt: row.createdAt,
        updatedAt: row.createdAt,
        userId: String(sessionOf(req)?.user.id ?? ""),
        projectId,
      })),
      cursor: null,
    });
  } catch {
    res.status(200).send({ items: [], cursor: null });
  }
});

function writeTapCanvasError(res: express.Response, error: unknown): void {
  const status = error instanceof TapCanvasTaskContractError
    ? error.status
    : Number((error as { status?: unknown })?.status ?? 422);
  const errorCode = error instanceof TapCanvasTaskContractError
    ? error.code
    : String((error as { errorCode?: unknown; code?: unknown })?.errorCode
      ?? (error as { code?: unknown })?.code
      ?? "TAPCANVAS_RUNTIME_ERROR");
  res.status(Number.isInteger(status) ? status : 422).send({
    code: errorCode,
    message: error instanceof Error ? error.message : "TapCanvas 请求失败",
  });
}

function providerFromModel(modelKey: string): string {
  return modelKey.split(/:(.+)/)[0] ?? "";
}

function projectIdFromSessionKey(value: unknown): string {
  const sessionKey = typeof value === "string" ? value.trim() : "";
  const match = /^project:([^:]+)/.exec(sessionKey);
  return match?.[1]?.trim() ?? "";
}

function resolveProjectScope(explicitProjectId: unknown, sessionKey: unknown): string {
  const explicit = typeof explicitProjectId === "string" ? explicitProjectId.trim() : "";
  const derived = projectIdFromSessionKey(sessionKey);
  if (explicit && derived && explicit !== derived) {
    throw Object.assign(new Error("对话会话与画布项目不匹配"), {
      status: 400,
      errorCode: "chat_session_project_mismatch",
    });
  }
  return explicit || derived;
}

async function requireTextModel(modelKey: string): Promise<void> {
  // universalAi 是天将账号内的权威文本映射键；显式供应商模型必须来自当前账号目录。
  if (modelKey === "universalAi") return;
  const catalog = await catalogModels({ kind: "text", enabled: true, selectable: true });
  if (!catalog.some((item) => item.requestModelKey === modelKey)) {
    throw Object.assign(new Error("文本模型不存在、未启用或类型不匹配"), {
      status: 400,
      errorCode: "text_model_unavailable",
    });
  }
}

function publicTaskAssetUrl(projectUuid: string, relativePath: string): string {
  const suffix = relativePath.replace(/^files\//, "").split("/").map(encodeURIComponent).join("/");
  return `/api/tianjiang/runtime/projects/${encodeURIComponent(projectUuid)}/files/${suffix}`;
}

router.post("/public/tasks", async (req, res) => {
  try {
    const request = req.body?.request && typeof req.body.request === "object"
      ? req.body.request as Record<string, unknown>
      : {};
    const taskKind = String(request.kind ?? "");
    if (taskKind === "chat" || taskKind === "prompt_refine") {
      const extras = request.extras && typeof request.extras === "object"
        ? request.extras as Record<string, unknown>
        : {};
      const modelKey = String(extras.modelKey ?? "universalAi").trim() || "universalAi";
      await requireTextModel(modelKey);
      const output = await invokeTextModel(modelKey, {
        prompt: String(request.prompt ?? ""),
      });
      res.status(200).send({
        vendor: modelKey.includes(":") ? providerFromModel(modelKey) : "tianjiang",
        result: {
          id: crypto.randomUUID(),
          kind: taskKind,
          status: "succeeded",
          assets: [],
          raw: { text: String(output.text ?? "") },
        },
      });
      return;
    }

    const parsed = parseTapCanvasTaskRequest(req.body);
    const catalog = await catalogModels({ enabled: true, selectable: true });
    const model = catalog.find((item) => item.requestModelKey === parsed.modelKey);
    if (!model) {
      throw Object.assign(new Error("图片/视频模型不存在、未启用或不可执行"), {
        status: 400,
        errorCode: "media_model_unavailable",
      });
    }
    if (parsed.mediaType === "video" && model.kind !== "video") {
      throw Object.assign(new Error("视频任务必须选择视频模型"), { status: 400, errorCode: "media_model_kind" });
    }
    if (parsed.mediaType === "image" && model.kind !== "image") {
      throw Object.assign(new Error("图片任务必须选择图片模型"), { status: 400, errorCode: "media_model_kind" });
    }
    if (!parsed.confirmation) {
      const preview = await withOpenPersonalCanvasProject(parsed.projectUuid, "write", async () => {
        const current = await readCanvasDocument(parsed.projectUuid);
        const node = (current.document.graph.nodes ?? []).find((item) => (
          String((item as { nodeUuid?: unknown }).nodeUuid ?? "") === parsed.nodeUuid
        )) as { data?: Record<string, unknown> } | undefined;
        const persistedModel = String(node?.data?.modelId ?? "");
        if (persistedModel !== parsed.modelKey) {
          throw Object.assign(new Error("画布节点模型尚未保存或已变化，请保存后重试"), { status: 409 });
        }
        return previewCanvasExecution(parsed.projectUuid, {
          baseRevision: current.revision,
          nodeUuids: [parsed.nodeUuid],
        });
      }, sessionOf(req)) as {
        confirmationUuid: string;
        requestDigest: string;
        documentRevision: number;
        paidItemCount: number;
        items: Array<{ providerId?: string; chargeNotice?: string }>;
      };
      res.status(409).send({
        code: "confirmation_required",
        confirmationUuid: preview.confirmationUuid,
        requestDigest: preview.requestDigest,
        baseRevision: preview.documentRevision,
        fee: {
          displayText: preview.items.find((item) => item.chargeNotice)?.chargeNotice
            ?? "该任务可能产生费用，请确认后执行",
        },
        provider: String(preview.items[0]?.providerId ?? providerFromModel(parsed.modelKey)),
        paidItemCount: preview.paidItemCount,
        message: "收费任务必须先预览并确认",
      });
      return;
    }

    const confirmed = await withOpenPersonalCanvasProject(parsed.projectUuid, "write", () => (
      confirmCanvasExecution(parsed.projectUuid, parsed.confirmation!)
    ), sessionOf(req)) as { runs?: Array<{ runUuid?: string; nodeUuid?: string; state?: string }> };
    const run = confirmed.runs?.find((item) => item.nodeUuid === parsed.nodeUuid) ?? confirmed.runs?.[0];
    if (!run?.runUuid) throw Object.assign(new Error("画布执行确认后没有返回运行 ID"), { status: 502 });
    res.status(202).send({
      vendor: providerFromModel(parsed.modelKey),
      result: {
        id: encodeTapCanvasTaskId(parsed.projectUuid, run.runUuid),
        kind: parsed.taskKind,
        status: "queued",
        assets: [],
        raw: { state: run.state ?? "waiting_for_origin_device", nodeUuid: parsed.nodeUuid },
      },
    });
  } catch (error) {
    writeTapCanvasError(res, error);
  }
});

router.post("/public/tasks/result", async (req, res) => {
  try {
    const identity = decodeTapCanvasTaskId(String(req.body?.taskId ?? ""));
    const taskKind = String(req.body?.taskKind ?? "text_to_image");
    const data = await withOpenPersonalCanvasProject(identity.projectUuid, "read", async () => {
      const executions = await listCanvasExecutions(identity.projectUuid);
      const run = executions.runs.find((item) => String(item.runUuid ?? "") === identity.runUuid);
      if (!run) throw Object.assign(new Error("画布执行任务不存在"), { status: 404 });
      const document = await readCanvasDocument(identity.projectUuid);
      const node = (document.document.graph.nodes ?? []).find((item) => (
        String((item as { nodeUuid?: unknown }).nodeUuid ?? "") === String(run.nodeUuid ?? "")
      )) as { data?: Record<string, unknown> } | undefined;
      const modelKey = String(node?.data?.modelId ?? "");
      const assetUuid = String(node?.data?.assetUuid ?? "");
      const assets = assetUuid
        ? (await listCanvasAssets()).filter((item) => item.assetUuid === assetUuid).map((item) => ({
            type: item.relativePath.includes("/videos/") ? "video" : "image",
            url: publicTaskAssetUrl(identity.projectUuid, item.relativePath),
            assetId: item.assetUuid,
          }))
        : [];
      return { run, modelKey, assets };
    }, sessionOf(req));
    res.status(200).send({
      vendor: providerFromModel(data.modelKey),
      result: {
        id: String(req.body.taskId),
        kind: taskKind,
        status: mapCanvasRunState(String(data.run.state ?? "queued")),
        assets: data.assets,
        raw: {
          state: data.run.state,
          failureReason: data.run.failureText,
          updatedAt: data.run.updatedAt,
        },
      },
    });
  } catch (error) {
    writeTapCanvasError(res, error);
  }
});

router.post("/public/agents/chat", async (req, res) => {
  const prompt = String(req.body?.prompt ?? req.body?.message ?? "");
  if (req.body?.queueMode) {
    res.status(501).send({
      code: "TAPCANVAS_AGENT_QUEUE_UNSUPPORTED",
      message: "持久 Agent 队列尚未接入，当前可直接使用右侧 AI 对话",
    });
    return;
  }
  try {
    const requested = String(req.body?.modelKey ?? "").trim();
    const modelKey = requested || "universalAi";
    const sessionKey = String(req.body?.sessionKey ?? "").trim();
    const projectId = resolveProjectScope(
      req.body?.canvasProjectId ?? req.body?.projectId ?? req.body?.context?.projectId,
      sessionKey,
    );
    const session = sessionOf(req);
    // 在调用可能产生费用的账号模型前先完成项目授权；写入时会再次进入写门复核。
    if (projectId && session) {
      await withOpenPersonalCanvasProject(projectId, "read", async () => undefined, session);
    }
    await requireTextModel(modelKey);
    const output = await invokeTextModel(modelKey, { prompt });
    const text = String(output.text ?? "");
    if (projectId && session && prompt) {
      const ids = newMemoryIds();
      const persistedSessionKey = sessionKey || `project:${projectId}`;
      const nowMs = Date.now();
      const userCreatedAt = new Date(nowMs).toISOString();
      const assistantCreatedAt = new Date(nowMs + 1).toISOString();
      await withOpenPersonalCanvasProject(projectId, "write", () => appendMemoryTurns([
        {
          sessionKey: persistedSessionKey,
          sessionId: ids.sessionId,
          messageId: ids.userMessageId,
          role: "user",
          content: prompt,
          createdAt: userCreatedAt,
          nodeIds: Array.isArray(req.body?.nodeIds) ? req.body.nodeIds.map(String) : [],
          modelKey,
        },
        {
          sessionKey: persistedSessionKey,
          sessionId: ids.sessionId,
          messageId: ids.assistantMessageId,
          role: "assistant",
          content: text,
          createdAt: assistantCreatedAt,
          nodeIds: [],
          modelKey,
        },
      ]), session);
    }
    const responseBody = {
      id: crypto.randomUUID(),
      vendor: modelKey.includes(":") ? providerFromModel(modelKey) : "tianjiang",
      modelKey,
      text,
      agentDecision: {
        executionKind: "answer",
        canvasAction: "none",
        assetCount: 0,
        projectStateRead: false,
        reason: "tianjiang-account-model",
      },
    };
    if (req.body?.stream || String(req.headers.accept ?? "").includes("text/event-stream")) {
      const turnId = `public-chat-turn:${crypto.randomUUID()}`;
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("X-Trace-ID", turnId);
      res.setHeader("X-Accel-Buffering", "no");
      const writeEvent = (sequence: number, event: string, data: unknown) => {
        res.write(`id: ${turnId}#${sequence}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      writeEvent(1, "initial", { requestId: turnId, messageId: responseBody.id });
      writeEvent(2, "content", { delta: text });
      writeEvent(3, "result", { response: responseBody });
      writeEvent(4, "done", { reason: "logical_succeeded" });
      res.end();
      return;
    }
    res.status(200).send(responseBody);
  } catch (error) {
    writeTapCanvasError(res, error);
  }
});

router.post("/public/agents/chat/status", (req, res) => {
  const sessionKey = String(req.body?.sessionKey ?? "").trim();
  if (!sessionKey) {
    res.status(400).send({ code: "chat_session_key_required", message: "sessionKey 不能为空" });
    return;
  }
  // 当前兼容层一次请求内完成文本回合；无后台 Agent 回合时返回权威空状态，避免前端持续 404 重试。
  res.status(200).send({
    sessionId: sessionKey,
    durable: true,
    activeTurn: false,
    turn: null,
  });
});

router.post("/agents/llm/v1/chat/completions", async (req, res) => {
  try {
    const modelKey = String(req.body?.model ?? "universalAi").trim() || "universalAi";
    await requireTextModel(modelKey);
    const messages = Array.isArray(req.body?.messages) ? req.body.messages as Array<Record<string, unknown>> : [];
    const system = messages.filter((item) => item.role === "system").map((item) => String(item.content ?? "")).join("\n");
    const prompt = messages.filter((item) => item.role !== "system").map((item) => String(item.content ?? "")).join("\n");
    const output = await invokeTextModel(modelKey, {
      ...(system ? { system } : {}),
      prompt,
      ...(Number.isFinite(Number(req.body?.temperature)) ? { temperature: Number(req.body.temperature) } : {}),
    });
    res.status(200).send({
      id: crypto.randomUUID(),
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: String(output.text ?? "") } }],
      provider: modelKey.includes(":") ? providerFromModel(modelKey) : "tianjiang",
      model: modelKey,
    });
  } catch (error) {
    writeTapCanvasError(res, error);
  }
});

router.get("/auth/generation-preferences", async (req, res) => {
  if (!sessionOf(req)) {
    res.status(401).send({ error: "unauthenticated" });
    return;
  }
  try {
    const prefs = await readGenerationPrefs();
    res.status(200).send({ prefs });
  } catch (error) {
    writeTapCanvasError(res, error);
  }
});

router.put("/auth/generation-preferences", async (req, res) => {
  if (!sessionOf(req)) {
    res.status(401).send({ error: "unauthenticated" });
    return;
  }
  try {
    const catalog = await catalogModels({ enabled: true, selectable: true });
    const prefs = await writeGenerationPrefs(req.body, catalog);
    res.status(200).send({ prefs });
  } catch (error) {
    if (error instanceof GenerationPrefsError) {
      res.status(error.status).send({ code: error.code, message: error.message });
      return;
    }
    writeTapCanvasError(res, error);
  }
});

router.post("/memory/context", async (req, res) => {
  const session = sessionOf(req);
  let projectId = "";
  try {
    projectId = resolveProjectScope(req.body?.projectId, req.body?.sessionKey);
  } catch (error) {
    writeTapCanvasError(res, error);
    return;
  }
  if (!session) {
    res.status(401).send({ error: "unauthenticated" });
    return;
  }
  if (!projectId) {
    res.status(200).send(emptyMemoryContext([]));
    return;
  }
  try {
    const recent = await withOpenPersonalCanvasProject(projectId, "read", () => loadRecentConversation({
      sessionKey: typeof req.body?.sessionKey === "string" ? req.body.sessionKey : undefined,
      limit: Number(req.body?.recentConversationLimit) || 20,
    }), session);
    res.status(200).send(emptyMemoryContext(recent));
  } catch (error) {
    writeTapCanvasError(res, error);
  }
});

router.post("/memory/project-sessions", async (req, res) => {
  const session = sessionOf(req);
  const projectId = String(req.body?.projectId ?? "").trim();
  if (!session) {
    res.status(401).send({ error: "unauthenticated" });
    return;
  }
  if (!projectId) {
    res.status(200).send({ items: [] });
    return;
  }
  try {
    const items = await withOpenPersonalCanvasProject(projectId, "read", () => listMemorySessions(Number(req.body?.limit) || 20), session);
    res.status(200).send({ items });
  } catch (error) {
    writeTapCanvasError(res, error);
  }
});

router.post("/memory/project-chat-artifacts", async (req, res) => {
  const session = sessionOf(req);
  const projectId = String(req.body?.projectId ?? "").trim();
  if (!session) {
    res.status(401).send({ error: "unauthenticated" });
    return;
  }
  if (!projectId) {
    res.status(200).send({ items: [] });
    return;
  }
  try {
    const items = await withOpenPersonalCanvasProject(projectId, "read", () => listMemoryArtifacts(
      Number(req.body?.limitSessions) || 10,
      Number(req.body?.limitTurns) || 20,
    ), session);
    res.status(200).send({ items });
  } catch (error) {
    writeTapCanvasError(res, error);
  }
});

router.get("/codex/bridges", async (req, res) => {
  if (!sessionOf(req)) {
    res.status(401).send({ error: "unauthenticated" });
    return;
  }
  const listed = await listCodexBridges();
  res.status(200).send({
    items: listed.items,
    status: listed.status,
    pairingRequired: listed.status !== "online",
    pairingHint: listed.status === "online"
      ? undefined
      : "本机尚未连接 Codex Bridge。请复制配对命令完成首次安装，在线前不会谎报可派发。",
  });
});

router.post("/codex/pairings", async (req, res) => {
  if (!sessionOf(req)) {
    res.status(401).send({ error: "unauthenticated" });
    return;
  }
  const pairing = await createCodexPairing();
  res.status(200).send(pairing);
});

router.get("/codex/tasks", async (req, res) => {
  if (!sessionOf(req)) {
    res.status(401).send({ error: "unauthenticated" });
    return;
  }
  const items = await listCodexTasks(Number(req.query.limit) || 20);
  res.status(200).send({ items });
});

router.get("/codex/tasks/:taskId", async (req, res) => {
  if (!sessionOf(req)) {
    res.status(401).send({ error: "unauthenticated" });
    return;
  }
  const task = await getCodexTask(String(req.params.taskId));
  if (!task) {
    res.status(404).send({ code: "codex_task_not_found", message: "Codex 任务不存在" });
    return;
  }
  res.status(200).send(task);
});

router.post("/codex/tasks", async (req, res) => {
  const session = sessionOf(req);
  if (!session) {
    res.status(401).send({ error: "unauthenticated" });
    return;
  }
  const created = await createCodexTask({
    userId: String(session.user.id),
    bridgeId: String(req.body?.bridgeId ?? ""),
    workspaceId: String(req.body?.workspaceId ?? "default"),
    sessionId: typeof req.body?.sessionId === "string" ? req.body.sessionId : null,
    parentTaskId: typeof req.body?.parentTaskId === "string" ? req.body.parentTaskId : null,
    goal: String(req.body?.goal ?? "").trim(),
    context: req.body?.context && typeof req.body.context === "object" ? req.body.context : {
      projectId: "",
      flowId: null,
      chapterId: null,
      canvasRevision: null,
      selectedNodeIds: [],
    },
    fallbackPolicy: req.body?.fallbackPolicy === "ask" ? "ask" : "disabled",
    idempotencyKey: String(req.body?.idempotencyKey ?? crypto.randomUUID()),
  });
  res.status(created.unpaired ? 200 : 200).send({
    task: created.task,
    deduplicated: created.deduplicated,
    queuePosition: created.queuePosition,
    unpaired: created.unpaired === true,
    pairingHint: created.unpaired
      ? "本机 Codex Bridge 离线或未配对，任务已持久化但不会假装在线执行"
      : undefined,
  });
});

router.get("/codex/tasks/:taskId/messages", async (req, res) => {
  if (!sessionOf(req)) {
    res.status(401).send({ error: "unauthenticated" });
    return;
  }
  const items = await listCodexTaskMessages(String(req.params.taskId));
  res.status(200).send({ items });
});

router.post("/codex/tasks/:taskId/messages", async (req, res) => {
  if (!sessionOf(req)) {
    res.status(401).send({ error: "unauthenticated" });
    return;
  }
  const created = await createCodexTaskMessage({
    taskId: String(req.params.taskId),
    text: String(req.body?.text ?? ""),
    idempotencyKey: String(req.body?.idempotencyKey ?? crypto.randomUUID()),
  });
  if (!created) {
    res.status(404).send({ code: "codex_task_not_found", message: "Codex 任务不存在" });
    return;
  }
  res.status(200).send(created);
});

router.post("/codex/tasks/:taskId/fallback", async (req, res) => {
  if (!sessionOf(req)) {
    res.status(401).send({ error: "unauthenticated" });
    return;
  }
  const decision = req.body?.decision === "approve" || req.body?.decision === "decline"
    ? req.body.decision
    : req.body?.approved === true ? "approve" : "decline";
  const task = await applyCodexFallback(String(req.params.taskId), { decision });
  if (!task) {
    res.status(404).send({ code: "codex_task_not_found", message: "Codex 任务不存在" });
    return;
  }
  res.status(200).send(task);
});

router.get("/codex/previews/:previewId", async (req, res) => {
  if (!sessionOf(req)) {
    res.status(401).send({ error: "unauthenticated" });
    return;
  }
  const preview = await resolveCodexPreview(String(req.params.previewId));
  if (!preview) {
    res.status(404).send({
      code: "codex_preview_unavailable",
      message: "预览不存在或 Bridge 尚未上报",
    });
    return;
  }
  res.status(200).send(preview);
});

router.get("/teams/me", (_req, res) => {
  res.status(404).send({ error: "team_disabled" });
});

router.get("/teams", (_req, res) => {
  res.status(200).send([]);
});

router.post("/teams", (_req, res) => {
  res.status(403).send({ error: "team_disabled", message: "暂不支持团队模式" });
});

router.post("/stats/ping", (_req, res) => {
  res.status(204).end();
});

router.get("/tasks/inbox", (_req, res) => {
  res.status(200).send({ items: [], unreadCount: 0, nextCursor: null, hasMore: false });
});

router.get("/executions", async (req, res) => {
  const projectId = String(req.query.projectId ?? "");
  if (!projectId) {
    res.status(200).send([]);
    return;
  }
  try {
    const data = await withOpenPersonalCanvasProject(projectId, "read", async () => listCanvasExecutions(projectId), sessionOf(req));
    res.status(200).send(data);
  } catch {
    res.status(200).send([]);
  }
});

router.get("/agents/diagnostics", async (req, res) => {
  const session = sessionOf(req);
  if (!session) {
    res.status(401).send({ error: "unauthenticated" });
    return;
  }
  const projectId = String(req.query.projectId ?? "").trim();
  if (!projectId) {
    res.status(200).send(emptyAgentDiagnostics(null));
    return;
  }
  try {
    const payload = await withOpenPersonalCanvasProject(projectId, "read", async () => {
      const listed = await listCanvasExecutions(projectId);
      const spans = listed.runs.map((run) => {
        const runUuid = String(run.runUuid ?? "");
        const state = String(run.state ?? "");
        const createdAt = String(run.createdAt ?? run.updatedAt ?? new Date(0).toISOString());
        const updatedAt = String(run.updatedAt ?? createdAt);
        const nodeUuid = String(run.nodeUuid ?? "");
        return {
          version: 1 as const,
          id: runUuid,
          traceId: runUuid,
          spanId: runUuid,
          parentSpanId: null,
          linkedSpanIds: [],
          requestId: null,
          threadId: null,
          turnId: null,
          service: "async-worker" as const,
          kind: "async_task" as const,
          name: nodeUuid || runUuid,
          status: mapCanvasRunStatus(state),
          startedAt: createdAt,
          finishedAt: state === "succeeded" || state === "failed" || state === "canceled" ? updatedAt : null,
          durationMs: null,
          scope: {
            projectId,
            bookId: null,
            chapterId: null,
            flowId: null,
            nodeId: nodeUuid || null,
            label: null,
            workflowKey: null,
          },
          modelKey: null,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costCredits: null,
          capturePolicy: "structural" as const,
          persistenceStatus: "persisted" as const,
          errorCode: run.failureText ? "canvas_run_failed" : null,
          attributes: {
            state,
            runUuid,
            nodeUuid,
          },
          createdAt,
        };
      });
      const traces = listed.runs.map((run) => {
        const runUuid = String(run.runUuid ?? "");
        const createdAt = String(run.createdAt ?? run.updatedAt ?? new Date(0).toISOString());
        const updatedAt = String(run.updatedAt ?? createdAt);
        const state = String(run.state ?? "");
        return {
          id: runUuid,
          scopeType: "project",
          scopeId: projectId,
          taskId: runUuid,
          requestKind: "canvas_execution",
          inputSummary: String(run.nodeUuid ?? ""),
          decisionLog: [],
          toolCalls: [],
          meta: { state },
          resultSummary: null,
          errorCode: run.failureText ? String(run.failureText) : null,
          errorDetail: run.failureText ? String(run.failureText) : null,
          createdAt,
          status: mapCanvasRunStatus(state),
          sessionKey: null,
          workflowKey: null,
          logicalTaskId: runUuid,
          rootTraceId: runUuid,
          parentTraceId: null,
          physicalRunId: runUuid,
          workflowRunId: null,
          startedAt: createdAt,
          updatedAt,
          finishedAt: state === "succeeded" || state === "failed" || state === "canceled" ? updatedAt : null,
          nextEventSeq: 0,
        };
      });
      return emptyAgentDiagnostics(projectId, { traces, spans });
    }, session);
    res.status(200).send(payload);
  } catch (error) {
    writeTapCanvasError(res, error);
  }
});

router.use((req, res) => {
  if (TAPCANVAS_HIDE_TEAM && req.path.includes("/teams")) {
    res.status(403).send({ error: "team_disabled", message: "暂不支持团队模式" });
    return;
  }
  res.status(404).send({
    code: "TAPCANVAS_ENDPOINT_NOT_IMPLEMENTED",
    message: `TapCanvas 接口尚未接入：${req.method} ${req.path}`,
  });
});

export default router;
