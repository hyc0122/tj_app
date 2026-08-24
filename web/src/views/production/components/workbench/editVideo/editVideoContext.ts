import type { InjectionKey } from "vue";
import type { useEditVideoPage } from "./composables/useEditVideoPage";

export type EditVideoContext = ReturnType<typeof useEditVideoPage>;
export const editVideoContextKey: InjectionKey<EditVideoContext> = Symbol("edit-video-context");
