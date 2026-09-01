const tails = new Map<string, Promise<unknown>>();

/** 项目级 mutation/snapshot 单飞门：同一 UUID 上的写与快照串行。 */
export async function withProjectMutationGate<T>(
  projectUuid: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = tails.get(projectUuid) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  tails.set(projectUuid, previous.then(() => current, () => current));
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
  }
}
