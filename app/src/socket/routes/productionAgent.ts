import u from "@/utils";
import { Namespace, Socket } from "socket.io";
import * as agent from "@/agents/productionAgent/index";
import ResTool from "@/socket/resTool";
import { verifySocketCentralSession } from "@/tianjiang/auth/socket-session";
import { syncCoordinator } from "@/tianjiang/runtime/runtime";
import type { CentralSession } from "@/tianjiang/auth/central-session";
import { describeLegacyProjectTarget } from "@/tianjiang/runtime/legacy-project-guard";
import { requireStrictPositiveSafeInteger } from "@/tianjiang/runtime/positive-safe-integer";
import { prepareProjectDatabase } from "@/utils/db";
import { runWithProjectStorage } from "@/tianjiang/runtime/user-storage-context";
import { runWithUserStorage } from "@/tianjiang/runtime/user-storage-context";
import type { SocketActivityTracker } from "@/socket/activity-tracker";
import { createIdempotentPlanCommitMarker } from "@/agents/scriptAgent/script-agent-decision-result";

export interface ProductionAgentRouteDependencies {
  runDecisionAI: typeof agent.runDecisionAI;
}

const defaultDependencies: ProductionAgentRouteDependencies = {
  runDecisionAI: agent.runDecisionAI,
};

export default (
  nsp: Namespace,
  activity: SocketActivityTracker,
  dependencies: ProductionAgentRouteDependencies = defaultDependencies,
) => {
  activity.bindConnection(nsp, async (socket: Socket) => {
    let socketDisconnected = false;
    let abortController: AbortController | null = null;
    const abortActiveAgent = () => {
      const activeController = abortController;
      abortController = null;
      activeController?.abort();
    };
    // 必须绑定到具体 Socket；Namespace 不会发出客户端 disconnect 事件。
    socket.once("disconnect", () => {
      socketDisconnected = true;
      abortActiveAgent();
      console.log("[productionAgent] 已断开连接:", socket.id);
    });
    const canContinue = () => !socketDisconnected && socket.connected;
    if (!(await verifySocketCentralSession(socket)) || !canContinue()) {
      console.log("[productionAgent] 连接失败，中央会话无效");
      if (socket.connected) socket.disconnect();
      return;
    }
    // 中文注释：projectId 必须为原始 number；scriptId 可选但若有亦须严格 number
    let currentProjectId: number;
    let currentScriptId: number | undefined;
    try {
      currentProjectId = requireStrictPositiveSafeInteger(socket.handshake.auth.projectId);
      if (socket.handshake.auth.scriptId != null && socket.handshake.auth.scriptId !== "") {
        currentScriptId = requireStrictPositiveSafeInteger(socket.handshake.auth.scriptId);
      }
    } catch {
      console.log("[productionAgent] 连接失败，projectId/scriptId 非法");
      if (socket.connected) socket.disconnect();
      return;
    }
    // 服务端派生隔离键，不信任客户端 isolationKey
    let isolationKey = currentScriptId
      ? `${currentProjectId}:productionAgent:${currentScriptId}`
      : `${currentProjectId}:productionAgent`;
    let authorizedProjectUuid: string;
    try {
      const authorized = await syncCoordinator.authorizeLegacyRequest(
        socket.data.centralSession as CentralSession,
        describeLegacyProjectTarget("/api/socket/productionAgent", {
          projectId: currentProjectId,
          scriptId: currentScriptId,
        }),
        true,
      );
      authorizedProjectUuid = authorized.projectUuid;
      const session = socket.data.centralSession as CentralSession;
      await runWithUserStorage(
        { issuer: session.serverUrl, userId: session.user.id },
        () => prepareProjectDatabase(authorizedProjectUuid),
      );
      if (!canContinue()) return;
    } catch {
      if (socket.connected) socket.disconnect();
      return;
    }
    socket.data.legacyProjectUuid = authorizedProjectUuid;
    socket.use((_event, next) => {
      if (!activity.snapshot().acceptingEvents) {
        next(new Error("本地服务正在关闭，拒绝新的 Socket 事件"));
        return;
      }
      const session = socket.data.centralSession as CentralSession;
      runWithUserStorage(
        { issuer: session.serverUrl, userId: session.user.id },
        () => runWithProjectStorage(String(socket.data.legacyProjectUuid), next),
      );
    });

    console.log("[productionAgent] 已连接:", socket.id);

    let resTool = new ResTool(socket, {
      projectId: currentProjectId,
      scriptId: currentScriptId,
    });

    const thinkConfig: agent.AgentContext["thinkConfig"] = {
      think: false,
      thinlLevel: 0,
    };

    activity.bindEvent(socket, "updateContext", async (data: { isolationKey?: string; projectId: number; scriptId?: number }, callback) => {
      if (!(await verifySocketCentralSession(socket)) || !canContinue()) {
        callback?.({ success: false, message: "中央会话无效" });
        if (socket.connected) socket.disconnect();
        return;
      }
      let nextProjectId: number;
      let nextScriptId: number | undefined;
      try {
        nextProjectId = requireStrictPositiveSafeInteger(data.projectId);
        if (data.scriptId != null) {
          nextScriptId = requireStrictPositiveSafeInteger(data.scriptId);
        }
      } catch {
        callback?.({ success: false, message: "项目标识无效" });
        return;
      }
      try {
        const authorized = await syncCoordinator.authorizeLegacyRequest(
          socket.data.centralSession as CentralSession,
          describeLegacyProjectTarget("/api/socket/productionAgent", {
            projectId: nextProjectId,
            scriptId: nextScriptId,
          }),
          true,
        );
        const session = socket.data.centralSession as CentralSession;
        await runWithUserStorage(
          { issuer: session.serverUrl, userId: session.user.id },
          () => prepareProjectDatabase(authorized.projectUuid),
        );
        if (!canContinue()) return;
        socket.data.legacyProjectUuid = authorized.projectUuid;
      } catch {
        callback?.({ success: false, message: "项目当前不可写" });
        if (socket.connected) socket.disconnect();
        return;
      }
      currentProjectId = nextProjectId;
      currentScriptId = nextScriptId;
      isolationKey = nextScriptId
        ? `${nextProjectId}:productionAgent:${nextScriptId}`
        : `${nextProjectId}:productionAgent`;
      resTool = new ResTool(socket, {
        projectId: nextProjectId,
        scriptId: nextScriptId,
      });
      console.log("[productionAgent] 上下文已更新:", isolationKey);
      callback?.({ success: true });
    });

    activity.bindEvent(socket, "chat", async (data: { content: string }) => {
      if (!(await verifySocketCentralSession(socket)) || !canContinue()) {
        if (socket.connected) socket.disconnect();
        return;
      }
      try {
        const authorized = await syncCoordinator.authorizeLegacyRequest(
          socket.data.centralSession as CentralSession,
          describeLegacyProjectTarget("/api/socket/productionAgent", {
            projectId: currentProjectId,
            scriptId: currentScriptId,
          }),
          true,
        );
        socket.data.legacyProjectUuid = authorized.projectUuid;
      } catch {
        if (socket.connected) socket.disconnect();
        return;
      }
      // disconnect 可能发生在会话复核或项目授权 await 中；永久状态阻止迟到 continuation 启动 provider。
      if (!canContinue()) return;
      const { content } = data;
      abortController?.abort();
      abortController = new AbortController();
      const currentController = abortController;

      const msg = resTool.newMessage("assistant", "视频策划");
      const projectUuid = String(socket.data.legacyProjectUuid);
      const durableMarker = createIdempotentPlanCommitMarker({
        recordIntent: () => {
          syncCoordinator.recordPendingLegacyMutationOnly(projectUuid, "productionAgent");
        },
        markRuntime: () => {
          syncCoordinator.markLegacyMutation(projectUuid);
        },
      });
      const ctx: agent.AgentContext = {
        socket,
        isolationKey,
        text: content,
        userMessageTime: new Date(msg.datetime).getTime() - 1,
        abortSignal: currentController.signal,
        resTool,
        msg,
        thinkConfig,
        artifactCommitted: false,
        onArtifactCommitted: () => {
          try {
            durableMarker.markOnce();
          } catch {
            // intent 或 pendingRetry 由 finally 幂等补偿。
          }
        },
      };

      try {
        // 测试仅在 Agent/provider 边界注入 runner；认证、路由、Socket 与 tracker 保持生产实现。
        await dependencies.runDecisionAI(ctx);
      } catch (err: any) {
        if (err?.name === "AbortError" || currentController.signal.aborted) {
          try {
            msg.stop();
          } catch {
            // ignore
          }
        } else if (
          err?.name === "ProductionAgentOutputError" ||
          err?.code?.startsWith?.("PRODUCTION_AGENT_OUTPUT") ||
          err?.code === "PRODUCTION_AGENT_ABORTED"
        ) {
          const safe =
            typeof err?.message === "string" && /[\u3400-\u9fff]/.test(err.message)
              ? err.message
              : "导演规划输出不完整，工作区未修改，请重试";
          msg.error(safe, {
            errorCode:
              typeof err?.code === "string"
                ? err.code
                : "PRODUCTION_AGENT_OUTPUT_INCOMPLETE",
            stage: "directorPlan",
          });
          console.error("[productionAgent] output contract:", err?.code ?? "PRODUCTION_AGENT_OUTPUT");
        } else if (err.name !== "AbortError" && !currentController.signal.aborted) {
          console.error("[productionAgent] chat error:", u.error(err).message);
        }
      } finally {
        if (ctx.artifactCommitted && !durableMarker.marked) {
          try {
            durableMarker.markOnce();
          } catch {
            // project.sqlite journal 已保留；后续 open/close 可恢复 pending mutation。
          }
        }
        if (ctx.artifactCommitted && !durableMarker.isSatisfied()) {
          try {
            msg.error("导演规划已保存但同步登记失败，项目保持可恢复，请重试同步", {
              errorCode: "PRODUCTION_AGENT_OUTPUT_INCOMPLETE",
              stage: "directorPlan",
            });
          } catch {
            // ignore
          }
        }
        if (abortController === currentController) {
          abortController = null;
        }
      }
    });

    activity.bindEvent(socket, "updateThinkConfig", (data: { think: boolean; thinlLevel: 0 | 1 | 2 | 3 }) => {
      thinkConfig.think = data.think;
      thinkConfig.thinlLevel = data.thinlLevel;
      console.log("[productionAgent] 更新思考配置:", thinkConfig);
    });

    activity.bindEvent(socket, "stop", () => {
      abortActiveAgent();
    });
  });
};
