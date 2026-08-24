import db from "@/utils/db";
import { assertNoImageBase64 } from "@/tianjiang/media/media-safety";

const taskStateMap = {
  "0": "进行中",
  "1": "已完成",
  "-1": "生成失败",
};
/**
 * 记录任务并返回结束函数
 * @param projectId  项目 ID
 * @param taskClass  任务分类
 * @param modelName   模型名称
 * @param opts       可选项：关联对象、任务描
 */
export default async function taskRecord(
  projectId: number,
  taskClass: string,
  modelName: string,
  opts: {
    describe?: string;
    content?: any;
    generation?: {
      provider: string;
      remoteTaskId: string;
      projectUuid: string;
      requestDigest: string;
      createdAt?: number;
    };
  } = {},
) {
  const { content, describe = "", generation } = opts;

  let opteorContent: string | undefined;
  if (content === undefined || content === null) {
    opteorContent = undefined;
  } else if (typeof content === "string") {
    opteorContent = content;
  } else if (typeof content === "function") {
    throw new Error("不支持的类型");
  } else {
    try {
      opteorContent = JSON.stringify(content);
    } catch (e) {
      opteorContent = content.toString();
    }
  }
  assertNoImageBase64(opteorContent, "任务 relatedObjects");

  if (generation) {
    if (
      !/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(generation.provider)
      || generation.remoteTaskId.trim().length === 0
      || !/^[0-9a-f-]{36}$/i.test(generation.projectUuid)
      || !/^[0-9a-f]{64}$/i.test(generation.requestDigest)
    ) {
      throw new Error("生成任务恢复元数据无效");
    }
  }

  const [id] = await db("o_tasks").insert({
    projectId,
    taskClass,
    relatedObjects: opteorContent,
    model: modelName,
    describe,
    state: taskStateMap[0],
    startTime: Date.now(),
    ...(generation ? {
      provider: generation.provider,
      remoteTaskId: generation.remoteTaskId,
      projectUuid: generation.projectUuid,
      requestDigest: generation.requestDigest.toLowerCase(),
      createdAt: generation.createdAt ?? Date.now(),
      generationStatus: "polling",
      manualRetryRequired: 0,
    } : {}),
  });

  /** 任务成功时调用 done(1)，失败时调用 done(-1, '原因') */
  const done = async function done(state: 1 | -1, reason?: string) {
    await db("o_tasks")
      .where("id", id)
      .update({
        state: taskStateMap[state],
        reason: state === -1 ? (reason ?? "") : null,
        ...(generation || done.remoteAttached
          ? { generationStatus: state === 1 ? "completed" : "manual_retry" }
          : {}),
      });
  };
  done.remoteAttached = Boolean(generation?.remoteTaskId);
  done.attachRemote = async (metadata: {
    provider: string;
    remoteTaskId: string;
    projectUuid: string;
    requestDigest: string;
    remoteStatusHint?: string;
  }) => {
    await db.transaction(async (trx) => {
      const row = await trx("o_tasks").where("id", id).first();
      if (!row) throw new Error("本地生成任务记录不存在");
      if (row.remoteTaskId && row.remoteTaskId !== metadata.remoteTaskId) {
        throw new Error("远端任务 ID 已绑定且不允许替换");
      }
      await trx("o_tasks").where("id", id).update({
        provider: metadata.provider,
        remoteTaskId: metadata.remoteTaskId,
        projectUuid: metadata.projectUuid,
        requestDigest: metadata.requestDigest,
        remoteStatusHint: metadata.remoteStatusHint ?? null,
        createdAt: Date.now(),
        lastPollAt: null,
        generationStatus: "polling",
        manualRetryRequired: 0,
      });
    });
    done.remoteAttached = true;
  };
  done.markTemporaryFailure = async (reason: string) => {
    if (!done.remoteAttached) throw new Error("未绑定远端任务，不能标记临时轮询失败");
    await db("o_tasks").where("id", id).update({
      state: "进行中",
      generationStatus: "temporary_failure",
      lastPollAt: Date.now(),
      reason,
      manualRetryRequired: 0,
    });
  };
  done.taskId = Number(id);
  return done;
}
