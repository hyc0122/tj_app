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
import { readCanvasDocument, saveCanvasDocument } from "@/tianjiang/canvas/canvas-document-service";
import { runHomePlan } from "@/tianjiang/canvas/canvas-chat-service";
import { uploadTapCanvasAsset } from "@/tianjiang/canvas/tapcanvas-asset-upload";
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

async function listUserProjects(session: CentralSession): Promise<OverlayProject[]> {
  const aliases = await readProjectAliases();
  const catalog = syncCoordinator.listProjects(session)
    .filter((item) => String((item as { businessType?: string }).businessType ?? "") === "canvas")
    .map((item) => {
      const dto = projectDtoFromCatalog(item, session);
      const alias = aliases[item.projectUuid];
      return alias ? { ...dto, name: alias.name, updatedAt: alias.updatedAt } : dto;
    });
  return catalog;
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

async function persistFlow(
  projectId: string,
  session: CentralSession | undefined,
  data: Record<string, unknown>,
  expectedRevision?: number,
): Promise<{ revision: number }> {
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

async function catalogModels() {
  const live = await tianjiangModels();
  const seen = new Set<string>();
  return live.filter((item) => {
    if (seen.has(item.requestModelKey)) return false;
    seen.add(item.requestModelKey);
    return true;
  });
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
  if (TAPCANVAS_HIDE_TEAM && req.query.teamId && req.query.teamId !== "personal") {
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
  if (TAPCANVAS_HIDE_TEAM && req.body?.teamId) {
    res.status(403).send({ error: "team_disabled", message: "暂不支持团队画布" });
    return;
  }
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
  if (TAPCANVAS_HIDE_TEAM && req.body?.teamId) {
    res.status(403).send({ error: "team_disabled", message: "暂不支持团队画布" });
    return;
  }
  const prompt = String(req.body?.name ?? req.body?.prompt ?? "").trim();
  const created = await createCanvasProject(session, prompt.slice(0, 40) || "未命名画布");
  const incoming = req.body?.flow?.data && typeof req.body.flow.data === "object"
    ? req.body.flow.data as Record<string, unknown>
    : {};
  if (Array.isArray(incoming.nodes) && (incoming.nodes as unknown[]).length > 0) {
    await persistFlow(created.id, session, normalizeGraph(incoming), 0);
  } else if (prompt) {
    const clientChatRequestId = crypto.randomUUID();
    const requestDigest = crypto.createHash("sha256").update(JSON.stringify({
      projectUuid: created.id,
      prompt,
      clientChatRequestId,
    })).digest("hex");
    await withOpenPersonalCanvasProject(created.id, "write", () => runHomePlan(created.id, {
      prompt,
      ...(typeof req.body?.modelId === "string" && req.body.modelId.trim()
        ? { modelId: req.body.modelId.trim() }
        : {}),
      attachmentAssetUuids: [],
      baseRevision: 0,
      clientChatRequestId,
      requestDigest,
    }), session);
  }
  res.status(200).send({
    status: "complete",
    project: created,
    flow: { id: created.id, name: String(req.body?.flow?.name ?? "画布") },
  });
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
    res.status(200).send([{
      id: projectId,
      name: "画布",
      ownerType: "project",
      ownerId: projectId,
      data: {
        nodes: envelope.document.graph.nodes,
        edges: envelope.document.graph.edges,
        viewport: envelope.document.viewport,
      },
      revision: envelope.revision,
    }]);
  } catch {
    res.status(200).send([]);
  }
});

router.get("/flows/:id", async (req, res) => {
  const projectId = String(req.params.id ?? "");
  try {
    const envelope = await withOpenPersonalCanvasProject(projectId, "read", async () => readCanvasDocument(projectId), sessionOf(req));
    res.status(200).send({
      id: projectId,
      name: "画布",
      ownerType: "project",
      ownerId: projectId,
      data: {
        nodes: envelope.document.graph.nodes,
        edges: envelope.document.graph.edges,
        viewport: envelope.document.viewport,
      },
      revision: envelope.revision,
    });
  } catch (error) {
    res.status(404).send({ error: error instanceof Error ? error.message : "flow not found" });
  }
});

router.post("/flows", async (req, res) => {
  const projectId = String(req.body?.projectId ?? req.body?.ownerId ?? req.body?.id ?? "");
  try {
    const saved = await persistFlow(
      projectId,
      sessionOf(req),
      req.body?.data ?? {},
      req.body?.expectedRevision,
    );
    res.status(200).send({
      id: projectId,
      revision: saved.revision,
      name: String(req.body?.name ?? "画布"),
    });
  } catch (error) {
    res.status(409).send({ error: error instanceof Error ? error.message : "save flow failed" });
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
  const items = await catalogModels();
  const providerCount = new Set(items.map(catalogProvider).filter(Boolean)).size;
  res.status(200).send({
    ready: items.length > 0,
    enabledModelCount: items.length,
    configuredChannelCount: providerCount,
    executableModelCount: items.length,
    reasons: items.length > 0 ? [] : ["当前账号尚未启用可执行模型"],
    setupUrl: "/settings/model-service",
    recommendedProvider: null,
  });
});

router.get("/new-api-models", async (_req, res) => {
  res.status(200).send(await catalogModels());
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
      const output = await u.Ai.Text(modelKey as never).invoke({
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
    const modelKey = String(req.body?.modelKey ?? "universalAi").trim() || "universalAi";
    const output = await u.Ai.Text(modelKey as never).invoke({ prompt });
    const text = String(output.text ?? "");
    if (req.body?.stream || String(req.headers.accept ?? "").includes("text/event-stream")) {
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.write(`event: content\ndata: ${JSON.stringify({ delta: text })}\n\n`);
      res.write(`event: done\ndata: ${JSON.stringify({ reason: "logical_succeeded" })}\n\n`);
      res.end();
      return;
    }
    res.status(200).send({
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
    });
  } catch (error) {
    writeTapCanvasError(res, error);
  }
});

router.post("/agents/llm/v1/chat/completions", async (req, res) => {
  try {
    const modelKey = String(req.body?.model ?? "universalAi").trim() || "universalAi";
    const messages = Array.isArray(req.body?.messages) ? req.body.messages as Array<Record<string, unknown>> : [];
    const system = messages.filter((item) => item.role === "system").map((item) => String(item.content ?? "")).join("\n");
    const prompt = messages.filter((item) => item.role !== "system").map((item) => String(item.content ?? "")).join("\n");
    const output = await u.Ai.Text(modelKey as never).invoke({
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

router.post("/memory/project-sessions", (_req, res) => {
  res.status(200).send({ items: [] });
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
