import { Server } from "socket.io";
import productionAgent, {
  type ProductionAgentRouteDependencies,
} from "./routes/productionAgent";
import scriptAgent, {
  type ScriptAgentRouteDependencies,
} from "./routes/scriptAgent";
import { SocketActivityTracker, type SocketActivitySnapshot } from "./activity-tracker";

export interface SocketRuntime {
  /** 可恢复排空：拒新事件，不 disconnect、不关 engine */
  beginReversibleDraining(): void;
  /** 项目关闭阻断后恢复事件接入 */
  resumeAccepting(): void;
  /** 不可逆关闭：disconnect + 关 engine */
  beginClosing(): void;
  waitForDrain(): Promise<void>;
  close(): Promise<void>;
  snapshot(): SocketActivitySnapshot;
}

type SocketRoute = (
  namespace: ReturnType<Server["of"]>,
  activity: SocketActivityTracker,
) => void;

type SocketRoutes = Record<string, SocketRoute>;

export interface SocketRouteDependencies {
  productionAgent?: ProductionAgentRouteDependencies;
  scriptAgent?: ScriptAgentRouteDependencies;
}

export default (
  io: Server,
  routeOverrides?: SocketRoutes,
  dependencies: SocketRouteDependencies = {},
): SocketRuntime => {
  const namespaces = [io.of("/")];
  const routes: SocketRoutes = routeOverrides ?? {
    productionAgent: (namespace, activity) => {
      productionAgent(namespace, activity, dependencies.productionAgent);
    },
    scriptAgent: (namespace, activity) => {
      scriptAgent(namespace, activity, dependencies.scriptAgent);
    },
  };
  const activity = new SocketActivityTracker();

  for (const [name, handler] of Object.entries(routes)) {
    const nsp = io.of(`/api/socket/${name}`);
    namespaces.push(nsp);
    handler(nsp, activity);
    console.log(`[Socket] 注册命名空间: /api/socket/${name}`);
  }

  let socketsDisconnected = false;
  const closedAdapters = new Set<(typeof namespaces)[number]>();
  let engineClosed = false;
  let listenersRemoved = false;
  const beginReversibleDraining = (): void => {
    activity.beginReversibleDraining();
  };
  const resumeAccepting = (): void => {
    activity.resumeAccepting();
  };
  const beginClosing = (): void => {
    activity.beginClosing();
    if (!socketsDisconnected) {
      io.disconnectSockets(true);
      socketsDisconnected = true;
    }
    if (!engineClosed) {
      // Engine.IO 立即停止新握手；已经进入的业务 handler 仍由 activity 等待完成。
      io.engine.close();
      engineClosed = true;
    }
  };
  return {
    beginReversibleDraining,
    resumeAccepting,
    beginClosing,
    waitForDrain: () => activity.waitForDrain(),
    snapshot: () => activity.snapshot(),
    async close(): Promise<void> {
      // 不能调用 io.close()：它会提前关闭共享 HTTP Server，破坏退出顺序。
      beginClosing();
      await activity.waitForDrain();
      for (const namespace of namespaces) {
        if (closedAdapters.has(namespace)) continue;
        await namespace.adapter.close();
        closedAdapters.add(namespace);
      }
      if (!listenersRemoved) {
        io.removeAllListeners();
        listenersRemoved = true;
      }
    },
  };
};
