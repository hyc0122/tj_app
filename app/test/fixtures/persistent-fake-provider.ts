/** 持久 fake Provider：只统计 submit/query/accepted/charge，禁止真实供应商。 */

export interface PersistentFakeProviderStats {
  submitAttempts: number;
  queryAttempts: number;
  uniqueAcceptedTasks: number;
  charges: number;
}

const stats: PersistentFakeProviderStats = {
  submitAttempts: 0,
  queryAttempts: 0,
  uniqueAcceptedTasks: 0,
  charges: 0,
};
const accepted = new Set<string>();

export function resetPersistentFakeProvider(): void {
  stats.submitAttempts = 0;
  stats.queryAttempts = 0;
  stats.uniqueAcceptedTasks = 0;
  stats.charges = 0;
  accepted.clear();
}

export function persistentFakeProviderStats(): PersistentFakeProviderStats {
  return { ...stats };
}

export async function submitPersistentFakeProvider(idempotencyKey: string): Promise<{ remoteTaskId: string }> {
  stats.submitAttempts += 1;
  if (!accepted.has(idempotencyKey)) {
    accepted.add(idempotencyKey);
    stats.uniqueAcceptedTasks += 1;
    stats.charges += 1;
  }
  return { remoteTaskId: `fake-${idempotencyKey.slice(0, 8)}` };
}

export async function queryPersistentFakeProvider(idempotencyKey: string): Promise<{ accepted: boolean }> {
  stats.queryAttempts += 1;
  return { accepted: accepted.has(idempotencyKey) };
}
