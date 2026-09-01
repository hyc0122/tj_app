import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { tablerDirectImports } from "./vite/tablerDirectImports";

const vendor = (relative: string) => resolve(__dirname, "tap-packages", relative);

export default defineConfig({
  base: "/tapcanvas/",
  define: {
    "import.meta.env.VITE_OBJECT_STORAGE_PROVIDER": JSON.stringify("r2"),
    "import.meta.env.VITE_TOS_PUBLIC_BASE_URL": JSON.stringify("https://assets.tianjiang.invalid/tos"),
    "import.meta.env.VITE_R2_PUBLIC_BASE_URL": JSON.stringify("https://assets.tianjiang.invalid/r2"),
  },
  plugins: [
    react({
      babel: {
        plugins: [tablerDirectImports],
      },
    }),
  ],
  resolve: {
    extensions: [".ts", ".tsx", ".mjs", ".js", ".mts", ".jsx", ".json"],
    alias: {
      "virtual:pwa-register/react": resolve(__dirname, "src/tianjiang/pwaStub.ts"),
      zod: resolve(__dirname, "node_modules/zod"),
      "@tapcanvas/agent-observability": vendor("packages/agent-observability/index.d.ts"),
      "@tapcanvas/canvas-plan-protocol": vendor("packages/canvas-plan-protocol/index.ts"),
      "@tapcanvas/codex-task-protocol": vendor("packages/codex-task-protocol/index.ts"),
      "@tapcanvas/chapter-canvas-intents": vendor("packages/chapter-canvas-intents/index.ts"),
      "@tapcanvas/canvas-edge-semantics": vendor("packages/canvas-edge-semantics/index.ts"),
      "@tapcanvas/character-bible-protocol": vendor("packages/character-bible-protocol/index.ts"),
      "@tapcanvas/flow-anchor-bindings": vendor("hono/flow/flow.anchor-bindings.ts"),
      "@tapcanvas/script-structure-protocol": vendor("packages/script-structure-protocol/index.ts"),
      "@tapcanvas/shot-table-protocol": vendor("packages/shot-table-protocol/index.ts"),
      "@tapcanvas/video-orchestrator-protocol": vendor("packages/video-orchestrator-protocol/index.ts"),
      "@tapcanvas/workflow-kernel-protocol": vendor("packages/workflow-kernel-protocol/index.ts"),
      "@tapcanvas/project-directory-protocol": vendor("hono/project-directory/project-directory.contract.ts"),
      "@tapcanvas/storyboard-director-protocol": vendor("packages/storyboard-director-protocol/index.ts"),
      "@tapcanvas/storyboard-selection-protocol": vendor("packages/storyboard-selection-protocol/index.ts"),
      "@tapcanvas/storyboard-adventure-protocol": vendor("packages/storyboard-adventure-protocol/index.ts"),
      "@tapcanvas/image-prompt-spec": vendor("packages/image-prompt-spec/index.js"),
      "@tapcanvas/image-view-controls": vendor("packages/image-view-controls/index.mjs"),
      "@tapcanvas/image-operation-protocol": vendor("packages/image-operation-protocol/index.ts"),
    },
  },
  optimizeDeps: {
    include: ["@tapcanvas/image-prompt-spec", "@tapcanvas/image-view-controls"],
    exclude: ["@tabler/icons-react", "@tapcanvas/image-operation-protocol"],
  },
  server: {
    port: 5175,
    fs: {
      allow: [resolve(__dirname), resolve(__dirname, "tap-packages")],
    },
  },
  build: {
    outDir: resolve(__dirname, "../dist/tapcanvas"),
    emptyOutDir: true,
    commonjsOptions: {
      include: [/node_modules/, /tap-packages\/packages\/image-prompt-spec/],
      transformMixedEsModules: true,
    },
  },
});
