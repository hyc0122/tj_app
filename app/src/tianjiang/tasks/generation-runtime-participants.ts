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
}): void {
  participants.add(participant);
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

export async function stopGenerationRuntime(): Promise<void> {
  for (const participant of participants) {
    await participant.stop();
  }
}
