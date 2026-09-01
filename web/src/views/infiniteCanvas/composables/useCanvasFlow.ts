import { computed, onMounted, reactive, ref, watch } from "vue";
import { useVueFlow } from "@vue-flow/core";
import type { CanvasNodeKind } from "@/features/tianjiang/canvas/types";
import { serializeCanvasDocument } from "@/features/tianjiang/canvas/document";
import { layoutCanvasNodes } from "@/features/tianjiang/canvas/layout";
import { useCanvasStore } from "@/stores/canvas";
import { useCanvasAutosave } from "./useCanvasAutosave";

const RUN_IDENTITY_KEYS = ["runUuid", "taskUuid", "confirmationUuid", "currentRun", "latestRun"] as const;

interface GraphNode {
  nodeUuid: string;
  kind: CanvasNodeKind;
  position: { x: number; y: number };
  size?: { width: number; height: number };
  parentNodeUuid?: string;
  zIndex: number;
  collapsed: boolean;
  data: Record<string, unknown>;
}

interface GraphEdge {
  edgeUuid: string;
  kind: string;
  sourceNodeUuid: string;
  targetNodeUuid: string;
  sourceHandle?: string;
  targetHandle?: string;
  label?: string;
}

interface FlowNode {
  id: string;
  type?: string;
  position: { x: number; y: number };
  parentNode?: string;
  zIndex?: number;
  data?: Record<string, unknown>;
  style?: Record<string, string>;
  extent?: "parent";
}

interface FlowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  label?: string;
  data?: { kind?: string };
}

interface NodeChange {
  type: string;
  id?: string;
  selected?: boolean;
  dragging?: boolean;
  position?: { x: number; y: number };
}

interface EdgeChange {
  type: string;
  id?: string;
}

interface Connection {
  source?: string | null;
  target?: string | null;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

interface ViewportTransform {
  x: number;
  y: number;
  zoom: number;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stripRunIdentity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripRunIdentity);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if ((RUN_IDENTITY_KEYS as readonly string[]).includes(key)) continue;
      result[key] = stripRunIdentity(item);
    }
    return result;
  }
  return value;
}

function asGraphNodes(nodes: unknown[]): GraphNode[] {
  return (nodes ?? []).map((node) => node as GraphNode);
}

function asGraphEdges(edges: unknown[]): GraphEdge[] {
  return (edges ?? []).map((edge) => edge as GraphEdge);
}

function toFlowNode(node: GraphNode): FlowNode {
  return {
    id: node.nodeUuid,
    type: node.kind,
    position: { ...node.position },
    parentNode: node.parentNodeUuid,
    zIndex: node.zIndex,
    data: cloneJson(node.data),
    style: node.size
      ? { width: `${node.size.width}px`, height: `${node.size.height}px` }
      : undefined,
    extent: node.parentNodeUuid ? "parent" : undefined,
  };
}

function toFlowEdge(edge: GraphEdge): FlowEdge {
  return {
    id: edge.edgeUuid,
    source: edge.sourceNodeUuid,
    target: edge.targetNodeUuid,
    sourceHandle: edge.sourceHandle ?? "out",
    targetHandle: edge.targetHandle ?? "in",
    label: edge.label,
    data: { kind: edge.kind },
  };
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

function portsCompatible(sourceKind: string, targetKind: string): boolean {
  if (sourceKind === targetKind && sourceKind === "group") return false;
  return sourceKind !== "" && targetKind !== "";
}

export function useCanvasFlow() {
  const store = useCanvasStore();
  const autosave = useCanvasAutosave();
  const flow = useVueFlow({ id: "personal-infinite-canvas" });
  const { onConnect, $destroy } = flow;

  const nodes = ref<FlowNode[]>([]);
  const edges = ref<FlowEdge[]>([]);
  const contextMenu = reactive({ visible: false, x: 0, y: 0 });
  let dragBefore: ReturnType<typeof cloneJson<(typeof store)["document"]>> | null = null;
  let clipboard: { nodes: GraphNode[]; edges: GraphEdge[] } = { nodes: [], edges: [] };

  function graphSnapshot(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    return {
      nodes: asGraphNodes(store.document.graph.nodes),
      edges: asGraphEdges(store.document.graph.edges),
    };
  }

  function hydrateFromStore(): void {
    const graph = graphSnapshot();
    nodes.value = graph.nodes.map(toFlowNode);
    edges.value = graph.edges.map(toFlowEdge);
  }

  function commitGraph(label: string, nextNodes: GraphNode[], nextEdges: GraphEdge[]): void {
    const before = cloneJson(store.document);
    store.document.graph = { nodes: nextNodes, edges: nextEdges };
    store.document = serializeCanvasDocument(store.document);
    store.history.push({
      label,
      before,
      after: cloneJson(store.document),
    });
    hydrateFromStore();
    autosave.schedule();
  }

  function onPointermove(): void {
    // 中文注释：指针移动只更新运行态，不得进入规范事务或触发保存。
  }

  function onNodesChange(changes: NodeChange[]): void {
    const selected = new Set(flow.getSelectedNodes.value.map((node) => node.id));
    for (const change of changes) {
      if (change.type === "select" && change.id) {
        if (change.selected) selected.add(change.id);
        else selected.delete(change.id);
      }
      if (change.type === "remove") {
        const graph = graphSnapshot();
        commitGraph(
          "删除节点",
          graph.nodes.filter((node) => node.nodeUuid !== change.id),
          graph.edges.filter((edge) => edge.sourceNodeUuid !== change.id && edge.targetNodeUuid !== change.id),
        );
      }
      if (change.type === "position") {
        const moving = change as { id: string; dragging?: boolean; position?: { x: number; y: number } };
        if (moving.position && moving.dragging) {
          const live = nodes.value as Array<{ id: string; position: { x: number; y: number } }>;
          const current = live.find((node) => node.id === moving.id);
          if (current) current.position = moving.position;
        }
      }
    }
  }

  function onEdgesChange(changes: EdgeChange[]): void {
    for (const change of changes) {
      if (change.type === "remove") {
        const graph = graphSnapshot();
        commitGraph("删除连线", graph.nodes, graph.edges.filter((edge) => edge.edgeUuid !== change.id));
      }
    }
  }

  function onNodeDragStart(): void {
    dragBefore = cloneJson(store.document);
  }

  function onNodeDragStop(): void {
    // 中文注释：drag-stop 把多选拖动收成一次事务，pointermove 过程零 HTTP。
    const graph = graphSnapshot();
    const moved = graph.nodes.map((node) => {
      const live = nodes.value.find((item) => item.id === node.nodeUuid);
      return live ? { ...node, position: { ...live.position } } : node;
    });
    const before = dragBefore ?? cloneJson(store.document);
    store.document.graph = { nodes: moved, edges: graph.edges };
    store.document = serializeCanvasDocument(store.document);
    store.history.push({
      label: "移动节点",
      before,
      after: cloneJson(store.document),
    });
    dragBefore = null;
    hydrateFromStore();
    autosave.schedule();
  }

  function onMoveend(viewport?: ViewportTransform): void {
    if (!viewport) return;
    store.updateViewport({ x: viewport.x, y: viewport.y, zoom: viewport.zoom });
    autosave.schedule();
  }

  function isDuplicateEdge(source: string, target: string, sourceHandle: string, targetHandle: string): boolean {
    return graphSnapshot().edges.some((edge) => (
      edge.sourceNodeUuid === source
      && edge.targetNodeUuid === target
      && (edge.sourceHandle ?? "out") === sourceHandle
      && (edge.targetHandle ?? "in") === targetHandle
    ));
  }

  function connectEdge(connection: Connection): void {
    if (!connection.source || !connection.target) return;
    if (connection.source === connection.target) return;
    const sourceHandle = connection.sourceHandle ?? "out";
    const targetHandle = connection.targetHandle ?? "in";
    if (isDuplicateEdge(connection.source, connection.target, sourceHandle, targetHandle)) return;
    const graph = graphSnapshot();
    const sourceNode = graph.nodes.find((node) => node.nodeUuid === connection.source);
    const targetNode = graph.nodes.find((node) => node.nodeUuid === connection.target);
    if (!sourceNode || !targetNode) return;
    if (!portsCompatible(sourceNode.kind, targetNode.kind)) return;
    commitGraph("连接", graph.nodes, graph.edges.concat([{
      edgeUuid: crypto.randomUUID(),
      kind: "default",
      sourceNodeUuid: connection.source,
      targetNodeUuid: connection.target,
      sourceHandle,
      targetHandle,
    }]));
  }

  onConnect(connectEdge);

  function addNode(kind: CanvasNodeKind, position = { x: 80, y: 80 }): void {
    const graph = graphSnapshot();
    const node: GraphNode = {
      nodeUuid: crypto.randomUUID(),
      kind,
      position,
      zIndex: graph.nodes.length + 1,
      collapsed: false,
      data: { title: kind },
    };
    commitGraph("新增节点", graph.nodes.concat([node]), graph.edges);
  }

  function selectedGraphNodes(): GraphNode[] {
    const selected = new Set(flow.getSelectedNodes.value.map((node) => node.id));
    return graphSnapshot().nodes.filter((node) => selected.has(node.nodeUuid));
  }

  function copySelection(): void {
    const selectedNodes = selectedGraphNodes();
    const selectedIds = new Set(selectedNodes.map((node) => node.nodeUuid));
    const selectedEdges = graphSnapshot().edges.filter((edge) => (
      selectedIds.has(edge.sourceNodeUuid) && selectedIds.has(edge.targetNodeUuid)
    ));
    clipboard = {
      nodes: cloneJson(selectedNodes),
      edges: cloneJson(selectedEdges),
    };
  }

  function pasteClipboard(): void {
    if (clipboard.nodes.length === 0) return;
    const idMap = new Map<string, string>();
    const pastedNodes = clipboard.nodes.map((node) => {
      const nodeUuid = crypto.randomUUID();
      idMap.set(node.nodeUuid, nodeUuid);
      return {
        ...node,
        nodeUuid,
        parentNodeUuid: node.parentNodeUuid ? idMap.get(node.parentNodeUuid) ?? node.parentNodeUuid : undefined,
        position: { x: node.position.x + 32, y: node.position.y + 32 },
        data: stripRunIdentity(node.data) as Record<string, unknown>,
      };
    });
    const pastedEdges = clipboard.edges.flatMap((edge) => {
      const sourceNodeUuid = idMap.get(edge.sourceNodeUuid);
      const targetNodeUuid = idMap.get(edge.targetNodeUuid);
      if (!sourceNodeUuid || !targetNodeUuid) return [];
      return [{
        ...edge,
        edgeUuid: crypto.randomUUID(),
        sourceNodeUuid,
        targetNodeUuid,
      }];
    });
    const graph = graphSnapshot();
    commitGraph("粘贴", graph.nodes.concat(pastedNodes), graph.edges.concat(pastedEdges));
  }

  function deleteSelection(): void {
    const selected = new Set(flow.getSelectedNodes.value.map((node) => node.id));
    if (selected.size === 0) return;
    const graph = graphSnapshot();
    commitGraph(
      "删除选中",
      graph.nodes.filter((node) => !selected.has(node.nodeUuid)),
      graph.edges.filter((edge) => !selected.has(edge.sourceNodeUuid) && !selected.has(edge.targetNodeUuid)),
    );
  }

  function groupSelection(): void {
    const selected = selectedGraphNodes();
    if (selected.length === 0) return;
    const groupUuid = crypto.randomUUID();
    const xs = selected.map((node) => node.position.x);
    const ys = selected.map((node) => node.position.y);
    const group: GraphNode = {
      nodeUuid: groupUuid,
      kind: "group",
      position: { x: Math.min(...xs) - 24, y: Math.min(...ys) - 24 },
      size: { width: 480, height: 320 },
      zIndex: 0,
      collapsed: false,
      data: { title: "分组" },
    };
    const selectedIds = new Set(selected.map((node) => node.nodeUuid));
    const graph = graphSnapshot();
    const nextNodes = graph.nodes.map((node) => (
      selectedIds.has(node.nodeUuid) ? { ...node, parentNodeUuid: groupUuid } : node
    ));
    commitGraph("分组", [group, ...nextNodes], graph.edges);
  }

  function ungroupSelection(): void {
    const selected = new Set(selectedGraphNodes().map((node) => node.nodeUuid));
    const graph = graphSnapshot();
    const nextNodes = graph.nodes
      .filter((node) => !(node.kind === "group" && selected.has(node.nodeUuid)))
      .map((node) => (
        node.parentNodeUuid && selected.has(node.parentNodeUuid)
          ? { ...node, parentNodeUuid: undefined }
          : node
      ));
    commitGraph("解组", nextNodes, graph.edges);
  }

  function applyLayout(mode: "grid" | "vertical" | "flow"): void {
    const graph = graphSnapshot();
    const laid = layoutCanvasNodes(graph.nodes, mode);
    const nextNodes = graph.nodes.map((node, index) => ({
      ...node,
      position: laid[index]?.position ?? node.position,
    }));
    commitGraph("布局", nextNodes, graph.edges);
  }

  function undo(): void {
    const item = store.history.undo();
    if (!item) return;
    store.document = cloneJson(item.before);
    hydrateFromStore();
    autosave.schedule();
  }

  function redo(): void {
    const item = store.history.redo();
    if (!item) return;
    store.document = cloneJson(item.after);
    hydrateFromStore();
    autosave.schedule();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.isComposing || event.key === "Process") return;
    if (isTypingTarget(event.target)) return;
    const ctrl = event.ctrlKey || event.metaKey;
    if (ctrl && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (ctrl && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo();
      return;
    }
    if (ctrl && event.key.toLowerCase() === "c") {
      event.preventDefault();
      copySelection();
      return;
    }
    if (ctrl && event.key.toLowerCase() === "v") {
      event.preventDefault();
      pasteClipboard();
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      deleteSelection();
    }
  }

  function openContextMenu(event: MouseEvent): void {
    event.preventDefault();
    contextMenu.visible = true;
    contextMenu.x = event.clientX;
    contextMenu.y = event.clientY;
  }

  function attachAssetNode(assetUuid: string, kind: CanvasNodeKind, title: string): void {
    const graph = graphSnapshot();
    commitGraph("素材节点", graph.nodes.concat([{
      nodeUuid: crypto.randomUUID(),
      kind,
      position: { x: 120, y: 120 },
      zIndex: graph.nodes.length + 1,
      collapsed: false,
      data: { title, assetUuid },
    }]), graph.edges);
  }

  function destroy(): void {
    window.removeEventListener("pointermove", onPointermove);
    window.removeEventListener("keydown", onKeydown);
    void autosave.flushNow();
    $destroy?.();
  }

  onMounted(() => {
    hydrateFromStore();
    window.addEventListener("pointermove", onPointermove);
    window.addEventListener("keydown", onKeydown);
  });

  watch(() => store.document, () => {
    if (nodes.value.length === 0 && store.document.graph.nodes.length > 0) hydrateFromStore();
  }, { deep: true });

  return {
    nodes,
    edges,
    contextMenu,
    viewport: computed(() => store.document.viewport),
    hydrateFromStore,
    onNodesChange,
    onEdgesChange,
    onNodeDragStart,
    onNodeDragStop,
    onMoveend,
    connectEdge,
    addNode,
    copySelection,
    pasteClipboard,
    deleteSelection,
    groupSelection,
    ungroupSelection,
    applyLayout,
    undo,
    redo,
    openContextMenu,
    attachAssetNode,
    destroy,
    flush: autosave.flushNow,
  };
}
