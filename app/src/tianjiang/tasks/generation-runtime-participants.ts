/**
 * 关闭/切换账号时的生成运行时参与者。
 * 先暂停新领取，再等待 claiming/submitting 进入耐久状态，不等待远端长任务结束。
 */
const participants = new Set<{
  pauseNewWorkAndDrainCriticalSection(): Promise<void>;
  resume(): Promise<void> | void;
  stop(): Promise<void> | void;
}>();

export function registerGenerationRuntimeParticipant(participant: {
  pauseNewWorkAndDrainCriticalSection(): Promise<void>;
  resume(): Promise<void> | void;
  stop(): Promise<void> | void;
}): () => void {
  participants.add(participant);
  return () => participants.delete(participant);
}

export async function pauseGenerationRuntime(): Promise<void> {
  for (const participant of participants) {
    await participant.pauseNewWorkAndDrainCriticalSection();
  }
}

export async function resumeGenerationRuntime(): Promise<void> {
  for (const participant of participants) {
    await participant.resume();
  }
}

/**
 * 在需要排空关键提交区的短操作期间暂停运行时，并确保成功、失败都恢复。
 * 该作用域不能包裹远端长任务，只用于关闭/切换等本地生命周期操作。
 */
export async function withGenerationRuntimePaused<T>(run: () => Promise<T>): Promise<T> {
  await pauseGenerationRuntime();
  try {
    return await run();
  } finally {
    await resumeGenerationRuntime();
  }
}

export async function stopGenerationRuntime(): Promise<void> {
  for (const participant of participants) {
    await participant.stop();
  }
}
