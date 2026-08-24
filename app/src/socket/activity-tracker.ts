import type { Namespace, Socket } from "socket.io";

export interface SocketActivitySnapshot {
  acceptingEvents: boolean;
  activeHandlerCount: number;
}

type SocketWork = () => unknown | Promise<unknown>;
type SocketEventHandler = (...args: any[]) => unknown | Promise<unknown>;

/**
 * Socket.IO 统一活动门：所有 namespace connection 与业务事件都从这里登记。
 * - reversible_draining：拒绝新工作，可 resume；不拆连接监听
 * - irreversible beginClosing：拒绝新工作并移除 connection 监听
 * 已开始的 Promise 必须排空后才能 Team release / 快照 / runtime 删除。
 */
export class SocketActivityTracker {
  private acceptingEvents = true;
  private reversibleDraining = false;
  private irreversible = false;
  private readonly activeHandlers = new Set<Promise<unknown>>();
  private readonly drainWaiters = new Set<() => void>();
  private readonly namespaces = new Set<Namespace>();

  snapshot(): SocketActivitySnapshot {
    return {
      acceptingEvents: this.acceptingEvents,
      activeHandlerCount: this.activeHandlers.size,
    };
  }

  isReversibleDraining(): boolean {
    return this.reversibleDraining;
  }

  bindConnection(
    namespace: Namespace,
    handler: (socket: Socket) => unknown | Promise<unknown>,
  ): void {
    this.namespaces.add(namespace);
    namespace.use((_socket, next) => {
      if (this.acceptingEvents) next();
      else next(new Error("本地服务正在关闭，拒绝新的 Socket 连接"));
    });
    namespace.on("connection", (socket) => {
      this.dispatch(socket, () => handler(socket));
    });
  }

  bindEvent(
    socket: Socket,
    event: string,
    handler: SocketEventHandler,
    onClosing?: (...args: any[]) => void,
  ): void {
    socket.on(event, (...args: any[]) => {
      this.dispatch(socket, () => handler(...args), () => onClosing?.(...args));
    });
  }

  /**
   * 可恢复排空：停止新事件/连接，不拆 namespace connection 监听，可 resumeAccepting。
   */
  beginReversibleDraining(): void {
    if (this.irreversible) return;
    this.acceptingEvents = false;
    this.reversibleDraining = true;
    this.resolveDrainIfReady();
  }

  resumeAccepting(): void {
    if (this.irreversible) {
      throw new Error("Socket 已进入不可逆关闭，禁止恢复接入");
    }
    this.acceptingEvents = true;
    this.reversibleDraining = false;
  }

  beginClosing(): void {
    this.irreversible = true;
    this.reversibleDraining = false;
    if (!this.acceptingEvents && this.irreversible) {
      // already not accepting; still strip listeners once
    }
    this.acceptingEvents = false;
    // connection listener 必须同步移除；namespace middleware 继续为竞态握手失败关闭。
    for (const namespace of this.namespaces) namespace.removeAllListeners("connection");
    this.resolveDrainIfReady();
  }

  waitForDrain(): Promise<void> {
    if (this.activeHandlers.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.drainWaiters.add(resolve));
  }

  private dispatch(socket: Socket, work: SocketWork, onClosing?: () => void): void {
    const task = this.track(work);
    if (!task) {
      onClosing?.();
      // 中文注释：可恢复 draining 只拒绝新事件，不断开已有连接。
      if (this.irreversible) socket.disconnect(true);
      return;
    }
    // 中文注释：已启动 handler 的未知异常始终隔离到当前连接。
    void task.catch(() => socket.disconnect(true));
  }

  private track(work: SocketWork): Promise<unknown> | undefined {
    if (!this.acceptingEvents) return undefined;
    const task = Promise.resolve().then(work);
    this.activeHandlers.add(task);
    const release = () => {
      this.activeHandlers.delete(task);
      this.resolveDrainIfReady();
    };
    void task.then(release, release);
    return task;
  }

  private resolveDrainIfReady(): void {
    if (this.acceptingEvents || this.activeHandlers.size > 0) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }
}
