/**
 * 项目级对话记忆：写入当前项目 SQLite，随项目库云同步，禁止只放在内存。
 */
import crypto from "node:crypto";

import { db } from "@/utils/db";

export interface MemoryTurn {
  sessionKey: string;
  sessionId: string;
  messageId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  nodeIds: string[];
  modelKey: string;
}

async function ensureTable(): Promise<void> {
  if (await db.schema.hasTable("tapcanvas_memory_turns")) return;
  await db.schema.createTable("tapcanvas_memory_turns", (table) => {
    table.string("message_id").primary();
    table.string("session_id").notNullable();
    table.string("session_key").notNullable();
    table.string("role").notNullable();
    table.text("content").notNullable();
    table.string("created_at").notNullable();
    table.text("node_ids").notNullable();
    table.string("model_key").notNullable();
    table.index(["session_key", "created_at"]);
  });
}

export async function appendMemoryTurns(turns: MemoryTurn[]): Promise<void> {
  if (turns.length === 0) return;
  await ensureTable();
  // 用户消息和助手消息必须原子落库；禁止崩溃后只留下半个回合。
  await db.transaction(async (trx) => {
    for (const turn of turns) {
      await trx("tapcanvas_memory_turns").insert({
        message_id: turn.messageId,
        session_id: turn.sessionId,
        session_key: turn.sessionKey,
        role: turn.role,
        content: turn.content,
        created_at: turn.createdAt,
        node_ids: JSON.stringify(turn.nodeIds),
        model_key: turn.modelKey,
      }).onConflict("message_id").ignore();
    }
  });
}

export function newMemoryIds(): { sessionId: string; userMessageId: string; assistantMessageId: string } {
  return {
    sessionId: crypto.randomUUID(),
    userMessageId: crypto.randomUUID(),
    assistantMessageId: crypto.randomUUID(),
  };
}

export async function loadRecentConversation(input: {
  sessionKey?: string;
  limit?: number;
}): Promise<Array<{
  messageId: string;
  role: string;
  content: string;
  createdAt: string;
  assets: unknown[];
}>> {
  await ensureTable();
  const limit = Math.min(Math.max(1, Number(input.limit) || 20), 100);
  const query = db("tapcanvas_memory_turns").orderBy("created_at", "desc").limit(limit);
  if (input.sessionKey) query.where("session_key", input.sessionKey);
  const rows = await query;
  return rows.reverse().map((row) => ({
    messageId: String(row.message_id),
    role: String(row.role),
    content: String(row.content),
    createdAt: String(row.created_at),
    assets: [],
  }));
}

export async function listMemorySessions(limit = 20): Promise<Array<{
  sessionId: string;
  sessionKey: string;
  updatedAt: string;
  firstUserMessage: string | null;
}>> {
  await ensureTable();
  const rows = await db("tapcanvas_memory_turns").orderBy("created_at", "desc");
  const seen = new Set<string>();
  const items: Array<{
    sessionId: string;
    sessionKey: string;
    updatedAt: string;
    firstUserMessage: string | null;
  }> = [];
  for (const row of rows) {
    const key = String(row.session_key);
    if (seen.has(key)) continue;
    seen.add(key);
    const firstUser = rows.filter((item) => String(item.session_key) === key && item.role === "user").at(-1);
    items.push({
      sessionId: String(row.session_id),
      sessionKey: key,
      updatedAt: String(row.created_at),
      firstUserMessage: firstUser ? String(firstUser.content) : null,
    });
    if (items.length >= limit) break;
  }
  return items;
}

export async function listMemoryArtifacts(limitSessions = 10, limitTurns = 20): Promise<Array<{
  sessionId: string;
  sessionKey: string;
  updatedAt: string;
  lane: string;
  skillId: string;
  turns: Array<{
    assistantMessageId: string;
    createdAt: string;
    userText: string | null;
    assistantText: string;
    assets: unknown[];
  }>;
}>> {
  const sessions = await listMemorySessions(limitSessions);
  const result = [];
  for (const session of sessions) {
    const conversation = await loadRecentConversation({ sessionKey: session.sessionKey, limit: limitTurns * 2 });
    const turns = [];
    for (let index = 0; index < conversation.length; index += 1) {
      const item = conversation[index]!;
      if (item.role !== "assistant") continue;
      const user = [...conversation.slice(0, index)].reverse().find((entry) => entry.role === "user");
      turns.push({
        assistantMessageId: item.messageId,
        createdAt: item.createdAt,
        userText: user?.content ?? null,
        assistantText: item.content,
        assets: [],
      });
    }
    result.push({
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      updatedAt: session.updatedAt,
      lane: "chat",
      skillId: "tianjiang-chat",
      turns: turns.slice(-limitTurns),
    });
  }
  return result;
}

export function emptyMemoryContext(recent: Array<{
  messageId: string;
  role: string;
  content: string;
  createdAt: string;
  assets: unknown[];
}>) {
  return {
    context: {
      userPreferences: [],
      projectFacts: [],
      bookFacts: [],
      chapterFacts: [],
      artifactRefs: [],
      rollups: {
        user: [],
        project: [],
        book: [],
        chapter: [],
        session: [],
      },
      recentConversation: recent,
    },
    summaryText: recent.map((item) => `${item.role}: ${item.content}`).join("\n").slice(0, 4_000),
    promptText: recent.map((item) => item.content).join("\n").slice(0, 4_000),
  };
}
