export {};

declare module "vue-router" {
  interface RouteMeta {
    canvasHome?: boolean;
    canvasEditor?: boolean;
  }
}
