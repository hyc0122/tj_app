import u from "@/utils";
import { Namespace, Socket } from "socket.io";
import * as agent from "@/agents/scriptAgent/index";
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
import {
  createIdempotentPlanCommitMarker,
  shouldMarkLegacyMutationAfterDecision,
} from "@/agents/scriptAgent/script-agent-decision-result";
import { toPartialCommitFail } from "@/agents/scriptAgent/script-agent-execution";

export interface ScriptAgentRouteDependencies {
  runDecisionAI: typeof agent.runDecisionAI;
}

const defaultDependencies: ScriptAgentRouteDependencies = {
  runDecisionAI: agent.runDecisionAI,
};

export default (
  nsp: Namespace,
  activity: SocketActivityTracker,
  dependencies: ScriptAgentRouteDependencies = defaultDependencies,
) => {
  activity.bindConnection(nsp, async (socket: Socket) => {
    let socketDisconnected = false;
    let abortController: AbortController | null = null;
    const abortActiveAgent = () => {
      const activeController = abortController;
      abortController = null;
      activeController?.abort();
    };
    // 每条连接独立持有 controller；once 在真实断连后自动移除，避免跨连接泄漏。
    socket.once("disconnect", () => {
      socketDisconnected = true;
      abortActiveAgent();
      console.log("[scriptAgent] 已断开连接:", socket.id);
    });
    const canContinue = () => !socketDisconnected && socket.connected;
    if (!(await verifySocketCentralSession(socket)) || !canContinue()) {
      console.log("[scriptAgent] 连接失败，中央会话无效");
      if (socket.connected) socket.disconnect();
      return;
    }
    // 中文注释：auth.projectId 必须为原始 number 正安全整数；禁止 Number("101")
    let projectId: number;
    try {
      projectId = requireStrictPositiveSafeInteger(socket.handshake.auth.projectId);
    } catch {
      console.log("[scriptAgent] 连接失败，projectId 非法");
      if (socket.connected) socket.disconnect();
      return;
    }
    // 服务端派生隔离键，不信任客户端 isolationKey
    const isolationKey = `${projectId}:scriptAgent`;
    let authorizedProjectUuid: string;
    try {
      const authorized = await syncCoordinator.authorizeLegacyRequest(
        socket.data.centralSession as CentralSession,
        describeLegacyProjectTarget("/api/socket/scriptAgent", { projectId }),
        true,
      );
      authorizedProjectUuid = authorized.projectUuid;
      const session = socket.data.centralSession as CentralSession;
      await runWithUserStorage(
        { issuer: session.serverUrl, userId: session.user.id },
        () => prepareProjectDatabase(authorizedProjectUuid),
      );
      if (!canContinue()) return;
    } catch (authErr) {
      console.error(
        "[scriptAgent] 连接授权/准备项目库失败:",
        authErr instanceof Error ? `${authErr.message}\n${authErr.stack}` : String(authErr),
      );
      if (socket.connected) socket.disconnect();
      return;
    }
    socket.data.legacyProjectUuid = authorizedProjectUuid;
    socket.data.scriptAgentProjectId = projectId;
    socket.data.scriptAgentIsolationKey = isolationKey;
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

    console.log("[scriptAgent] 已连接:", socket.id);

    const resTool = new ResTool(socket, {
      projectId,
    });

    const thinkConfig: agent.AgentContext["thinkConfig"] = {
      think: false,
      thinlLevel: 0,
    };

    activity.bindEvent(socket, "chat", async (data: { content: string }) => {
      if (!(await verifySocketCentralSession(socket)) || !canContinue()) {
        if (socket.connected) socket.disconnect();
        return;
      }
      try {
        const authorized = await syncCoordinator.authorizeLegacyRequest(
          socket.data.centralSession as CentralSession,
          describeLegacyProjectTarget("/api/socket/scriptAgent", { projectId }),
          true,
        );
        socket.data.legacyProjectUuid = authorized.projectUuid;
      } catch {
        if (socket.connected) socket.disconnect();
        return;
      }
      // 会话复核/授权期间发生过 disconnect 后，不允许迟到 continuation 新建未取消的 controller。
      if (!canContinue()) return;
      const { content } = data;
      abortController?.abort();
      abortController = new AbortController();
      const currentController = abortController;

      const msg = resTool.newMessage("assistant", "统筹");
      const projectUuid = String(socket.data.legacyProjectUuid);
      /**
       * 幂等 durable mark：
       * 1) recordIntent 落盘（跨 handler / close / 重启）
       * 2) markRuntime 设 dirty
       * intent 成功即 isSatisfied；runtime 失败由 finally 补偿，补偿仍失败则 intent 保留。
       */
      const durableMarker = createIdempotentPlanCommitMarker({
        recordIntent: () => {
          syncCoordinator.recordPendingLegacyMutationOnly(projectUuid, "scriptAgent");
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
        planCommitted: false,
        onPlanCommitted: () => {
          try {
            durableMarker.markOnce();
          } catch {
            // intent 可能已写 / pendingRetry；finally 补偿
          }
        },
      };

      let decisionResult: { planCommitted?: boolean } | undefined;
      try {
        // 仅替换最外层 provider runner，避免动态测试绕过正式 route/connection 生命周期。
        decisionResult = await dependencies.runDecisionAI(ctx);
      } catch (err: any) {
        if (err?.name === "AbortError" || currentController.signal.aborted) {
          try {
            msg.stop();
          } catch {
            // ignore
          }
        } else if (err?.name === "ScriptAgentOutputError" || err?.code?.startsWith?.("SCRIPT_AGENT_OUTPUT") || err?.code === "SCRIPT_AGENT_ABORTED") {
          // 父消息与子消息保持相同提交事实
          if (ctx.planCommitted) {
            const partial =
              err?.code === "SCRIPT_AGENT_OUTPUT_PARTIAL_COMMIT"
                ? {
                    message: err.message,
                    code: "SCRIPT_AGENT_OUTPUT_PARTIAL_COMMIT" as const,
                    stage: err.stage,
                  }
                : toPartialCommitFail(err.stage ?? "storySkeleton", err.responseChars ?? 0, err.finishReason ?? null);
            const safe =
              typeof partial.message === "string" && !/工作区未修改/.test(partial.message)
                ? partial.message
                : "后续阶段未完成，已保存的产物仍保留，请查看工作区后重试";
            console.error("[scriptAgent] output after commit:", partial.code, err.stage ?? "");
            msg.error(safe, {
              errorCode: "SCRIPT_AGENT_OUTPUT_PARTIAL_COMMIT",
              stage: typeof err.stage === "string" ? err.stage : undefined,
            });
          } else {
            const safe =
              typeof err.message === "string" && /[\u3400-\u9fff]/.test(err.message)
                ? err.message
                : "执行层输出不完整，工作区未修改，请重试";
            console.error("[scriptAgent] output contract:", err.code ?? "SCRIPT_AGENT_OUTPUT", err.stage ?? "");
            msg.error(safe, {
              errorCode: typeof err.code === "string" ? err.code : "SCRIPT_AGENT_OUTPUT_INCOMPLETE",
              stage: typeof err.stage === "string" ? err.stage : undefined,
            });
          }
        } else if (err.name !== "AbortError" && !currentController.signal.aborted) {
          if (ctx.planCommitted) {
            // generic tool-error / provider：已提交 → PARTIAL_COMMIT
            const partial = toPartialCommitFail("storySkeleton", 0, null);
            console.error("[scriptAgent] chat error after commit:", err?.name ?? "Error");
            msg.error(partial.message, {
              errorCode: partial.code,
              stage: partial.stage,
            });
          } else {
            const raw = u.error(err).message;
            const safe =
              typeof raw === "string" && /[\u3400-\u9fff]/.test(raw) && !/Error|stack|at\s+/i.test(raw)
                ? raw
                : "剧本 Agent 执行失败，请重试";
            console.error("[scriptAgent] chat error:", err?.name ?? "Error");
            msg.error(safe);
          }
        }
      } finally {
        // 补偿：已提交且 (runtime 未 dirty 或 pendingRetry)；intent 失败则再试完整 markOnce
        const committed =
          ctx.planCommitted === true ||
          shouldMarkLegacyMutationAfterDecision(decisionResult as { planCommitted: boolean } | undefined);
        if (committed && !durableMarker.marked) {
          try {
            durableMarker.markOnce();
          } catch {
            // intent 仍在磁盘；禁止仅 console 后丢弃——handler 结束 intent 可恢复
          }
        }
        // 产物已提交但 journal/intent 与 runtime mark 均失败：禁止当正常结束
        if (committed && !durableMarker.isSatisfied()) {
          console.error("[scriptAgent] mutation intent missing after plan commit");
          try {
            msg.error("产物已保存但同步登记失败，项目保持可恢复，请勿关闭后覆盖，请重试同步", {
              errorCode: "SCRIPT_AGENT_OUTPUT_PARTIAL_COMMIT",
              stage: "storySkeleton",
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
      console.log("[scriptAgent] 更新思考配置:", thinkConfig);
    });

    activity.bindEvent(socket, "stop", () => {
      abortActiveAgent();
    });
  });
};
