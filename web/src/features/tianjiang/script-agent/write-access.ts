/**
 * 剧本 Agent 记忆清理请求门禁。
 * 唯一依据：projectStore.canWrite（access.mode === "readwrite"）。
 * 生产页面使用 requestClearScriptAgentMemoryIfAllowed；不再导出未使用的 canClear*。
 */

/**
 * 在确认清理前再拦一层：不可写时不得发起 /agents/clearMemory。
 */
export async function requestClearScriptAgentMemoryIfAllowed(
  canWrite: boolean,
  request: () => Promise<unknown>,
): Promise<"ok" | "blocked"> {
  if (!canWrite) return "blocked";
  await request();
  return "ok";
}
