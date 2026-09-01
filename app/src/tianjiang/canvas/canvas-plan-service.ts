import crypto from "node:crypto";

import u from "@/utils";
import { db } from "@/utils/db";
import { CANVAS_LIMITS, CANVAS_NODE_KIND_VALUES, type CanvasNodeKind } from "../contracts";
import { CanvasRuntimeError, readCanvasDocument, saveCanvasDocument } from "./canvas-document-service";
import type { CanvasDocument } from "./canvas-contracts";

export interface CanvasMutationPlan {
  schemaVersion: 1;
  planUuid: string;
  projectUuid: string;
  baseRevision: number;
  source: "home" | "chat";
  digest: string;
  expiresAt: number;
  title?: string;
  summary: string;
  operations: Array<{ type: "addNode" | "addEdge"; node?: Record<string, unknown>; edge?: Record<string, unknown> }>;
  executionCandidates: Array<{ nodeUuid: string; kind: string; modelId?: string }>;
}

export interface CanvasPlannerInput {
  projectUuid: string;
  baseRevision: number;
  source: "home" | "chat";
  prompt: string;
  modelId?: string;
  skillId?: string;
  attachmentAssetUuids: string[];
  referencedNodeUuids: string[];
}

interface PlannerNode {
  clientKey: string;
  kind: CanvasNodeKind;
  title: string;
  text?: string;
  prompt?: string;
  modelId?: string;
  parameters?: Record<string, unknown>;
}

interface PlannerEdge {
  sourceClientKey: string;
  targetClientKey: string;
  label?: string;
}

export interface CanvasPlannerOutput {
  title?: string;
  summary: string;
  nodes: PlannerNode[];
  edges: PlannerEdge[];
}

export type CanvasPlannerAdapter = (input: CanvasPlannerInput) => Promise<CanvasPlannerOutput>;
let testPlannerAdapter: CanvasPlannerAdapter | undefined;

/** 仅测试可注入 fake planner；生产路径始终调用账号已配置的文本模型。 */
export function setCanvasPlannerAdapterForTests(adapter: CanvasPlannerAdapter | undefined): void {
  testPlannerAdapter = adapter;
}

function invalidOutput(message: string): never {
  throw new CanvasRuntimeError("CANVAS_PLANNER_INVALID_OUTPUT", message, 502, true);
}

function extractJson(text: string): unknown {
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) return invalidOutput("AI 规划结果不是有效 JSON");
  try {
    return JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    return invalidOutput("AI 规划结果不是有效 JSON");
  }
}

function normalizePlannerOutput(value: unknown): CanvasPlannerOutput {
  if (!value || typeof value !== "object") return invalidOutput("AI 规划结果结构不合法");
  const raw = value as Record<string, unknown>;
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  const rawEdges = Array.isArray(raw.edges) ? raw.edges : [];
  if (rawNodes.length === 0 || rawNodes.length > Math.min(100, CANVAS_LIMITS.MAX_CANVAS_MUTATION_OPERATIONS)) {
    return invalidOutput("AI 规划节点数量不合法");
  }
  const keys = new Set<string>();
  const nodes = rawNodes.map((item): PlannerNode => {
    if (!item || typeof item !== "object") return invalidOutput("AI 规划节点不合法");
    const node = item as Record<string, unknown>;
    const clientKey = String(node.clientKey ?? "").trim();
    const kind = String(node.kind ?? "") as CanvasNodeKind;
    const title = String(node.title ?? "").trim().slice(0, 200);
    if (!clientKey || keys.has(clientKey) || !CANVAS_NODE_KIND_VALUES.includes(kind) || !title) {
      return invalidOutput("AI 规划节点不合法");
    }
    keys.add(clientKey);
    return {
      clientKey,
      kind,
      title,
      ...(typeof node.text === "string" ? { text: node.text.slice(0, CANVAS_LIMITS.MAX_CANVAS_NODE_TEXT_CHARS) } : {}),
      ...(typeof node.prompt === "string" ? { prompt: node.prompt.slice(0, CANVAS_LIMITS.MAX_CANVAS_NODE_TEXT_CHARS) } : {}),
      ...(typeof node.modelId === "string" ? { modelId: node.modelId.slice(0, 300) } : {}),
      ...(node.parameters && typeof node.parameters === "object" && !Array.isArray(node.parameters)
        ? { parameters: node.parameters as Record<string, unknown> }
        : {}),
    };
  });
  const edges = rawEdges.map((item): PlannerEdge => {
    if (!item || typeof item !== "object") return invalidOutput("AI 规划连线不合法");
    const edge = item as Record<string, unknown>;
    const sourceClientKey = String(edge.sourceClientKey ?? "").trim();
    const targetClientKey = String(edge.targetClientKey ?? "").trim();
    if (!keys.has(sourceClientKey) || !keys.has(targetClientKey) || sourceClientKey === targetClientKey) {
      return invalidOutput("AI 规划连线不合法");
    }
    return {
      sourceClientKey,
      targetClientKey,
      ...(typeof edge.label === "string" ? { label: edge.label.slice(0, 200) } : {}),
    };
  });
  return {
    ...(typeof raw.title === "string" ? { title: raw.title.slice(0, 200) } : {}),
    summary: String(raw.summary ?? "已生成画布规划").slice(0, 4_000),
    nodes,
    edges,
  };
}

async function invokeProductionPlanner(input: CanvasPlannerInput): Promise<CanvasPlannerOutput> {
  const result = await u.Ai.Text((input.modelId || "universalAi") as never).invoke({
    system: [
      "你是天将漫创无限画布规划器。只输出一个 JSON 对象，禁止 Markdown。",
      "结构：{title,summary,nodes:[{clientKey,kind,title,text?,prompt?,modelId?,parameters?}],edges:[{sourceClientKey,targetClientKey,label?}]}。",
      `kind 只能是：${CANVAS_NODE_KIND_VALUES.join(",")}。`,
      "图片/视频生成只创建 image_generation/video_generation 节点，不得自行执行收费任务。",
      "节点 clientKey 必须唯一，连线只能引用本次 nodes 中的 clientKey。",
    ].join("\n"),
    prompt: JSON.stringify({
      userPrompt: input.prompt,
      source: input.source,
      skillId: input.skillId ?? null,
      attachmentAssetUuids: input.attachmentAssetUuids,
      referencedNodeUuids: input.referencedNodeUuids,
    }),
  });
  return normalizePlannerOutput(extractJson(String(result.text ?? "")));
}

function buildPlan(input: CanvasPlannerInput, generated: CanvasPlannerOutput): CanvasMutationPlan {
  const planUuid = crypto.randomUUID();
  const nodeIds = new Map<string, string>();
  const operations: CanvasMutationPlan["operations"] = generated.nodes.map((node, index) => {
    const nodeUuid = crypto.randomUUID();
    nodeIds.set(node.clientKey, nodeUuid);
    return {
      type: "addNode" as const,
      node: {
        nodeUuid,
        kind: node.kind,
        position: { x: 80 + (index % 3) * 360, y: 80 + Math.floor(index / 3) * 260 },
        zIndex: index + 1,
        collapsed: false,
        data: {
          title: node.title,
          ...(node.text ? { text: node.text } : {}),
          ...(node.prompt ? { prompt: node.prompt } : {}),
          ...(node.modelId ? { modelId: node.modelId } : {}),
          ...(node.parameters ? { parameters: node.parameters } : {}),
        },
      },
    };
  });
  for (const edge of generated.edges) {
    operations.push({
      type: "addEdge",
      edge: {
        edgeUuid: crypto.randomUUID(),
        kind: "default",
        sourceNodeUuid: nodeIds.get(edge.sourceClientKey),
        targetNodeUuid: nodeIds.get(edge.targetClientKey),
        ...(edge.label ? { label: edge.label } : {}),
      },
    });
  }
  const digest = crypto.createHash("sha256").update(JSON.stringify({ source: input.source, operations })).digest("hex");
  return {
    schemaVersion: 1,
    planUuid,
    projectUuid: input.projectUuid,
    baseRevision: input.baseRevision,
    source: input.source,
    digest,
    expiresAt: Date.now() + 30 * 60_000,
    title: generated.title,
    summary: generated.summary,
    operations,
    executionCandidates: operations.flatMap((operation) => {
      const node = operation.node;
      const kind = String(node?.kind ?? "");
      if (kind !== "image_generation" && kind !== "video_generation") return [];
      const data = node?.data as Record<string, unknown> | undefined;
      return [{ nodeUuid: String(node?.nodeUuid), kind, ...(typeof data?.modelId === "string" ? { modelId: data.modelId } : {}) }];
    }),
  };
}

export async function createCanvasPlan(input: CanvasPlannerInput): Promise<CanvasMutationPlan> {
  const generated = normalizePlannerOutput(await (testPlannerAdapter ?? invokeProductionPlanner)(input));
  const plan = buildPlan(input, generated);
  await db("canvas_plans").insert({
    plan_uuid: plan.planUuid,
    project_uuid: plan.projectUuid,
    base_revision: plan.baseRevision,
    source: plan.source,
    digest: plan.digest,
    plan_json: JSON.stringify(plan),
    expires_at: new Date(plan.expiresAt).toISOString(),
    created_at: new Date().toISOString(),
  });
  return plan;
}

export async function readCanvasPlan(planUuid: string): Promise<CanvasMutationPlan | undefined> {
  const row = await db("canvas_plans").where({ plan_uuid: planUuid }).first();
  return row ? JSON.parse(String(row.plan_json)) as CanvasMutationPlan : undefined;
}

export async function applyCanvasPlan(
  projectUuid: string,
  planUuid: string,
  input: { baseRevision: number; clientMutationId: string },
): Promise<unknown> {
  const replay = await db("canvas_applied_plans").where({ plan_uuid: planUuid }).first();
  if (replay) return JSON.parse(String(replay.result_json));
  const plan = await readCanvasPlan(planUuid);
  if (!plan || plan.projectUuid !== projectUuid) {
    throw new CanvasRuntimeError("CANVAS_PLAN_STALE", "计划不存在或已过期", 409, false);
  }
  if (plan.expiresAt < Date.now()) {
    throw new CanvasRuntimeError("CANVAS_PLAN_EXPIRED", "计划已过期", 409, false);
  }
  const current = await readCanvasDocument(projectUuid);
  if (current.revision !== input.baseRevision || current.revision !== plan.baseRevision) {
    throw new CanvasRuntimeError("CANVAS_PLAN_STALE", "计划基于的画布版本已变化", 409, true);
  }
  const document: CanvasDocument = JSON.parse(JSON.stringify(current.document)) as CanvasDocument;
  for (const operation of plan.operations) {
    if (operation.type === "addNode" && operation.node) document.graph.nodes.push(operation.node);
    if (operation.type === "addEdge" && operation.edge) document.graph.edges.push(operation.edge);
  }
  return saveCanvasDocument(projectUuid, {
    baseRevision: input.baseRevision,
    clientMutationId: input.clientMutationId,
    document,
  }, {
    homeInitializationState: plan.source === "home" ? "consumed" : undefined,
    afterSaveInTransaction: async (trx, saved) => {
      await trx("canvas_applied_plans").insert({
        plan_uuid: planUuid,
        base_revision: input.baseRevision,
        applied_revision: saved.revision,
        result_json: JSON.stringify(saved),
        applied_at: new Date().toISOString(),
      });
    },
  });
}
