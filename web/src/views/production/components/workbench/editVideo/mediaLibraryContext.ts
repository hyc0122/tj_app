import type { InjectionKey } from "vue";
import type { useMediaLibrary } from "./composables/useMediaLibrary";

export type MediaLibraryContext = ReturnType<typeof useMediaLibrary>;
export const mediaLibraryContextKey: InjectionKey<MediaLibraryContext> = Symbol("media-library-context");
