/**
 * 分镜提示词资产匹配器。只根据持久化 videoPrompt 做纯函数计算，不读写数据库、不访问供应商。
 */
export type MatchableAssetType = "role" | "scene" | "tool";

export interface MatchableAsset {
  assetUuid: string;
  name: string;
  type: MatchableAssetType;
  remark?: string;
  sourceProjectUuid: string;
}

export interface StoryboardAssetMatch {
  assetUuid: string;
  assetType: MatchableAssetType;
  matchedText: string;
  start: number;
  end: number;
  sourceProjectUuid: string;
}

export interface StoryboardAssetMatchConflict {
  keyword: string;
  assetNames: string[];
}

export interface StoryboardAssetMatchResult {
  matches: StoryboardAssetMatch[];
  conflicts: StoryboardAssetMatchConflict[];
}

interface CandidateSpan {
  asset: MatchableAsset;
  text: string;
  start: number;
  end: number;
  keyword: string;
}

interface StructuredToken {
  text: string;
  matchText: string;
  start: number;
  end: number;
}

const STRUCTURED_FIELD_NAMES: Record<MatchableAssetType, string> = {
  role: "人物",
  scene: "场景",
  tool: "道具",
};

const STRUCTURED_FIELD_MARKER_PATTERN = /(?:^|(?<=[。！？!?；;]))[ \t]*(?:(人物站位|氛围光影|预估时长|推荐时长|总时长|分镜提示词|场景|人物|道具|时间|分镜|镜号\s*\d+)\s*[：:][ \t]*|预估\s*\d+(?:\.\d+)?\s*秒)/gm;
const NAME_SPLIT_PATTERN = /[、;,，；]/g;
const ALIAS_SPLIT_PATTERN = /[,，、\n\r]+/;
const BRACKET_TRANSLATION: Record<string, string> = {
  "[": "(",
  "【": "(",
  "（": "(",
  "［": "(",
  "]": ")",
  "】": ")",
  "）": ")",
  "］": ")",
};
const NAME_QUOTE_CHARS = "\"'“”‘’「」『』《》";
const NAME_EDGE_PUNCTUATION = "。！？!?:：";
const BRACKET_OPEN_CHARS = "([（【［";
const SCENE_CONTEXT_TOKENS = new Set([
  "内", "外", "内景", "外景", "日", "夜", "白天", "黑夜", "夜晚", "晚上",
  "清晨", "早晨", "上午", "中午", "下午", "傍晚", "黄昏", "深夜", "凌晨",
  "雨天", "雪天", "阴天", "晴天",
]);
const ASSET_TYPE_PRIORITY: Record<MatchableAssetType, number> = {
  role: 0,
  scene: 1,
  tool: 2,
};

export function matchAssetsForPrompt(
  prompt: string,
  assets: readonly MatchableAsset[],
): StoryboardAssetMatchResult {
  const usable = assets.filter((asset) => asset.type === "role" || asset.type === "scene" || asset.type === "tool");
  const conflicts: StoryboardAssetMatchConflict[] = [];
  const ambiguous = collectAmbiguousKeywords(usable);
  const selected = selectNonOverlappingSpans(prompt, usable, ambiguous, conflicts);
  const filtered: CandidateSpan[] = [];
  let sceneSelected = false;
  for (const span of selected) {
    if (span.asset.type === "scene") {
      if (sceneSelected) continue;
      sceneSelected = true;
    }
    filtered.push(span);
  }
  filtered.sort((left, right) => (
    compareNumber(ASSET_TYPE_PRIORITY[left.asset.type] ?? 99, ASSET_TYPE_PRIORITY[right.asset.type] ?? 99)
    || compareNumber(right.end - right.start, left.end - left.start)
    || compareNumber(left.start, right.start)
    || left.asset.assetUuid.localeCompare(right.asset.assetUuid)
  ));
  return {
    matches: filtered.map((span) => ({
      assetUuid: span.asset.assetUuid,
      assetType: span.asset.type,
      matchedText: span.text,
      start: span.start,
      end: span.end,
      sourceProjectUuid: span.asset.sourceProjectUuid,
    })),
    conflicts: uniqueConflicts(conflicts),
  };
}

function collectAmbiguousKeywords(
  assets: readonly MatchableAsset[],
): ReadonlyMap<MatchableAssetType, ReadonlyMap<string, MatchableAsset[]>> {
  const grouped = new Map<MatchableAssetType, Map<string, MatchableAsset[]>>();
  for (const type of ["role", "scene", "tool"] as const) grouped.set(type, new Map());
  for (const asset of assets) {
    const byKeyword = grouped.get(asset.type);
    if (!byKeyword) continue;
    for (const keyword of assetKeywords(asset)) {
      const normalized = normalizeNameForMatch(keyword);
      if (!normalized) continue;
      const current = byKeyword.get(normalized) ?? [];
      if (!current.some((item) => item.assetUuid === asset.assetUuid)) current.push(asset);
      byKeyword.set(normalized, current);
    }
  }
  return grouped;
}

function selectNonOverlappingSpans(
  prompt: string,
  assets: readonly MatchableAsset[],
  ambiguous: ReadonlyMap<MatchableAssetType, ReadonlyMap<string, MatchableAsset[]>>,
  conflicts: StoryboardAssetMatchConflict[],
): CandidateSpan[] {
  const candidates = [...iterBindingCandidateSpans(prompt, assets, ambiguous, conflicts)];
  candidates.sort((left, right) => (
    compareNumber(right.end - right.start, left.end - left.start)
    || compareNumber(ASSET_TYPE_PRIORITY[left.asset.type] ?? 99, ASSET_TYPE_PRIORITY[right.asset.type] ?? 99)
    || compareNumber(left.start, right.start)
    || left.asset.assetUuid.localeCompare(right.asset.assetUuid)
  ));
  const selected: CandidateSpan[] = [];
  const selectedAssetIds = new Set<string>();
  const occupiedByType = new Map<MatchableAssetType, Array<[number, number]>>();
  for (const candidate of candidates) {
    const occupied = occupiedByType.get(candidate.asset.type) ?? [];
    if (occupied.some(([start, end]) => overlaps(candidate.start, candidate.end, start, end))) continue;
    occupied.push([candidate.start, candidate.end]);
    occupiedByType.set(candidate.asset.type, occupied);
    // 中文注释：同一资产后续出现仍要占位，避免短名称绑定到更长名称的第二次命中。
    if (selectedAssetIds.has(candidate.asset.assetUuid)) continue;
    selected.push(candidate);
    selectedAssetIds.add(candidate.asset.assetUuid);
  }
  return selected;
}

function* iterBindingCandidateSpans(
  prompt: string,
  assets: readonly MatchableAsset[],
  ambiguous: ReadonlyMap<MatchableAssetType, ReadonlyMap<string, MatchableAsset[]>>,
  conflicts: StoryboardAssetMatchConflict[],
): Iterable<CandidateSpan> {
  for (const asset of assets) {
    if (asset.type !== "role" && asset.type !== "scene") continue;
    for (const keyword of assetKeywords(asset)) {
      if (asset.type === "scene" && isSceneContextToken(keyword)) continue;
      const normalized = normalizeNameForMatch(keyword);
      const owners = ambiguous.get(asset.type)?.get(normalized) ?? [];
      if (owners.length > 1) {
        rememberConflict(prompt, keyword, owners, conflicts);
        continue;
      }
      yield* iterNormalizedKeywordSpans(prompt, asset, keyword);
    }
  }
  yield* iterStructuredCandidateSpans(
    prompt,
    assets.filter((asset) => asset.type === "tool"),
    ambiguous,
    conflicts,
  );
}

function* iterStructuredCandidateSpans(
  prompt: string,
  assets: readonly MatchableAsset[],
  ambiguous: ReadonlyMap<MatchableAssetType, ReadonlyMap<string, MatchableAsset[]>>,
  conflicts: StoryboardAssetMatchConflict[],
): Iterable<CandidateSpan> {
  const assetsByType: Record<MatchableAssetType, MatchableAsset[]> = { role: [], scene: [], tool: [] };
  for (const asset of assets) assetsByType[asset.type].push(asset);
  for (const assetType of ["role", "scene", "tool"] as const) {
    for (const token of structuredTokens(prompt, assetType)) {
      const matches = assetsByType[assetType]
        .filter((asset) => assetMatchesStructuredToken(asset, token, assetType))
        .map((asset) => ({
          asset,
          text: token.matchText,
          start: token.start,
          end: token.end,
          keyword: token.matchText,
        } satisfies CandidateSpan));
      if (matches.length === 0) continue;
      const uniqueAssets = uniqueByUuid(matches.map((item) => item.asset));
      if (uniqueAssets.length > 1) {
        rememberNamedConflict(token.matchText, uniqueAssets, conflicts);
        continue;
      }
      const normalized = normalizeNameForMatch(token.matchText);
      const owners = ambiguous.get(assetType)?.get(normalized) ?? [];
      if (owners.length > 1) {
        rememberNamedConflict(token.matchText, owners, conflicts);
        continue;
      }
      matches.sort((left, right) => (
        compareNumber(right.end - right.start, left.end - left.start)
        || left.asset.assetUuid.localeCompare(right.asset.assetUuid)
      ));
      yield matches[0]!;
      if (assetType === "scene") return;
    }
  }
}

function structuredTokens(prompt: string, assetType: MatchableAssetType): StructuredToken[] {
  const tokens: StructuredToken[] = [];
  for (const [value, valueStart] of structuredFieldValues(prompt, STRUCTURED_FIELD_NAMES[assetType])) {
    let tokenStart = 0;
    for (const separator of matchAll(NAME_SPLIT_PATTERN, value)) {
      tokens.push(...cleanStructuredToken(value, valueStart, tokenStart, separator.index, assetType));
      tokenStart = separator.index + separator[0].length;
    }
    tokens.push(...cleanStructuredToken(value, valueStart, tokenStart, value.length, assetType));
  }
  return tokens;
}

function structuredFieldValues(prompt: string, fieldName: string): Array<[string, number]> {
  const markers = matchAll(STRUCTURED_FIELD_MARKER_PATTERN, prompt);
  const values: Array<[string, number]> = [];
  for (const [index, marker] of markers.entries()) {
    if (marker[1] !== fieldName) continue;
    const valueStart = marker.index + marker[0].length;
    const lineEnd = prompt.indexOf("\n", valueStart);
    const nextMarkerStart = index + 1 < markers.length ? markers[index + 1]!.index : prompt.length;
    const valueEnd = Math.min(lineEnd === -1 ? prompt.length : lineEnd, nextMarkerStart);
    values.push([prompt.slice(valueStart, valueEnd), valueStart]);
  }
  return values;
}

function cleanStructuredToken(
  value: string,
  valueStart: number,
  start: number,
  end: number,
  assetType: MatchableAssetType,
): StructuredToken[] {
  const cleaned = cleanNameTokenSpan(value, valueStart, start, end);
  if (!cleaned) return [];
  const [tokenText, tokenStart, tokenEnd] = cleaned;
  if (assetType !== "scene") {
    return [{ text: tokenText, matchText: tokenText, start: tokenStart, end: tokenEnd }];
  }
  return sceneStructuredTokens(tokenText, tokenStart);
}

function sceneStructuredTokens(tokenText: string, tokenStart: number): StructuredToken[] {
  const tokens: StructuredToken[] = [];
  const seen = new Set<string>();
  const append = (text: string, start: number) => {
    const matchText = stripBracketQualification(text);
    if (!matchText || isSceneContextToken(matchText)) return;
    const end = start + matchText.length;
    const identity = `${start}:${end}:${normalizeNameForMatch(matchText)}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    tokens.push({ text, matchText, start, end });
  };
  append(tokenText, tokenStart);
  for (const part of tokenText.matchAll(/\S+/g)) {
    append(part[0], tokenStart + (part.index ?? 0));
  }
  return tokens;
}

function isSceneContextToken(value: string): boolean {
  const normalizedTokens = new Set([...SCENE_CONTEXT_TOKENS].map((token) => normalizeNameForMatch(token)));
  return normalizedTokens.has(normalizeNameForMatch(value));
}

function stripBracketQualification(value: string): string {
  const firstBracket = [...value].findIndex((ch) => BRACKET_OPEN_CHARS.includes(ch));
  return firstBracket === -1 ? value : value.slice(0, firstBracket).trim();
}

function assetMatchesStructuredToken(
  asset: MatchableAsset,
  token: StructuredToken,
  assetType: MatchableAssetType,
): boolean {
  const acceptedTokens = assetType === "scene" ? [token.matchText, token.text] : [token.text];
  const accepted = new Set(acceptedTokens.map((item) => normalizeNameForMatch(item)).filter(Boolean));
  return assetKeywords(asset).some((keyword) => accepted.has(normalizeNameForMatch(keyword)));
}

function* iterNormalizedKeywordSpans(
  prompt: string,
  asset: MatchableAsset,
  keyword: string,
): Iterable<CandidateSpan> {
  const [normalizedPrompt, offsets] = normalizeTextWithOffsets(prompt);
  const normalizedKeyword = normalizeNameForMatch(keyword);
  if (!normalizedKeyword) return;
  let normalizedStart = normalizedPrompt.indexOf(normalizedKeyword);
  while (normalizedStart !== -1) {
    const normalizedEnd = normalizedStart + normalizedKeyword.length;
    const start = offsets[normalizedStart] ?? 0;
    const last = offsets[normalizedEnd - 1] ?? start;
    const end = last + utf16UnitLength(prompt, last);
    if (asset.type !== "role" || isValidCharacterFallbackSpan(prompt, start, end)) {
      yield {
        asset,
        text: prompt.slice(start, end),
        start,
        end,
        keyword,
      };
    }
    normalizedStart = normalizedPrompt.indexOf(normalizedKeyword, normalizedStart + 1);
  }
}

function isValidCharacterFallbackSpan(prompt: string, start: number, end: number): boolean {
  let nextIndex = end;
  while (nextIndex < prompt.length && /\s/.test(prompt[nextIndex] ?? "")) nextIndex += 1;
  return !(nextIndex < prompt.length && BRACKET_OPEN_CHARS.includes(prompt[nextIndex] ?? ""));
}

function cleanNameTokenSpan(
  value: string,
  valueStart: number,
  start: number,
  end: number,
): [string, number, number] | null {
  const edgeChars = NAME_QUOTE_CHARS + NAME_EDGE_PUNCTUATION;
  while (start < end && (/\s/.test(value[start] ?? "") || edgeChars.includes(value[start] ?? ""))) start += 1;
  while (end > start && (/\s/.test(value[end - 1] ?? "") || edgeChars.includes(value[end - 1] ?? ""))) end -= 1;
  if (start >= end) return null;
  return [value.slice(start, end), valueStart + start, valueStart + end];
}

export function parseAssetAliases(remark: string | undefined): string[] {
  return String(remark ?? "")
    .split(ALIAS_SPLIT_PATTERN)
    .map((item) => item.trim())
    .filter(Boolean);
}

function assetKeywords(asset: MatchableAsset): string[] {
  const keywords: string[] = [];
  const seen = new Set<string>();
  for (const value of [asset.name, ...parseAssetAliases(asset.remark)]) {
    const keyword = value.trim();
    if (!keyword || seen.has(keyword)) continue;
    keywords.push(keyword);
    seen.add(keyword);
  }
  keywords.sort((left, right) => right.length - left.length);
  return keywords;
}

function normalizeNameForMatch(value: string): string {
  return [...value.trim()]
    .map((ch) => (BRACKET_TRANSLATION[ch] ?? ch).toLowerCase())
    .filter((ch) => !/\s/.test(ch))
    .join("");
}

function utf16UnitLength(text: string, index: number): number {
  if (index < 0 || index >= text.length) return 0;
  const code = text.charCodeAt(index);
  if (code >= 0xD800 && code <= 0xDBFF && index + 1 < text.length) {
    const next = text.charCodeAt(index + 1);
    if (next >= 0xDC00 && next <= 0xDFFF) return 2;
  }
  return 1;
}

function normalizeTextWithOffsets(text: string): [string, number[]] {
  const chars: string[] = [];
  const offsets: number[] = [];
  for (let index = 0; index < text.length; ) {
    const unitLength = utf16UnitLength(text, index);
    const ch = text.slice(index, index + unitLength);
    const origin = index;
    index += unitLength;
    if (/\s/.test(ch)) continue;
    const mapped = (BRACKET_TRANSLATION[ch] ?? ch).toLowerCase();
    for (let unit = 0; unit < mapped.length; unit += 1) {
      chars.push(mapped[unit]!);
      offsets.push(origin);
    }
  }
  return [chars.join(""), offsets];
}

function overlaps(firstStart: number, firstEnd: number, secondStart: number, secondEnd: number): boolean {
  return firstStart < secondEnd && secondStart < firstEnd;
}

function rememberConflict(
  prompt: string,
  keyword: string,
  owners: readonly MatchableAsset[],
  conflicts: StoryboardAssetMatchConflict[],
): void {
  const [normalizedPrompt] = normalizeTextWithOffsets(prompt);
  if (!normalizedPrompt.includes(normalizeNameForMatch(keyword))) return;
  rememberNamedConflict(keyword, owners, conflicts);
}

function rememberNamedConflict(
  keyword: string,
  owners: readonly MatchableAsset[],
  conflicts: StoryboardAssetMatchConflict[],
): void {
  const names = uniqueStrings(owners.map((asset) => asset.name.trim()).filter(Boolean));
  if (!names.length) return;
  conflicts.push({ keyword, assetNames: names });
}

function uniqueConflicts(conflicts: readonly StoryboardAssetMatchConflict[]): StoryboardAssetMatchConflict[] {
  const seen = new Set<string>();
  const unique: StoryboardAssetMatchConflict[] = [];
  for (const conflict of conflicts) {
    const key = `${normalizeNameForMatch(conflict.keyword)}:${conflict.assetNames.slice().sort().join("|")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(conflict);
  }
  return unique;
}

function uniqueByUuid(assets: readonly MatchableAsset[]): MatchableAsset[] {
  const seen = new Set<string>();
  const unique: MatchableAsset[] = [];
  for (const asset of assets) {
    if (seen.has(asset.assetUuid)) continue;
    seen.add(asset.assetUuid);
    unique.push(asset);
  }
  return unique;
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

function matchAll(pattern: RegExp, text: string): RegExpExecArray[] {
  const regex = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  return [...text.matchAll(regex)] as RegExpExecArray[];
}

function compareNumber(left: number, right: number): number {
  return left === right ? 0 : left < right ? -1 : 1;
}
