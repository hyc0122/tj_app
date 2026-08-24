import { AsyncLocalStorage } from "node:async_hooks";

import type { RequestHandler } from "express";

export interface ServeReadinessSnapshot {
  accepting: boolean;
  closing: boolean;
  /** 可恢复排空：拒绝新写，但可 resumeAccepting */
  reversibleDraining: boolean;
  activeRequestCount: number;
}

export interface TrackedServeRequest {
  finish(): void;
}

interface InternalTrackedServeRequest extends TrackedServeRequest {
  finished: boolean;
}

/**
 * 本地 HTTP 全局就绪门。
 * - reversible_draining：拒绝新请求，可恢复接入（项目关闭阻断后）
 * - irreversible closing：拒绝新请求且不可恢复（beginClosing 之后）
 * 已进入业务链路的请求必须排空后才能销毁 SQLite。
 */
export class ServeReadinessGate {
  private accepting = false;
  private closing = false;
  private reversibleDraining = false;
  private readonly active = new Set<InternalTrackedServeRequest>();
  private readonly requestContext = new AsyncLocalStorage<InternalTrackedServeRequest>();
  private readonly drainWaiters = new Set<() => void>();

  startAccepting(): void {
    if (this.active.size > 0) throw new Error("旧本地服务仍有活动请求，不能重新开放");
    this.accepting = true;
    this.closing = false;
    this.reversibleDraining = false;
  }

  /**
   * 可恢复排空：禁止新 HTTP 业务请求，保留活动请求直到 finish。
   * 项目关闭阻断后必须 resumeAccepting，禁止半关闭。
   */
  beginReversibleDraining(): void {
    if (this.closing) return;
    this.accepting = false;
    this.reversibleDraining = true;
    this.resolveDrainWaitersIfIdle();
  }

  /** 项目关闭阻断后恢复接入；不可逆 closing 后禁止调用成功。 */
  resumeAccepting(): void {
    if (this.closing) {
      throw new Error("本地服务已进入不可逆关闭，禁止恢复接入");
    }
    if (this.active.size > 0) {
      throw new Error("仍有活动请求，不能恢复接入");
    }
    this.accepting = true;
    this.reversibleDraining = false;
  }

  beginClosing(): void {
    this.accepting = false;
    this.closing = true;
    this.reversibleDraining = false;
    this.resolveDrainWaitersIfIdle();
  }

  middleware(): RequestHandler {
    return (_request, response, next) => {
      if (!this.accepting) {
        return response.status(503).send({
          code: 503,
          message: this.reversibleDraining
            ? "本地服务正在安全退出准备中，请稍后重试"
            : "本地服务正在安全关闭",
        });
      }

      const token = this.beginTrackedRequest();
      response.once("finish", token.finish);
      response.once("close", token.finish);
      return this.runWithRequest(token, next);
    };
  }

  beginTrackedRequest(): TrackedServeRequest {
    if (!this.accepting) throw new Error("本地服务正在安全关闭");
    const token: InternalTrackedServeRequest = {
      finished: false,
      finish: () => {
        if (token.finished) return;
        token.finished = true;
        this.active.delete(token);
        this.resolveDrainWaitersIfIdle();
      },
    };
    this.active.add(token);
    return token;
  }

  /** 仅供需要在响应结束前退出进程的安装请求摘除自身，其他请求仍必须正常排空。 */
  detachCurrentRequest(): void {
    this.requestContext.getStore()?.finish();
  }

  runWithRequest<T>(token: TrackedServeRequest, callback: () => T): T {
    return this.requestContext.run(token as InternalTrackedServeRequest, callback);
  }

  waitForDrain(): Promise<void> {
    if (this.active.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.drainWaiters.add(resolve));
  }

  snapshot(): ServeReadinessSnapshot {
    return {
      accepting: this.accepting,
      closing: this.closing,
      reversibleDraining: this.reversibleDraining,
      activeRequestCount: this.active.size,
    };
  }

  /** 测试使用与正式中间件相同的登记逻辑，禁止伪造另一套活动请求状态。 */
  beginTrackedRequestForTest(): TrackedServeRequest {
    return this.beginTrackedRequest();
  }

  private resolveDrainWaitersIfIdle(): void {
    if (this.active.size > 0) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }
}

export const serveReadinessGate = new ServeReadinessGate();

/** Electron 更新入口在当前 HTTP AsyncLocalStorage 上下文中调用。 */
export function detachCurrentServeRequest(): void {
  serveReadinessGate.detachCurrentRequest();
}
