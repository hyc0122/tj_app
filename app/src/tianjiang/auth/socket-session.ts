import type { Socket } from "socket.io";
import { centralAuthGateway, centralSessionStore } from "./auth-runtime";
import { readSessionCookie } from "./central-session";
import { isDefinitiveSessionAuthFailure } from "./session-auth-failure";
import { syncCoordinator } from "../runtime/runtime";
import { prepareUserDatabase } from "@/utils/db";
import {
  enterUserStorage,
  runWithUserStorage,
} from "../runtime/user-storage-context";

const authenticatedSockets = new Map<Socket, string>();

export function disconnectSocketsExceptSession(activeSessionId: string): void {
  for (const [socket, sessionId] of [...authenticatedSockets]) {
    if (sessionId !== activeSessionId) {
      authenticatedSockets.delete(socket);
      socket.disconnect(true);
    }
  }
}

/**
 * 校验 Socket 中央会话。
 * - 缺 Cookie / 空 sessionId：仅拒绝当前连接，绝不清理全局同步运行时。
 * - 未知/过期 opaque id：仅当 id 与当前 coordinator 会话匹配时才 fail-closed 清理。
 * - 明确 401：删除匹配内存会话并 onSessionInvalid。
 * - 网络/503/DB 准备失败：拒绝本连接，保留账号运行时。
 */
export async function verifySocketCentralSession(socket: Socket): Promise<boolean> {
  const sessionID = readSessionCookie(socket.request.headers.cookie);
  // 缺 Cookie：握手路径若错误（如默认 /socket.io）常见此分支；禁止 onSessionInvalid("")。
  if (!sessionID.trim()) {
    console.log("[Socket] 缺少会话 Cookie，拒绝当前连接（不清理全局运行时）");
    return false;
  }
  const session = centralSessionStore.get(sessionID);
  if (!session) {
    console.log("[Socket] 会话不存在或已过期，拒绝当前连接");
    // 仅当 opaque id 与当前运行时一致时才清理（避免未知 id 误杀）。
    await syncCoordinator.onSessionInvalid(sessionID);
    return false;
  }
  try {
    if (Date.now() - session.validatedAt > 30_000) {
      await centralAuthGateway.validate(session);
      // 中央验证等待期间可能已经断连；死连接不得继续准备数据库或更新会话状态。
      if (!socket.connected) return false;
      session.validatedAt = Date.now();
      centralSessionStore.update(session);
    }
    const storageIdentity = { issuer: session.serverUrl, userId: session.user.id };
    await prepareUserDatabase(storageIdentity);
    // 必须在最后一个 await 后先检查连接，再同步安装清理 listener 与登记 Map。
    if (!socket.connected) return false;
    if (!socket.data.userStorageBound) {
      // 每个后续 Socket packet 都重新进入所属中央用户上下文，不能复用其他连接的 DB/OSS。
      socket.use((_event, next) => {
        runWithUserStorage(storageIdentity, next);
      });
      socket.data.userStorageBound = true;
    }
    enterUserStorage(storageIdentity);
    socket.data.centralUser = session.user;
    socket.data.centralSession = session;
    if (!socket.data.tianjiangDisconnectTracked) {
      socket.once("disconnect", () => authenticatedSockets.delete(socket));
      socket.data.tianjiangDisconnectTracked = true;
    }
    authenticatedSockets.set(socket, session.id);
    return true;
  } catch (error) {
    // prepareUserDatabase / 网络 / 503：只拒绝本 Socket，不得删除会话。
    if (!isDefinitiveSessionAuthFailure(error)) {
      console.log("[Socket] 可恢复故障，拒绝当前连接但保留会话");
      return false;
    }
    centralSessionStore.delete(session.id);
    await syncCoordinator.onSessionInvalid(session);
    return false;
  }
}
