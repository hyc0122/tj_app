/**
 * 项目 open/close 的不可复用激活令牌 + 同 UUID 串行锁。
 * 令牌来自进程内全局单调序列；成功 close 后删除活动代次，禁止重放。
 */
export interface ProjectActivationCloseDecision {
  stale: boolean;
  runtimeGeneration: number;
  expectedGeneration: number;
}

export interface ProjectActivationSnapshot {
  generations: number;
  tails: number;
  nextToken: number;
}

export class ProjectRuntimeActivationGate {
  private nextToken = 1;
  private readonly active = new Map<string, number>();
  private readonly tails = new Map<string, Promise<void>>();

  snapshot(): ProjectActivationSnapshot {
    return {
      generations: this.active.size,
      tails: this.tails.size,
      nextToken: this.nextToken,
    };
  }

  currentGeneration(projectUuid: string): number {
    return this.active.get(normalizeProjectUuid(projectUuid)) ?? 0;
  }

  /**
   * 每次成功 open 都发放新令牌，即使项目已经打开。
   */
  issueOpenGeneration(projectUuid: string): number {
    const key = normalizeProjectUuid(projectUuid);
    const token = this.nextToken;
    this.nextToken += 1;
    this.active.set(key, token);
    return token;
  }

  bumpOpenGeneration(projectUuid: string): number {
    return this.issueOpenGeneration(projectUuid);
  }

  releaseAfterClose(projectUuid: string): void {
    this.active.delete(normalizeProjectUuid(projectUuid));
  }

  /**
   * close 请求开始时冻结期望 generation。等待串行锁之后若已被更新的 open 推进，则视为过期。
   */
  captureCloseGeneration(projectUuid: string, requested?: number): number {
    if (requested !== undefined) {
      if (!Number.isSafeInteger(requested) || requested <= 0) {
        throw new Error("runtimeGeneration 无效");
      }
      return requested;
    }
    return this.currentGeneration(projectUuid);
  }

  decideClose(projectUuid: string, expectedGeneration: number): ProjectActivationCloseDecision {
    const runtimeGeneration = this.currentGeneration(projectUuid);
    return {
      stale: expectedGeneration !== runtimeGeneration || runtimeGeneration <= 0,
      runtimeGeneration,
      expectedGeneration,
    };
  }

  async serialize<T>(projectUuid: string, run: () => Promise<T>): Promise<T> {
    const key = normalizeProjectUuid(projectUuid);
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(key, current);
    try {
      await previous.catch(() => undefined);
      return await run();
    } finally {
      release();
      if (this.tails.get(key) === current) this.tails.delete(key);
    }
  }
}

function normalizeProjectUuid(projectUuid: string): string {
  return projectUuid.trim().toLowerCase();
}
