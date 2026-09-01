<template>
  <VueFlow
    id="personal-infinite-canvas"
    :nodes="nodes"
    :edges="edges"
    :node-types="nodeTypes"
    :apply-default="false"
    :only-render-visible-elements="true"
    :fit-view-on-init="false"
    :min-zoom="0.1"
    :max-zoom="4"
    :default-viewport="viewport"
    :delete-key-code="null"
    @nodes-change="onNodesChange"
    @edges-change="onEdgesChange"
    @node-drag-start="onNodeDragStart"
    @node-drag-stop="onNodeDragStop"
    @move-end="onMoveend"
    @connect="onConnect"
    @pane-context-menu="onPaneContextMenu"
    @drop.prevent="onDrop"
    @dragover.prevent
  >
    <Background />
    <Controls />
    <MiniMap pannable zoomable />
  </VueFlow>
</template>

<script setup lang="ts">
import type { Connection, Edge, EdgeChange, Node, NodeChange, NodeTypesObject, ViewportTransform } from "@vue-flow/core";
import { VueFlow } from "@vue-flow/core";
import { Background } from "@vue-flow/background";
import { Controls } from "@vue-flow/controls";
import { MiniMap } from "@vue-flow/minimap";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import "@vue-flow/controls/dist/style.css";
import "@vue-flow/minimap/dist/style.css";
import TextCanvasNode from "./nodes/TextCanvasNode.vue";
import MediaCanvasNode from "./nodes/MediaCanvasNode.vue";
import FileCanvasNode from "./nodes/FileCanvasNode.vue";
import GenerationCanvasNode from "./nodes/GenerationCanvasNode.vue";
import StoryboardCanvasNode from "./nodes/StoryboardCanvasNode.vue";
import GroupCanvasNode from "./nodes/GroupCanvasNode.vue";

defineProps<{
  nodes: Node[];
  edges: Edge[];
  viewport: { x: number; y: number; zoom: number };
}>();

const emit = defineEmits<{
  (event: "nodes-change", changes: NodeChange[]): void;
  (event: "edges-change", changes: EdgeChange[]): void;
  (event: "node-drag-start"): void;
  (event: "node-drag-stop"): void;
  (event: "moveend", viewport: ViewportTransform): void;
  (event: "connect", connection: Connection): void;
  (event: "pane-context-menu", mouse: MouseEvent): void;
  (event: "drop-files", files: File[]): void;
}>();

const nodeTypes = {
  text: TextCanvasNode,
  image: MediaCanvasNode,
  video: MediaCanvasNode,
  audio: MediaCanvasNode,
  file: FileCanvasNode,
  storyboard: StoryboardCanvasNode,
  image_generation: GenerationCanvasNode,
  video_generation: GenerationCanvasNode,
  group: GroupCanvasNode,
} as unknown as NodeTypesObject;

function onNodesChange(changes: NodeChange[]): void {
  emit("nodes-change", changes);
}
function onEdgesChange(changes: EdgeChange[]): void {
  emit("edges-change", changes);
}
function onNodeDragStart(): void {
  emit("node-drag-start");
}
function onNodeDragStop(): void {
  emit("node-drag-stop");
}
function onMoveend(moveEvent: { flowTransform: ViewportTransform }): void {
  emit("moveend", moveEvent.flowTransform);
}
function onConnect(connection: Connection): void {
  emit("connect", connection);
}
function onPaneContextMenu(event: MouseEvent): void {
  emit("pane-context-menu", event);
}
function onDrop(event: DragEvent): void {
  const files = [...(event.dataTransfer?.files ?? [])];
  if (files.length > 0) emit("drop-files", files);
}
</script>
