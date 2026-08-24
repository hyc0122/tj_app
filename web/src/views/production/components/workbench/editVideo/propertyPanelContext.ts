import type { InjectionKey } from "vue";
import type { usePropertyPanel } from "./composables/usePropertyPanel";

export type PropertyPanelContext = ReturnType<typeof usePropertyPanel>;
export const propertyPanelContextKey: InjectionKey<PropertyPanelContext> = Symbol("property-panel-context");
