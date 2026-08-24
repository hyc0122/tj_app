import { shallowRef } from "vue";

const scopeId = shallowRef("");
const epoch = shallowRef(0);

function bumpEpoch(): void {
  epoch.value += 1;
}

/** 中文注释：无循环依赖的账号作用域，供 renderer 在 require 不可用时使用。 */
export function setAccountScope(userId: number | null | undefined): void {
  const next = typeof userId === "number" && Number.isSafeInteger(userId) && userId > 0
    ? `account:${userId}`
    : "";
  if (next !== scopeId.value) {
    scopeId.value = next;
    bumpEpoch();
    return;
  }
  if (!next) bumpEpoch();
}

export function currentAccountScopeId(): string {
  return scopeId.value;
}

export function currentAccountScopeEpoch(): number {
  return epoch.value;
}

export function bumpAccountScopeEpoch(): void {
  bumpEpoch();
}
