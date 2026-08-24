import type { InjectionKey } from "vue";
import type { AssetsPageContext } from "./useAssetsPage";

export const assetsContextKey: InjectionKey<AssetsPageContext> = Symbol("assets-page-context");
