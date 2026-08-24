import { accountDb } from "@/utils/db";
import {
  STORYBOARD_DEFAULT_VIDEO_TEMPLATE,
  STORYBOARD_VIDEO_SYSTEM_TEMPLATE_TYPE,
  STORYBOARD_VIDEO_USER_TEMPLATE_TYPE,
} from "./storyboard-video-prompt";

export interface StoryboardVideoTemplate {
  id: number;
  name: string;
  type: string;
  content: string;
  system: boolean;
}

const SYSTEM_NAME = "系统默认视频指令";

export async function ensureStoryboardSystemVideoTemplate(): Promise<StoryboardVideoTemplate> {
  await accountDb.transaction(async (trx) => {
    const existing = await trx("o_prompt").where({ type: STORYBOARD_VIDEO_SYSTEM_TEMPLATE_TYPE }).first();
    if (existing) return;
    const maxId = await trx("o_prompt").max("id as maxId").first();
    await trx("o_prompt").insert({
      id: Number(maxId?.maxId ?? 0) + 1,
      name: SYSTEM_NAME,
      type: STORYBOARD_VIDEO_SYSTEM_TEMPLATE_TYPE,
      data: STORYBOARD_DEFAULT_VIDEO_TEMPLATE,
      useData: null,
    });
  });
  const row = await accountDb("o_prompt").where({ type: STORYBOARD_VIDEO_SYSTEM_TEMPLATE_TYPE }).first();
  return toTemplate(row);
}

export async function listStoryboardVideoTemplates(): Promise<StoryboardVideoTemplate[]> {
  const system = await ensureStoryboardSystemVideoTemplate();
  const users = await accountDb("o_prompt")
    .where({ type: STORYBOARD_VIDEO_USER_TEMPLATE_TYPE })
    .orderBy("id");
  return [system, ...users.map(toTemplate)];
}

export async function createStoryboardVideoTemplate(input: {
  name: string;
  content: string;
}): Promise<StoryboardVideoTemplate> {
  const name = String(input.name ?? "").trim();
  const content = String(input.content ?? "");
  if (!name) throw Object.assign(new Error("视频指令模板名称不能为空"), { status: 400 });
  const maxId = await accountDb("o_prompt").max("id as maxId").first();
  const id = Number(maxId?.maxId ?? 0) + 1;
  await accountDb("o_prompt").insert({
    id,
    name,
    type: STORYBOARD_VIDEO_USER_TEMPLATE_TYPE,
    data: content,
    useData: null,
  });
  return toTemplate({ id, name, type: STORYBOARD_VIDEO_USER_TEMPLATE_TYPE, data: content, useData: null });
}

export async function updateStoryboardVideoTemplate(
  id: number,
  input: { name?: string; content?: string },
): Promise<StoryboardVideoTemplate> {
  const row = await accountDb("o_prompt").where({ id }).first();
  if (!row) throw Object.assign(new Error("视频指令模板不存在"), { status: 404 });
  if (row.type === STORYBOARD_VIDEO_SYSTEM_TEMPLATE_TYPE) {
    throw Object.assign(new Error("系统默认视频指令模板不能修改"), { status: 400 });
  }
  if (row.type !== STORYBOARD_VIDEO_USER_TEMPLATE_TYPE) {
    throw Object.assign(new Error("不是分镜视频指令模板"), { status: 400 });
  }
  const name = input.name == null ? String(row.name ?? "") : String(input.name).trim();
  const content = input.content == null ? readContent(row) : String(input.content);
  if (!name) throw Object.assign(new Error("视频指令模板名称不能为空"), { status: 400 });
  await accountDb("o_prompt").where({ id }).update({ name, data: content, useData: null });
  return toTemplate({ ...row, name, data: content, useData: null });
}

export async function getStoryboardVideoTemplate(id: number): Promise<StoryboardVideoTemplate> {
  await ensureStoryboardSystemVideoTemplate();
  const row = await accountDb("o_prompt").where({ id }).first();
  if (!row || (row.type !== STORYBOARD_VIDEO_SYSTEM_TEMPLATE_TYPE && row.type !== STORYBOARD_VIDEO_USER_TEMPLATE_TYPE)) {
    throw Object.assign(new Error("视频指令模板不存在"), { status: 404 });
  }
  return toTemplate(row);
}

function readContent(row: { data?: unknown; useData?: unknown }): string {
  return String(row.useData || row.data || "");
}

function toTemplate(row: { id?: unknown; name?: unknown; type?: unknown; data?: unknown; useData?: unknown }): StoryboardVideoTemplate {
  return {
    id: Number(row.id),
    name: String(row.name ?? ""),
    type: String(row.type ?? ""),
    content: readContent(row),
    system: String(row.type) === STORYBOARD_VIDEO_SYSTEM_TEMPLATE_TYPE,
  };
}
