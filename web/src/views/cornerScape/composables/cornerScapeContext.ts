import type { InjectionKey } from "vue";
import type { CornerScapePageContext } from "./useCornerScapePage";

export const cornerScapeContextKey: InjectionKey<CornerScapePageContext> = Symbol("corner-scape-context");
