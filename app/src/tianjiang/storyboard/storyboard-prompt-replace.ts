/**
 * 分镜提示词纯文本查找替换。只用 indexOf 游标，禁止 split/join/replaceAll。
 */
export function countLiteralOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) break;
    count += 1;
    from = index + needle.length;
  }
  return count;
}

export function applyLiteralReplacement(haystack: string, findText: string, replaceText: string): string {
  if (!findText) return haystack;
  let result = "";
  let from = 0;
  while (from <= haystack.length) {
    const index = haystack.indexOf(findText, from);
    if (index === -1) {
      result += haystack.slice(from);
      break;
    }
    result += haystack.slice(from, index);
    result += replaceText;
    from = index + findText.length;
  }
  return result;
}

export function planLiteralReplacement(
  haystack: string,
  findText: string,
  replaceText: string,
): { count: number; projectedLength: number } {
  const count = countLiteralOccurrences(haystack, findText);
  const projectedLength = safeProjectedLength(haystack.length, count, findText.length, replaceText.length);
  return { count, projectedLength };
}

export function safeProjectedLength(
  currentLength: number,
  count: number,
  findLength: number,
  replaceLength: number,
): number {
  if (![currentLength, count, findLength, replaceLength].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw Object.assign(new Error("替换后分镜提示词超过长度上限"), {
      status: 400,
      code: "STORYBOARD_PROMPT_TOO_LONG",
    });
  }
  if (count === 0) return currentLength;
  if (findLength > 0 && count > Math.floor(Number.MAX_SAFE_INTEGER / findLength)) {
    throw Object.assign(new Error("替换后分镜提示词超过长度上限"), {
      status: 400,
      code: "STORYBOARD_PROMPT_TOO_LONG",
    });
  }
  if (replaceLength > 0 && count > Math.floor(Number.MAX_SAFE_INTEGER / replaceLength)) {
    throw Object.assign(new Error("替换后分镜提示词超过长度上限"), {
      status: 400,
      code: "STORYBOARD_PROMPT_TOO_LONG",
    });
  }
  const projectedLength = currentLength - count * findLength + count * replaceLength;
  if (!Number.isSafeInteger(projectedLength) || projectedLength < 0) {
    throw Object.assign(new Error("替换后分镜提示词超过长度上限"), {
      status: 400,
      code: "STORYBOARD_PROMPT_TOO_LONG",
    });
  }
  return projectedLength;
}
