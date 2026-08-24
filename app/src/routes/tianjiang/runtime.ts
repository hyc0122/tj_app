import express from "express";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { z } from "zod";

import { validateFields } from "@/middleware/middleware";
import {
  closeProjectFileHandle,
  openProjectFileHandle,
  readProjectFileFdSync,
} from "@/tianjiang/media/project-file-store";
import fs from "node:fs";
import { RuntimePermissionError } from "@/tianjiang/runtime/sync-coordinator";
import { syncProgressStore } from "@/tianjiang/runtime/sync-progress";
import { syncCoordinator } from "@/tianjiang/runtime/runtime";
import { userStorageSegment } from "@/tianjiang/runtime/user-storage-context";
import getPath from "@/utils/getPath";

import storyboardRuntimeRouter from "./storyboard-runtime";
import { StoryboardService } from "@/tianjiang/storyboard/storyboard-service";
import {
  projectOperationPort,
  enterTeamWriteGuard,
  teamWriteGuardFromHeaders,
} from "@/tianjiang/runtime/project-operation-port";

const router = express.Router();
const projectUuid = z.string().uuid();
const recoveryId = z.string().regex(/^[0-9]{10,}-[a-z0-9_-]{1,80}$/i);

router.get("/status", (_req, res) => {
  try {
    res.status(200).send({
      code: 0,
      data: syncCoordinator.status((_req as any).centralSession),
      message: "同步状态读取成功",
    });
  } catch (error) {
    writeRuntimeError(res, error);
  }
});

router.get("/projects", (_req, res) => {
  try {
    res.status(200).send({
      code: 0,
      data: syncCoordinator.listProjects((_req as any).centralSession),
      message: "项目目录读取成功",
    });
  } catch (error) {
    writeRuntimeError(res, error);
  }
});

/** 刷新本地运行时目录快照；必须写在 :uuid 路由之前。 */
router.post("/projects/refresh", async (req, res) => {
  try {
    const data = await syncCoordinator.refreshProjectCatalog((req as any).centralSession);
    res.status(200).send({ code: 0, data, message: "项目目录已刷新" });
  } catch (error) {
    writeRuntimeError(res, error);
  }
});

router.delete("/projects/:uuid/storyboard/shots", async (req, res) => {
  try {
    const uuid = projectUuid.parse(String(req.params.uuid ?? ""));
    enterTeamWriteGuard(teamWriteGuardFromHeaders(req.headers as Record<string, unknown>));
    const shotUuids = Array.isArray(req.body?.shotUuids) ? req.body.shotUuids.map(String) : [];
    await projectOperationPort.withProject(
      (req as { centralSession?: never }).centralSession,
      uuid,
      "write",
      async () => new StoryboardService(uuid).deleteShots(shotUuids),
    );
    res.status(200).send({ code: 0, data: { deleted: shotUuids.length }, message: "分镜已删除" });
  } catch (error) {
    writeRuntimeError(res, error);
  }
});

router.use("/projects/:uuid/storyboard", storyboardRuntimeRouter);

router.post("/projects/:uuid/open", async (req, res) => {
  try {
    const uuid = projectUuid.parse(req.params.uuid);
    const state = await syncCoordinator.openProject((req as any).centralSession, uuid);
    res.status(200).send({ code: 0, data: state, message: "项目已打开" });
  } catch (error) {
    writeRuntimeError(res, error);
  }
});

router.get("/projects/:uuid/recoveries", (req, res) => {
  try {
    const uuid = projectUuid.parse(req.params.uuid);
    const entries = syncCoordinator.listRecoveries((req as any).centralSession, uuid);
    res.status(200).send({ code: 0, data: entries, message: "恢复副本读取成功" });
  } catch (error) {
    writeRuntimeError(res, error);
  }
});

router.post(
  "/projects/:uuid/recoveries/:recoveryId/resolve",
  validateFields({ resolution: z.literal("keep_backup") }),
  (req, res) => {
    try {
      const uuid = projectUuid.parse(req.params.uuid);
      const entry = syncCoordinator.resolveRecovery(
        (req as any).centralSession,
        uuid,
        recoveryId.parse(req.params.recoveryId),
        req.body.resolution,
      );
      res.status(200).send({ code: 0, data: entry, message: "恢复副本已保留并标记处理" });
    } catch (error) {
      writeRuntimeError(res, error);
    }
  },
);

router.post(
  "/projects/:uuid/edit",
  validateFields({
    namespace: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/i),
    key: z.string().min(1).max(160),
    value: z.unknown(),
  }),
  async (req, res) => {
    try {
      const uuid = projectUuid.parse(req.params.uuid);
      await syncCoordinator.editProject(
        (req as any).centralSession,
        uuid,
        req.body.namespace,
        req.body.key,
        req.body.value,
      );
      res.status(200).send({ code: 0, data: { projectUuid: uuid }, message: "项目编辑已记录" });
    } catch (error) {
      writeRuntimeError(res, error);
    }
  },
);

router.post("/projects/:uuid/close", async (req, res) => {
  try {
    const uuid = projectUuid.parse(req.params.uuid);
    const result = await syncCoordinator.closeProject((req as any).centralSession, uuid);
    res.status(200).send({ code: 0, data: result, message: "项目已关闭" });
  } catch (error) {
    writeRuntimeError(res, error);
  }
});

/** 方案 B：中央回收站成功后清理本机副本；失败则持久化 local_purge 待办。 */
router.post("/projects/:uuid/purge-local", async (req, res) => {
  try {
    const uuid = projectUuid.parse(req.params.uuid);
    const result = await syncCoordinator.purgeLocalProjectCopy(
      (req as any).centralSession,
      uuid,
    );
    res.status(200).send({
      code: 0,
      data: result,
      message: result.localPurged
        ? "本地项目已清理"
        : result.cleanupPending
          ? "本地清理已排队，下次启动继续"
          : "本地项目已不存在",
    });
  } catch (error) {
    writeRuntimeError(res, error);
  }
});

router.post(
  "/network",
  validateFields({ online: z.boolean() }),
  async (req, res) => {
    try {
      await syncCoordinator.setNetworkOnline((req as any).centralSession, req.body.online);
      res.status(200).send({
        code: 0,
        data: syncCoordinator.status((req as any).centralSession),
        message: "网络状态已更新",
      });
    } catch (error) {
      writeRuntimeError(res, error);
    }
  },
);

router.post("/projects/:uuid/lock-invalid", async (req, res) => {
  try {
    const uuid = projectUuid.parse(req.params.uuid);
    await syncCoordinator.onLockInvalid((req as any).centralSession, uuid);
    res.status(200).send({
      code: 0,
      data: syncCoordinator.status((req as any).centralSession),
      message: "锁失效已处理",
    });
  } catch (error) {
    writeRuntimeError(res, error);
  }
});

router.post("/projects/:uuid/sync", async (req, res) => {
  try {
    const uuid = projectUuid.parse(req.params.uuid);
    const result = await syncCoordinator.syncNow((req as any).centralSession, uuid);
    res.status(200).send({ code: 0, data: result, message: "手动同步完成" });
  } catch (error) {
    writeRuntimeError(res, error);
  }
});

router.post(
  "/profile",
  validateFields({
    key: z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/i),
    value: z.string().max(1_000_000),
    sensitive: z.boolean().optional(),
  }),
  (req, res) => {
    try {
      // 中文注释：即使兼容保留 sensitive 字段，也不得覆盖注册表。
      syncCoordinator.setProfileValue(
        (req as any).centralSession,
        req.body.key,
        req.body.value,
      );
      res.status(200).send({ code: 0, data: null, message: "个人配置已进入同步队列" });
    } catch (error) {
      writeRuntimeError(res, error);
    }
  },
);

router.post("/profile/flush", async (req, res) => {
  try {
    const result = await syncCoordinator.flushProfile((req as any).centralSession);
    res.status(200).send({ code: 0, data: result, message: "个人配置同步完成" });
  } catch (error) {
    writeRuntimeError(res, error);
  }
});

/** 真实个人配置同步状态，禁止 renderer 伪造协议状态。 */
router.get("/profile-sync/status", (req, res) => {
  try {
    const status = syncCoordinator.status((req as any).centralSession);
    const profile = (status.profile ?? { state: "idle", version: 0 }) as Record<string, unknown>;
    res.status(200).send({
      code: 0,
      data: {
        state: profile.state ?? "idle",
        version: Number(profile.version ?? 0),
        lastSuccessAt: profile.lastSuccessAt ?? null,
        failureCode: profile.failureCode ?? null,
        failureMessage: profile.failureMessage ?? null,
        retryable: profile.retryable === true,
      },
      message: "个人配置同步状态",
    });
  } catch (error) {
    writeRuntimeError(res, error);
  }
});

router.post("/profile-sync/retry", async (req, res) => {
  try {
    const result = await syncCoordinator.retryProfileSync((req as any).centralSession);
    res.status(200).send({ code: 0, data: result, message: "已触发个人配置重试" });
  } catch (error) {
    writeRuntimeError(res, error);
  }
});

router.get("/migration", (req, res) => {
  try {
    const result = syncCoordinator.migrationStatus((req as any).centralSession);
    res.status(200).send({ code: 0, data: result, message: "迁移状态读取成功" });
  } catch (error) {
    writeRuntimeError(res, error);
  }
});

router.post("/migration/run", async (req, res) => {
  try {
    const result = await syncCoordinator.runMigration((req as any).centralSession);
    res.status(200).send({ code: 0, data: result, message: "旧库迁移完成" });
  } catch (error) {
    writeRuntimeError(res, error);
  }
});

router.post("/migration/rollback", async (req, res) => {
  try {
    await syncCoordinator.rollbackMigration((req as any).centralSession);
    res.status(200).send({ code: 0, data: null, message: "本次迁移已回滚" });
  } catch (error) {
    writeRuntimeError(res, error);
  }
});

/** 真实同步进度；渲染端轮询，禁止前端假进度。 */
router.get("/sync-progress", (_req, res) => {
  try {
    res.status(200).send({
      code: 0,
      data: syncProgressStore.get(),
      message: "同步进度",
    });
  } catch (error) {
    writeRuntimeError(res, error);
  }
});

/**
 * 受保护项目文件读取。
 * 中文注释：先用会话核验项目可见性，再安全解析路径；跨账号/跨项目/越界统一 404，不泄露存在性。
 */
// 中文注释：Express 5 path-to-regexp 要求命名通配参数，禁止匿名 *。
function sendProtectedProjectFile(req: express.Request, res: express.Response): void {
  try {
    const uuid = projectUuid.parse(req.params.uuid);
    const session = (req as any).centralSession;
    if (!session?.user?.id || !session.serverUrl) {
      res.status(404).send({ code: 404, message: "项目文件不存在" });
      return;
    }
    // 可见性：目录中不存在则 404
    const visible = syncCoordinator.listProjects(session).some((item) => item.projectUuid === uuid);
    if (!visible) {
      res.status(404).send({ code: 404, message: "项目文件不存在" });
      return;
    }
    const rawFilePath = (req.params as Record<string, unknown>).filePath;
    const wildcard = String(
      Array.isArray(rawFilePath) ? rawFilePath.join("/") : (rawFilePath ?? ""),
    ).replace(/^\/+/, "");
    const relativePath = `files/${wildcard}`;
    const segment = userStorageSegment({ issuer: session.serverUrl, userId: session.user.id });
    const handle = openProjectFileHandle(getPath(), uuid, segment, relativePath);
    let handedToStream = false;
    try {
      const ext = path.extname(relativePath).toLowerCase();
      const contentType = contentTypeForExt(ext);
      const range = parseByteRange(req.headers.range, handle.size);
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
      if (range.kind === "unsatisfiable") {
        res.status(416);
        res.setHeader("Content-Range", `bytes */${handle.size}`);
        res.end();
        return;
      }
      const start = range.kind === "partial" ? range.start : 0;
      const end = range.kind === "partial" ? range.end : Math.max(0, handle.size - 1);
      if (range.kind === "partial") {
        res.status(206);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${handle.size}`);
        res.setHeader("Content-Length", String(end - start + 1));
      } else {
        res.status(200);
        res.setHeader("Content-Length", String(handle.size));
      }
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      const length = handle.size > 0 ? end - start + 1 : 0;
      // 中文注释：同一 fd 完成 fstat/Range/读取；短读不得零填充成功响应。
      if (length <= 2 * 1024 * 1024) {
        const bytes = Buffer.alloc(length);
        if (length > 0) {
          const read = readProjectFileFdSync(handle.fd, bytes, length, start);
          if (read !== length) throw new Error("项目文件读取不完整");
        }
        res.end(bytes);
        return;
      }
      const stream = fs.createReadStream("", {
        fd: handle.fd,
        start,
        end,
        autoClose: true,
      });
      handedToStream = true;
      const onClientClose = () => {
        stream.destroy();
      };
      req.on("close", onClientClose);
      const cleanup = () => {
        req.off("close", onClientClose);
      };
      stream.on("error", cleanup);
      stream.on("close", cleanup);
      void pipeline(stream, res).then(cleanup, () => {
        cleanup();
        if (!res.headersSent) {
          res.status(404).send({ code: 404, message: "项目文件不存在" });
        } else if (!res.writableEnded) {
          res.end();
        }
      });
    } catch (error) {
      if (!handedToStream) closeProjectFileHandle(handle.fd);
      throw error;
    } finally {
      // 中文注释：HEAD/416/小文件/异常都必须关掉本次打开的 fd；只有大文件流接管后才交给 autoClose。
      if (!handedToStream) closeProjectFileHandle(handle.fd);
    }
  } catch {
    // 中文注释：fail-closed——任何路径/权限异常都不区分原因，避免侧信道。
    if (!res.headersSent) {
      res.status(404).send({ code: 404, message: "项目文件不存在" });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}

router.get("/projects/:uuid/files/*filePath", sendProtectedProjectFile);
router.head("/projects/:uuid/files/*filePath", (req, res) => {
  Object.defineProperty(req, "method", { value: "HEAD" });
  sendProtectedProjectFile(req, res);
});

function parseByteRange(
  header: string | undefined,
  size: number,
): { kind: "full" } | { kind: "partial"; start: number; end: number } | { kind: "unsatisfiable" } {
  if (!header) return { kind: "full" };
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) return { kind: "unsatisfiable" };
  const startRaw = match[1];
  const endRaw = match[2];
  if (!startRaw && !endRaw) return { kind: "unsatisfiable" };
  if (!startRaw) {
    const suffix = Number(endRaw);
    if (!Number.isInteger(suffix) || suffix <= 0 || size <= 0) return { kind: "unsatisfiable" };
    return { kind: "partial", start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(startRaw);
  const end = endRaw ? Number(endRaw) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    return { kind: "unsatisfiable" };
  }
  return { kind: "partial", start, end: Math.min(end, Math.max(0, size - 1)) };
}

function contentTypeForExt(ext: string): string {
  switch (ext) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    case ".mp4": return "video/mp4";
    case ".webm": return "video/webm";
    case ".mov": return "video/quicktime";
    case ".mkv": return "video/x-matroska";
    case ".avi": return "video/x-msvideo";
    case ".mp3": return "audio/mpeg";
    case ".wav": return "audio/wav";
    case ".pdf": return "application/pdf";
    case ".txt": return "text/plain; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    default: return "application/octet-stream";
  }
}

function writeRuntimeError(res: express.Response, error: unknown): void {
  const explicitStatus = Number((error as { status?: unknown })?.status);
  const status = Number.isInteger(explicitStatus)
    ? explicitStatus
    : error instanceof RuntimePermissionError ? error.status : 422;
  res.status(status).send({
    code: status,
    message: error instanceof Error ? error.message : "同步运行时请求失败",
  });
}

export default router;
