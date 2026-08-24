import {
  currentAccountScopeEpoch,
  currentAccountScopeId as scopedAccountId,
  setAccountScope,
} from "./account-scope";

export type ProviderCatalogState =
  | "ready"
  | "checking"
  | "failed"
  | "disabled"
  | "not_checked"
  | "stale";

export interface ModelCatalogItem {
  id: string;
  label: string;
  value: string;
  type: string;
  name: string;
  disabled?: boolean;
  disabledReason?: string;
  modes?: string[];
  aspectRatios?: string[];
  resolutions?: string[];
  minReferences?: number;
  maxReferences?: number;
}

export interface ModelProviderCatalogStatus {
  providerId: string;
  providerName: string;
  state: ProviderCatalogState;
  reason?: string;
}

export interface ModelCatalogResponse {
  accountScopeId: string;
  catalogVersion: number;
  items: ModelCatalogItem[];
  providers: ModelProviderCatalogStatus[];
}

export function createModelCatalogStore(options: {
  fetchCatalog: (type: string) => Promise<ModelCatalogResponse>;
  fetchCatalogVersion?: (accountScopeId: string, type: string) => Promise<number>;
}) {
  const snapshots = new Map<string, ModelCatalogResponse>();
  const inflight = new Map<string, Promise<ModelCatalogResponse>>();
  const failures = new Map<string, string>();
  let generation = 0;

  const keyOf = (accountScopeId: string, type: string) => `${accountScopeId}:${type}`;

  const bumpGeneration = () => {
    generation += 1;
  };

  return {
    peek(accountScopeId: string, type: string): ModelCatalogResponse | undefined {
      return snapshots.get(keyOf(accountScopeId, type));
    },
    failure(accountScopeId: string, type: string): string | undefined {
      return failures.get(keyOf(accountScopeId, type));
    },
    async ensure(accountScopeId: string, type: string): Promise<ModelCatalogResponse> {
      const key = keyOf(accountScopeId, type);
      const started = generation;
      const startedEpoch = currentAccountScopeEpoch();
      const cached = snapshots.get(key);
      const running = inflight.get(key);
      if (running) return cached ?? running;
      if (cached && options.fetchCatalogVersion) {
        try {
          const latest = await options.fetchCatalogVersion(accountScopeId, type);
          if (latest === cached.catalogVersion && started === generation
            && startedEpoch === currentAccountScopeEpoch()) return cached;
        } catch {
          // 版本查询失败不得假装 cached 仍权威，继续走真实目录拉取。
        }
      } else if (cached) {
        return cached;
      }
      const task = options.fetchCatalog(type).then((response) => {
        if (started !== generation || startedEpoch !== currentAccountScopeEpoch()) {
          throw new Error("模型目录响应已过期");
        }
        const responseScope = String(response.accountScopeId ?? "").trim();
        // 中文注释：已登录非空请求必须与后端非空 scope 完全一致；空响应只允许未登录空请求。
        if (accountScopeId) {
          if (!responseScope || responseScope !== accountScopeId) {
            throw new Error("模型目录账号作用域不一致");
          }
        } else if (responseScope) {
          throw new Error("模型目录账号作用域不一致");
        }
        const scoped = { ...response, accountScopeId: responseScope };
        snapshots.set(key, scoped);
        failures.delete(key);
        return scoped;
      }).catch((error) => {
        if (started === generation && startedEpoch === currentAccountScopeEpoch()) {
          failures.set(key, error instanceof Error ? error.message : "模型目录刷新失败");
        }
        throw error;
      }).finally(() => {
        if (inflight.get(key) === task) inflight.delete(key);
      });
      inflight.set(key, task);
      return task;
    },
    invalidateAccount(accountScopeId: string): void {
      bumpGeneration();
      for (const key of [...snapshots.keys()]) {
        if (key.startsWith(`${accountScopeId}:`)) {
          snapshots.delete(key);
          inflight.delete(key);
          failures.delete(key);
        }
      }
    },
    invalidateAll(): void {
      bumpGeneration();
      snapshots.clear();
      inflight.clear();
      failures.clear();
    },
  };
}

export function currentAccountScopeId(): string {
  return scopedAccountId();
}

export { setAccountScope };

export const modelCatalogStore = createModelCatalogStore({
  fetchCatalog: async (type) => {
    const { default: axios } = await import("@/utils/axios");
    const { data } = await axios.post("/modelSelect/getModelList", { type });
    const payload = data?.data ?? data;
    if (Array.isArray(payload)) {
      return {
        accountScopeId: currentAccountScopeId(),
        catalogVersion: 1,
        items: payload,
        providers: [],
      };
    }
    return payload as ModelCatalogResponse;
  },
  fetchCatalogVersion: async () => {
    const { default: axios } = await import("@/utils/axios");
    const { data } = await axios.get("/modelSelect/getCatalogVersion");
    const payload = data?.data ?? data;
    return Number(payload?.catalogVersion ?? 0);
  },
});
