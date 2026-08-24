import { db as activeDb } from "@/utils/db";
import getPath from "@/utils/getPath";
import { getArtPrompt } from "@/utils/getArtPrompt";
import { loadVisualManuals } from "@/tianjiang/skills/project-manuals";
import { runWithProjectStorage } from "@/tianjiang/runtime/user-storage-context";

export interface StoryboardVideoStyleOption {
  stylePath: string;
  name: string;
  prompt: string;
}

function safeVisualManualPrompt(stylePath: string): string {
  try {
    return String(getArtPrompt(stylePath, "art_skills", "art_storyboard_video") ?? "").trim();
  } catch {
    return "";
  }
}

async function listStoryboardVideoStylesImpl(projectUuid: string): Promise<StoryboardVideoStyleOption[]> {
  const manuals = await loadVisualManuals(getPath());
  const seen = new Set<string>();
  const result: StoryboardVideoStyleOption[] = [];
  for (const manual of manuals) {
    const stylePath = String(manual.stylePath ?? "").trim();
    if (!stylePath || seen.has(stylePath)) continue;
    seen.add(stylePath);
    const name = String(manual.name ?? stylePath).trim() || stylePath;
    if (name) seen.add(name);
    result.push({
      stylePath,
      name,
      prompt: safeVisualManualPrompt(stylePath),
    });
  }
  const extras = await runWithProjectStorage(projectUuid, async () => {
    if (!await activeDb.schema.hasTable("o_artStyle")) return [];
    return activeDb("o_artStyle").select("name", "prompt");
  });
  for (const row of extras) {
    const name = String(row.name ?? "").trim();
    const prompt = String(row.prompt ?? "").trim();
    if (!name || !prompt || seen.has(name)) continue;
    result.push({ stylePath: name, name, prompt });
    seen.add(name);
  }
  return result;
}

/** 中文注释：测试可替换实现以注入 ENOENT/EACCES，生产默认走视觉手册列表。 */
export const artStylesListHook = {
  list: listStoryboardVideoStylesImpl,
};

export async function listStoryboardVideoStyles(projectUuid: string): Promise<StoryboardVideoStyleOption[]> {
  return artStylesListHook.list(projectUuid);
}

/**
 * 中文注释：{{style}} 只读当前项目 o_project.type（小说类型）并 trim。
 * 没有小说类型时返回空字符串，不读视觉手册、不读 o_artStyle、不填默认值。
 */
export async function resolveStoryboardStylePrompt(projectUuid: string): Promise<string> {
  const project = await runWithProjectStorage(projectUuid, () => activeDb("o_project").first());
  return String(project?.type ?? "").trim();
}
