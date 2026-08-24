type StoryboardGenerationTask = Record<string, unknown>;

export interface StoryboardGenerationResponse {
  tasks: StoryboardGenerationTask[];
  recovered: boolean;
}

function isTaskRecord(value: unknown): value is StoryboardGenerationTask {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 统一校验正式 200 任务数组与恢复中 202 对象，禁止用“任一项匹配”误认混合响应。
 */
export function normalizeStoryboardGenerationResponse(
  payload: unknown,
  expectedClientOperationId: string,
  httpStatus: number,
): StoryboardGenerationResponse {
  if (httpStatus === 200 && Array.isArray(payload)) {
    if (
      payload.length === 0
      || payload.some((task) => (
        !isTaskRecord(task)
        || task.clientOperationId !== expectedClientOperationId
      ))
    ) {
      throw new Error("生成响应操作标识无效");
    }
    return { tasks: payload, recovered: false };
  }

  if (
    httpStatus !== 202
    || !isTaskRecord(payload)
    || payload.clientOperationId !== expectedClientOperationId
  ) {
    throw new Error("生成恢复响应操作标识无效");
  }
  const tasks = payload.tasks;
  if (
    !Array.isArray(tasks)
    || tasks.length === 0
    || tasks.some((task) => (
      !isTaskRecord(task)
      || (
        Object.prototype.hasOwnProperty.call(task, "clientOperationId")
        && task.clientOperationId !== expectedClientOperationId
      )
    ))
  ) {
    throw new Error("生成恢复响应任务无效");
  }
  return { tasks, recovered: true };
}
