import { createHash } from "node:crypto";
import type { Knex } from "knex";

import { DEFAULT_VIDEO_PROMPT_GENERATION_ZH } from "../prompts/video-prompt-generation";

/** 已发布过的两份英文默认视频提示词指纹，禁止用模糊关键词替代。 */
export const LEGACY_DEFAULT_VIDEO_PROMPT_HASHES: ReadonlySet<string> = new Set([
  "df5c7c3cf1b7445c1bef3428a1f582a436be15d746e2baf07be5949472fda7e7",
  "626f4035545159802a7f28cc44e5f162d9183c03afd06138e63ba6c542455d6a",
]);

export function hashVideoPrompt(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export interface VideoPromptLanguageMigrationOptions {
  /** 测试可注入固定指纹，生产默认只认已发布的两份原始默认值。 */
  legacyHashes?: ReadonlySet<string>;
}

/**
 * 仅升级从未定制过的旧内置默认提示词。
 *
 * useData 代表用户在界面中启用的自定义内容；data 只要发生任何修改，
 * SHA-256 就不会命中，因此两类用户内容都不会被产品升级覆盖。
 */
export async function migrateDefaultVideoPromptToChinese(
  database: Knex | Knex.Transaction,
  options: VideoPromptLanguageMigrationOptions = {},
): Promise<void> {
  if (!(await database.schema.hasTable("o_prompt"))) return;

  const legacyHashes = options.legacyHashes ?? LEGACY_DEFAULT_VIDEO_PROMPT_HASHES;
  const rows = await database("o_prompt")
    .select("id", "data", "useData")
    .where("type", "videoPromptGeneration");

  for (const row of rows) {
    const activeCustomPrompt = String(row.useData ?? "").trim();
    if (activeCustomPrompt) continue;

    const storedPrompt = String(row.data ?? "");
    if (!legacyHashes.has(hashVideoPrompt(storedPrompt))) continue;

    await database("o_prompt").where("id", row.id).update({
      data: DEFAULT_VIDEO_PROMPT_GENERATION_ZH,
    });
  }
}
