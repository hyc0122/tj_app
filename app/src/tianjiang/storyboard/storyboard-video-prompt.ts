import { db as activeDb } from "@/utils/db";
import { runWithProjectStorage } from "../runtime/user-storage-context";
import type { ProjectMediaReference, ShotGenerationOverride, StoryboardWorkspaceSettings } from "./storyboard-generation-service";

export const STORYBOARD_DEFAULT_VIDEO_TEMPLATE = [
  "全局前置提示词：",
  "风格：{{style}}。",
  "镜头语言：{{camera}}。",
  "时代背景：{{era}}。",
  "角色：{{roles}}。",
  "场景：{{scene}}。",
  "道具：{{props}}。",
  "",
  "{{shot_prompt}}",
].join("\n");

export const STORYBOARD_VIDEO_SYSTEM_TEMPLATE_TYPE = "storyboardVideoSystemTemplate";
export const STORYBOARD_VIDEO_USER_TEMPLATE_TYPE = "storyboardVideoUserTemplate";
export const STORYBOARD_VIDEO_MIN_DURATION_MS = 4_000;
export const STORYBOARD_VIDEO_MAX_DURATION_MS = 30_000;

const VARIABLE_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const ASSET_TYPE_LABEL: Record<string, string> = {
  role: "角色",
  scene: "场景",
  tool: "道具",
};

export function parseStoryboardVideoDurationMs(raw: unknown): number {
  // 中文注释：只接受整数毫秒，禁止字符串污染、小数和静默裁剪。
  if (typeof raw !== "number" || !Number.isInteger(raw)
    || raw < STORYBOARD_VIDEO_MIN_DURATION_MS
    || raw > STORYBOARD_VIDEO_MAX_DURATION_MS
    || raw % 1_000 !== 0) {
    throw Object.assign(new Error("视频时长必须是 4 到 30 的整数秒"), {
      status: 400,
      code: "STORYBOARD_VIDEO_DURATION_INVALID",
    });
  }
  return raw;
}

export function assertStoryboardVideoDurationAgainstModel(
  durationMs: number,
  maxDurationMs?: number,
): void {
  if (typeof maxDurationMs !== "number" || !Number.isFinite(maxDurationMs)) return;
  if (durationMs > maxDurationMs) {
    throw Object.assign(new Error("当前模型不支持该视频时长"), {
      status: 400,
      code: "STORYBOARD_DURATION_EXCEEDS_MODEL",
    });
  }
}

function templateContainsShotPrompt(template: string): boolean {
  const matcher = new RegExp(VARIABLE_RE.source, "g");
  for (const match of String(template ?? "").matchAll(matcher)) {
    if (match[1] === "shot_prompt") return true;
  }
  return false;
}

export function renderStoryboardVideoTemplate(
  template: string,
  values: Record<string, string>,
): string {
  const source = String(template ?? "");
  // 中文注释：必须在替换前判断模板是否声明合法 shot_prompt 变量，避免按渲染后文本猜测。
  const containsShotPrompt = templateContainsShotPrompt(source);
  const rendered = source.replace(VARIABLE_RE, (_match, key: string) => {
    // 中文注释：缺失变量渲染为空，禁止把 {{name}} 原样发给模型。
    return values[key] ?? "";
  });
  const shotPrompt = String(values.shot_prompt ?? "").trim();
  if (containsShotPrompt) return rendered;
  // 中文注释：对齐 jimeng_prompting.py：模板未声明 shot_prompt 且分镜提示词非空时，只在末尾追加一次。
  if (!shotPrompt) return rendered;
  return rendered ? `${rendered}\n\n${shotPrompt}` : shotPrompt;
}

export function formatBoundAssetPrompt(items: readonly { name?: string | null; describe?: string | null }[]): string {
  return items.map((item) => {
    const name = String(item.name ?? "").trim();
    const describe = String(item.describe ?? "").trim();
    if (name && describe) return `${name} ${describe}`;
    return name || describe;
  }).filter(Boolean).join("；");
}

export function buildReferenceManifest(
  references: readonly ProjectMediaReference[],
  assetsByUuid: ReadonlyMap<string, { name?: string | null; type?: string | null }>,
): string {
  const images: string[] = [];
  const videos: string[] = [];
  const audios: string[] = [];
  for (const reference of references) {
    const asset = assetsByUuid.get(String(reference.assetUuid ?? ""));
    const name = String(asset?.name ?? "").trim() || "未命名资产";
    const type = String(asset?.type ?? "");
    const typeLabel = ASSET_TYPE_LABEL[type] || "资产";
    if (reference.mediaType === "image") images.push(`${typeLabel}“${name}”`);
    else if (reference.mediaType === "video") videos.push(`${typeLabel}“${name}”`);
    else if (reference.mediaType === "audio") audios.push(`角色“${name}”的音色`);
  }
  const lines = [
    ...images.map((label, index) => `图片${index + 1}：${label}`),
    ...videos.map((label, index) => `视频${index + 1}：${label}`),
    ...audios.map((label, index) => `音频${index + 1}：${label}`),
  ];
  return lines.join("\n");
}

function isSafeReferenceLabelName(name: string): boolean {
  if (!name) return false;
  return !/filePath|md5|assetUuid|[A-Za-z]:\\|\\\\|SELECT\s|runtime-users/i.test(name);
}

/** 中文注释：摘要只跟真实 references 和同一资产清单走，禁止扫描完整 prompt。 */
export function buildSafeReferenceSummary(
  references: readonly ProjectMediaReference[],
  assetsByUuid: ReadonlyMap<string, { name?: string | null; type?: string | null }>,
): {
  image: { count: number; labels: string[] };
  video: { count: number; labels: string[] };
  audio: { count: number; labels: string[] };
} {
  const counts = { image: 0, video: 0, audio: 0 };
  const labels = { image: [] as string[], video: [] as string[], audio: [] as string[] };
  for (const reference of references) {
    const media = reference.mediaType;
    if (media !== "image" && media !== "video" && media !== "audio") continue;
    counts[media] += 1;
    const asset = assetsByUuid.get(String(reference.assetUuid ?? ""));
    const name = String(asset?.name ?? "").trim();
    if (!isSafeReferenceLabelName(name)) continue;
    const typeLabel = ASSET_TYPE_LABEL[String(asset?.type ?? "")] || "资产";
    const label = media === "audio" ? `角色“${name}”的音色` : `${typeLabel}“${name}”`;
    if (labels[media].length < counts[media]) labels[media].push(label);
  }
  return {
    image: { count: counts.image, labels: labels.image },
    video: { count: counts.video, labels: labels.video },
    audio: { count: counts.audio, labels: labels.audio },
  };
}

export async function loadStoryboardAssetsByUuid(
  projectUuid: string,
  references: readonly { assetUuid?: string }[],
): Promise<Map<string, { name?: string | null; type?: string | null }>> {
  const uuids = [...new Set(references.map((item) => String(item.assetUuid ?? "").trim()).filter(Boolean))];
  const result = new Map<string, { name?: string | null; type?: string | null }>();
  if (uuids.length === 0) return result;
  try {
    const rows = await runWithProjectStorage(projectUuid, () =>
      activeDb("o_assets").whereIn("assetUuid", uuids).select("assetUuid", "name", "type"));
    for (const row of rows) {
      result.set(String(row.assetUuid), { name: row.name, type: row.type });
    }
  } catch {
    // 中文注释：无法安全读取资产清单时只保留 count，不猜展示名。
  }
  return result;
}

export function composeCanonicalVideoPrompt(input: {
  template: string;
  values: Record<string, string>;
  references: readonly ProjectMediaReference[];
  assetsByUuid: ReadonlyMap<string, { name?: string | null; type?: string | null }>;
  globalVideoPrompt?: string;
}): string {
  const rendered = renderStoryboardVideoTemplate(input.template, input.values).trim();
  const manifest = buildReferenceManifest(input.references, input.assetsByUuid);
  const parts: string[] = [];
  const globalPrompt = String(input.globalVideoPrompt ?? "").trim();
  if (globalPrompt) parts.push(globalPrompt);
  if (manifest) parts.push(`【参考素材对应关系】\n${manifest}`);
  if (rendered) parts.push(rendered);
  return parts.join("\n\n");
}

export async function resolveCanonicalStoryboardVideoPrompt(input: {
  projectUuid: string;
  settings: Partial<StoryboardWorkspaceSettings>;
  shot: ShotGenerationOverride;
  references: readonly ProjectMediaReference[];
}): Promise<string> {
  const template = String(input.settings.videoPromptTemplateContent ?? "").trim()
    || STORYBOARD_DEFAULT_VIDEO_TEMPLATE;
  const bindings = [...(input.shot.bindings ?? [])];
  const assetsByUuid = await loadBoundAssets(input.projectUuid, bindings);
  const byType = (type: string) => bindings
    .filter((binding) => String(binding.assetType ?? assetsByUuid.get(binding.assetUuid)?.type ?? "") === type)
    .map((binding) => assetsByUuid.get(binding.assetUuid))
    .filter((item): item is { name?: string | null; describe?: string | null; type?: string | null } => Boolean(item));
  const style = await resolveProjectStylePrompt(input.projectUuid);
  const shotPrompt = String(input.shot.videoPrompt ?? "").trim()
    || String(input.shot.visualDescription ?? "").trim();
  return composeCanonicalVideoPrompt({
    template,
    values: {
      style,
      camera: String(input.shot.cameraMovement ?? "").trim(),
      era: String(input.shot.era ?? "").trim(),
      roles: formatBoundAssetPrompt(byType("role")),
      scene: formatBoundAssetPrompt(byType("scene")),
      props: formatBoundAssetPrompt(byType("tool")),
      shot_prompt: shotPrompt,
    },
    references: input.references,
    assetsByUuid,
    // 中文注释：只读项目已保存的 globalVideoPrompt，禁止 preview body 临时覆盖。
    globalVideoPrompt: String(input.settings.globalVideoPrompt ?? ""),
  });
}

async function resolveProjectStylePrompt(projectUuid: string): Promise<string> {
  const { resolveStoryboardStylePrompt } = await import("./storyboard-video-style");
  return resolveStoryboardStylePrompt(projectUuid);
}

async function loadBoundAssets(
  projectUuid: string,
  bindings: readonly { assetUuid: string }[],
): Promise<Map<string, { name?: string | null; describe?: string | null; type?: string | null }>> {
  const result = new Map<string, { name?: string | null; describe?: string | null; type?: string | null }>();
  if (bindings.length === 0) return result;
  const rows = await runWithProjectStorage(projectUuid, () =>
    activeDb("o_assets").whereIn("assetUuid", bindings.map((item) => item.assetUuid)).select());
  for (const row of rows) {
    result.set(String(row.assetUuid), {
      name: row.name,
      describe: row.describe,
      type: row.type,
    });
  }
  return result;
}
