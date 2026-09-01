/** 持久 fake 模型：只统计 submit/query/accepted/charge，禁止真实供应商。 */

export interface PersistentFakeModelStats {
  submitAttempts: number;
  queryAttempts: number;
  uniqueAcceptedRequests: number;
  charges: number;
}

const stats: PersistentFakeModelStats = {
  submitAttempts: 0,
  queryAttempts: 0,
  uniqueAcceptedRequests: 0,
  charges: 0,
};

const accepted = new Set<string>();

export function resetPersistentFakeModel(): void {
  stats.submitAttempts = 0;
  stats.queryAttempts = 0;
  stats.uniqueAcceptedRequests = 0;
  stats.charges = 0;
  accepted.clear();
}

export function persistentFakeModelStats(): PersistentFakeModelStats {
  return { ...stats };
}

export async function submitPersistentFakeModel(idempotencyKey: string): Promise<{ accepted: boolean }> {
  stats.submitAttempts += 1;
  if (accepted.has(idempotencyKey)) return { accepted: true };
  accepted.add(idempotencyKey);
  stats.uniqueAcceptedRequests += 1;
  stats.charges += 1;
  return { accepted: true };
}

export async function queryPersistentFakeModel(idempotencyKey: string): Promise<{ accepted: boolean }> {
  stats.queryAttempts += 1;
  return { accepted: accepted.has(idempotencyKey) };
}
