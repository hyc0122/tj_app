/**
 * 账号范围模型目录版本。版本变化只失效目录缓存，不得删除当前 UI 选择。
 */
let catalogVersion = 1;

export function getModelCatalogVersion(): number {
  return catalogVersion;
}

export function bumpModelCatalogVersion(_reason: string): number {
  catalogVersion += 1;
  return catalogVersion;
}
