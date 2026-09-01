/**
 * Codex 桥接/任务持久化：账号库 SQLite，禁止进程内数组冒充正式存储。
 * 无本机 Bridge 时返回可恢复的 offline/unpaired，不得谎报在线。
 */
import crypto from "node:crypto";

import u from "@/utils";

type CodexPairingSession = { pairingCode: string; expiresAt: string };
type CodexBridgeSummary = {
  protocolVersion: 2;
  bridgeId: string;
  workerInstanceId: string;
  name: string;
  workerVersion: string;
  codexVersion: string;
  workspaces: unknown[];
  status: "online" | "offline";
  lastSeenAt: string;
  activeTaskId: string | null;
};
type CodexTask = Record<string, unknown> & {
  id: string;
  sessionId: string;
  idempotencyKey: string;
  state: string;
  lastMessage: string;
  updatedAt: string;
  terminalAt: string | null;
  protocolVersion: 2;
};
type CodexTaskMessage = {
  id: string;
  taskId: string;
  sessionId: string;
  text: string;
  state: string;
  idempotencyKey: string;
  createdAt: string;
  deliveredAt: string | null;
  detail: string;
};
type CodexPreviewResolution = {
  previewId: string;
  taskId: string;
  url: string;
  expiresAt: string;
  isolatedOrigin: true;
};
type CodexFallbackDecision = { decision: "approve" | "decline" };

const SETTING_KEY = "tapcanvas.codex.v1";
const PAIRING_TTL_MS = 15 * 60 * 1000;
const MAX_TASKS = 200;
const MAX_MESSAGES = 2_000;

type CodexSnapshot = {
  pairings: Array<CodexPairingSession & { createdAt: string }>;
  bridges: CodexBridgeSummary[];
  tasks: CodexTask[];
  messages: CodexTaskMessage[];
  previews: CodexPreviewResolution[];
};

function emptySnapshot(): CodexSnapshot {
  return { pairings: [], bridges: [], tasks: [], messages: [], previews: [] };
}

async function readSnapshot(): Promise<CodexSnapshot> {
  const row = await u.accountDb("o_setting").where({ key: SETTING_KEY }).first() as { value?: string } | undefined;
  if (!row || typeof row.value !== "string" || !row.value.trim()) return emptySnapshot();
  try {
    const parsed = JSON.parse(row.value) as CodexSnapshot;
    return {
      pairings: Array.isArray(parsed.pairings) ? parsed.pairings : [],
      bridges: Array.isArray(parsed.bridges) ? parsed.bridges : [],
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      previews: Array.isArray(parsed.previews) ? parsed.previews : [],
    };
  } catch (error) {
    throw Object.assign(new Error("Codex 持久化快照损坏，拒绝用空状态覆盖"), {
      status: 500,
      code: "codex_snapshot_corrupt",
      cause: error,
    });
  }
}

async function writeSnapshot(snapshot: CodexSnapshot): Promise<void> {
  const trimmed: CodexSnapshot = {
    pairings: snapshot.pairings.slice(-20),
    bridges: snapshot.bridges.slice(-20),
    tasks: snapshot.tasks.slice(-MAX_TASKS),
    messages: snapshot.messages.slice(-MAX_MESSAGES),
    previews: snapshot.previews.slice(-50),
  };
  const serialized = JSON.stringify(trimmed);
  const exists = await u.accountDb("o_setting").where({ key: SETTING_KEY }).first();
  if (exists) {
    await u.accountDb("o_setting").where({ key: SETTING_KEY }).update({ value: serialized });
    return;
  }
  await u.accountDb("o_setting").insert({ key: SETTING_KEY, value: serialized });
}

let mutationTail: Promise<void> = Promise.resolve();

async function mutateSnapshot<T>(mutation: (snapshot: CodexSnapshot) => Promise<T> | T): Promise<T> {
  // 同一进程内串行化 read-modify-write，避免并发创建任务/消息时整份 JSON 相互覆盖。
  const operation = mutationTail.then(async () => {
    const snapshot = await readSnapshot();
    const result = await mutation(snapshot);
    await writeSnapshot(snapshot);
    return result;
  });
  mutationTail = operation.then(() => undefined, () => undefined);
  return operation;
}

function isBridgeOnline(item: CodexBridgeSummary, now = Date.now()): boolean {
  const lastSeen = Date.parse(item.lastSeenAt);
  return item.status === "online"
    && Number.isFinite(lastSeen)
    && now - lastSeen <= 45_000;
}

export function listOnlineBridges(snapshot: CodexSnapshot): CodexBridgeSummary[] {
  // 列表展示和任务调度必须使用同一心跳时效，禁止把快照中的陈旧 online 当成可领取。
  const now = Date.now();
  return snapshot.bridges.filter((item) => isBridgeOnline(item, now));
}

export async function listCodexBridges(): Promise<{ items: CodexBridgeSummary[]; status: "online" | "offline" }> {
  const snapshot = await readSnapshot();
  const now = Date.now();
  const items = snapshot.bridges.map((item) => {
    if (!isBridgeOnline(item, now)) {
      return { ...item, status: "offline" as const };
    }
    return item;
  });
  return {
    items,
    status: items.some((item) => item.status === "online") ? "online" : "offline",
  };
}

export async function createCodexPairing(): Promise<CodexPairingSession> {
  return mutateSnapshot((snapshot) => {
    const session: CodexPairingSession & { createdAt: string } = {
      pairingCode: crypto.randomBytes(5).toString("hex"),
      expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
      createdAt: new Date().toISOString(),
    };
    snapshot.pairings.push(session);
    return { pairingCode: session.pairingCode, expiresAt: session.expiresAt };
  });
}

export async function listCodexTasks(limit = 20): Promise<CodexTask[]> {
  const snapshot = await readSnapshot();
  const size = Math.min(Math.max(1, Number(limit) || 20), 100);
  return snapshot.tasks.slice(-size).reverse();
}

export async function getCodexTask(taskId: string): Promise<CodexTask | undefined> {
  const snapshot = await readSnapshot();
  return snapshot.tasks.find((item) => item.id === taskId);
}

export async function createCodexTask(input: {
  userId: string;
  bridgeId: string;
  workspaceId: string;
  sessionId: string | null;
  parentTaskId: string | null;
  goal: string;
  context: Record<string, unknown>;
  fallbackPolicy: "disabled" | "ask";
  idempotencyKey: string;
}): Promise<{ task: CodexTask; deduplicated: boolean; queuePosition: number | null; unpaired?: boolean }> {
  return mutateSnapshot((snapshot) => {
    const existing = snapshot.tasks.find((item) => item.idempotencyKey === input.idempotencyKey);
    if (existing) {
      return { task: existing, deduplicated: true, queuePosition: null };
    }
    const online = listOnlineBridges(snapshot);
    const now = new Date().toISOString();
    const task = {
      protocolVersion: 2 as const,
      id: crypto.randomUUID(),
      sessionId: input.sessionId || crypto.randomUUID(),
      parentTaskId: input.parentTaskId,
      turnSequence: 1,
      resumeThreadId: null,
      userId: input.userId,
      bridgeId: input.bridgeId,
      workspaceId: input.workspaceId,
      workspaceConfigFingerprint: "",
      goal: input.goal,
      context: {
        ...input.context,
        snapshotId: crypto.randomUUID(),
        selectedNodeKinds: [],
        projectName: "",
        flowName: null,
        nodeCount: 0,
        edgeCount: 0,
        sha256: crypto.createHash("sha256").update(input.goal).digest("hex"),
        createdAt: now,
      },
      fallbackPolicy: input.fallbackPolicy,
      state: online.length > 0 ? "queued" : "failed",
      previewId: crypto.randomUUID(),
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
      updatedAt: now,
      terminalAt: online.length > 0 ? null : now,
      lastMessage: online.length > 0 ? "已排队等待本机 Bridge" : "本机 Codex Bridge 未在线，请先完成配对",
      expectedDelivery: {
        kind: "codex_response" as const,
        workspaceId: input.workspaceId,
        requiredEvidence: ["codex_turn"] as ["codex_turn"],
      },
      deliveryEvidence: {
        source: null,
        codex: null,
        build: null,
        preview: null,
      },
      deliveryVerification: {
        status: "pending" as const,
        checkedAt: null,
        missingCriteria: ["codex_turn"],
        rationale: online.length > 0 ? "等待 Bridge 领取" : "Bridge offline/unpaired",
      },
    } as CodexTask;
    snapshot.tasks.push(task);
    return {
      task,
      deduplicated: false,
      queuePosition: online.length > 0 ? snapshot.tasks.filter((item) => item.state === "queued").length : null,
      unpaired: online.length === 0,
    };
  });
}

export async function listCodexTaskMessages(taskId: string): Promise<CodexTaskMessage[]> {
  const snapshot = await readSnapshot();
  return snapshot.messages.filter((item) => item.taskId === taskId);
}

export async function createCodexTaskMessage(input: {
  taskId: string;
  text: string;
  idempotencyKey: string;
}): Promise<{ message: CodexTaskMessage; deduplicated: boolean } | undefined> {
  return mutateSnapshot((snapshot) => {
    const task = snapshot.tasks.find((item) => item.id === input.taskId);
    if (!task) return undefined;
    const existing = snapshot.messages.find((item) => item.idempotencyKey === input.idempotencyKey);
    if (existing) return { message: existing, deduplicated: true };
    const now = new Date().toISOString();
    const message: CodexTaskMessage = {
      id: crypto.randomUUID(),
      taskId: task.id,
      sessionId: task.sessionId,
      text: input.text,
      state: "queued",
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
      deliveredAt: null,
      detail: "",
    };
    snapshot.messages.push(message);
    task.updatedAt = now;
    task.lastMessage = input.text.slice(0, 240);
    return { message, deduplicated: false };
  });
}

export async function applyCodexFallback(taskId: string, decision: CodexFallbackDecision): Promise<CodexTask | undefined> {
  return mutateSnapshot((snapshot) => {
    const task = snapshot.tasks.find((item) => item.id === taskId);
    if (!task) return undefined;
    const now = new Date().toISOString();
    task.updatedAt = now;
    task.state = decision.decision === "approve" ? "local_fallback_approved" : "failed";
    task.lastMessage = decision.decision === "approve" ? "已批准本地回退" : "已拒绝本地回退";
    if (decision.decision !== "approve") task.terminalAt = now;
    return task;
  });
}

export async function resolveCodexPreview(previewId: string): Promise<CodexPreviewResolution | undefined> {
  const snapshot = await readSnapshot();
  return snapshot.previews.find((item) => item.previewId === previewId);
}
