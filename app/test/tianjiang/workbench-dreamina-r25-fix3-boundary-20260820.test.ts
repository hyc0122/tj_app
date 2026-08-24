import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  accountDb,
  activateUserDatabase,
  destroyAllDatabaseHandles,
  destroyProjectDatabaseHandle,
  initializeWorkspaceProject,
  prepareProjectDatabase,
  resetDatabaseRuntimeForServe,
  db as activeDb,
} from "../../src/utils/db";
import { rebuildMissingDreaminaDispatch } from "../../src/tianjiang/model-providers/dreamina-cli/recovery";
import { installDreaminaResult } from "../../src/tianjiang/model-providers/dreamina-cli/result-installer";
import { projectDirectory, projectFilesDirectory } from "../../src/tianjiang/data/paths";
import { writeProjectFileAtomic } from "../../src/tianjiang/media/project-file-store";
import { getStableDeviceUUID } from "../../src/tianjiang/auth/device";
import getPath from "../../src/utils/getPath";
import {
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
  userStorageSegment,
} from "../../src/tianjiang/runtime/user-storage-context";
import { closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 2582 };
const PROJECT = "b0252582-2582-4522-a522-252225822582";
const OTHER_PROJECT = "c0252582-2582-4522-a522-252225822582";
const PROJECT_ID = 2582;
const OTHER_PROJECT_ID = 2583;
const SEGMENT = userStorageSegment(IDENTITY);
const workspaceTempRoot = path.resolve(__dirname, "../../../.tmp");

async function withRuntime(name: string, run: (root: string) => Promise<void>): Promise<void> {
  const root = path.join(workspaceTempRoot, `${name}-${process.pid}-${crypto.randomUUID()}`);
  const previousCwd = process.cwd();
  const previousNodeEnv = process.env.NODE_ENV;
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "test";
  resetDatabaseRuntimeForServe();
  try {
    await activateUserDatabase(IDENTITY);
    await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await initializeWorkspaceProject(PROJECT, {
        id: PROJECT_ID,
        name: "R25-fix3 boundary",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      await run(root);
    });
  } finally {
    await runWithUserStorage(IDENTITY, () => closeActivatedWorkspaceRuntime()).catch(() => undefined);
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(previousCwd);
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("恢复扫描拒绝指向 runtime 外部的项目 junction，不能生成账号 dispatch", async () => {
  await withRuntime("r25f3-recovery-project-link", async (root) => {
    await initializeWorkspaceProject(OTHER_PROJECT, {
      id: OTHER_PROJECT_ID,
      name: "外部项目夹具",
      projectType: "storyboard" as "novel",
      userId: IDENTITY.userId,
    });
    const now = Date.now();
    const taskUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await runWithProjectStorage(OTHER_PROJECT, () => activeDb("o_storyboardGenerationTask").insert({
      taskUuid,
      shotUuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      parentTaskUuid: null,
      originDeviceUuid: getStableDeviceUUID(getPath()),
      mediaType: "image",
      providerId: "dreamina-cli",
      providerTaskId: null,
      providerSessionId: null,
      mode: "text2image",
      modelName: "dreamina-cli:text2image",
      parametersJson: JSON.stringify({ prompt: "outside" }),
      requestDigest: "d".repeat(64),
      status: "queued",
      paidBatchConfirmedAt: null,
      providerCompletedAt: null,
      resultLocatorDigest: null,
      progress: 0,
      errorCode: null,
      errorSummary: null,
      createdAt: now,
      updatedAt: now,
    }));

    const projectRoot = projectDirectory(getPath(), OTHER_PROJECT, SEGMENT);
    await destroyProjectDatabaseHandle(SEGMENT, OTHER_PROJECT);
    const outsideRoot = path.join(root, "outside-project", OTHER_PROJECT);
    fs.mkdirSync(path.dirname(outsideRoot), { recursive: true });
    fs.renameSync(projectRoot, outsideRoot);
    fs.symlinkSync(outsideRoot, projectRoot, "junction");
    try {
      await rebuildMissingDreaminaDispatch();
      const projected = await accountDb("o_dreaminaCliDispatch")
        .where({ projectUuid: OTHER_PROJECT })
        .select("taskUuid");
      assert.deepEqual(projected, [], "外部项目库不得被恢复扫描投影到当前账号");
    } finally {
      // 中文注释：RED 版本可能已经打开 junction 指向的外部库，先关闭句柄才能恢复夹具目录。
      await destroyProjectDatabaseHandle(SEGMENT, OTHER_PROJECT).catch(() => undefined);
      if (fs.existsSync(projectRoot) && fs.lstatSync(projectRoot).isSymbolicLink()) fs.unlinkSync(projectRoot);
      if (fs.existsSync(outsideRoot)) fs.renameSync(outsideRoot, projectRoot);
    }
  });
});

test("图片结果的 input.files 在 staging 外时必须拒绝且不得安装", async () => {
  await withRuntime("r25f3-installer-image-root", async () => {
    const taskUuid = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const shotUuid = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const stagingDirectory = path.join(process.cwd(), "staging", taskUuid);
    const outsideFile = path.join(process.cwd(), "outside-secret.png");
    fs.mkdirSync(stagingDirectory, { recursive: true });
    fs.writeFileSync(outsideFile, Buffer.from("SECRET-OUTSIDE-IMAGE"));
    const projectRoot = projectDirectory(getPath(), PROJECT, SEGMENT);
    try {
      await assert.rejects(
        () => installDreaminaResult({
          projectUuid: PROJECT,
          taskUuid,
          shotUuid,
          mediaType: "image",
          stagingDirectory,
          files: [outsideFile],
        }),
        (error: unknown) => (error as { code?: unknown })?.code === "DREAMINA_RESULT_INSTALL_FAILED",
      );
      const candidateRoot = path.join(projectRoot, "files", "images", "storyboard", shotUuid);
      const installed = fs.existsSync(candidateRoot)
        ? fs.readdirSync(candidateRoot).filter((name) => fs.statSync(path.join(candidateRoot, name)).isFile())
        : [];
      assert.deepEqual(installed, [], "staging 外图片不得产生项目结果文件");
    } finally {
      fs.rmSync(outsideFile, { force: true });
    }
  });
});

test("项目文件写入在父目录被 junction 替换后必须写前失败", () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "r25f3-writer-parent-link-"));
  const projectUuid = "e0252582-2582-4522-a522-252225822582";
  const filesRoot = projectFilesDirectory(dataRoot, projectUuid, SEGMENT);
  const targetDirectory = path.join(filesRoot, "images");
  const originalDirectory = `${targetDirectory}.original-${crypto.randomUUID()}`;
  const outsideDirectory = path.join(dataRoot, "outside");
  const originalMkdirSync = fs.mkdirSync;
  let swapped = false;
  fs.mkdirSync = ((directory: fs.PathLike, options?: fs.MakeDirectoryOptions | null) => {
    const result = originalMkdirSync(directory, options as never);
    if (!swapped && path.resolve(String(directory)) === path.resolve(targetDirectory)) {
      fs.renameSync(targetDirectory, originalDirectory);
      fs.mkdirSync(outsideDirectory, { recursive: true });
      fs.symlinkSync(outsideDirectory, targetDirectory, "junction");
      swapped = true;
    }
    return result;
  }) as typeof fs.mkdirSync;
  try {
    let thrown: unknown;
    try {
      writeProjectFileAtomic(
        dataRoot,
        projectUuid,
        SEGMENT,
        "files/images/escape.png",
        Buffer.from("SECRET-OUTSIDE-WRITE"),
      );
    } catch (error) {
      thrown = error;
    }
    assert.equal(swapped, true, "夹具必须命中 mkdir 后父目录替换窗口");
    assert.ok(thrown, "父目录替换后 writer 必须在写入前失败");
    assert.match(String((thrown as { message?: unknown }).message ?? thrown), /项目|路径|链接|重解析|安全/);
    assert.equal(fs.existsSync(path.join(outsideDirectory, "escape.png")), false,
      "父目录替换后不得向项目外写入 payload");
  } finally {
    fs.mkdirSync = originalMkdirSync;
    if (fs.existsSync(targetDirectory) && fs.lstatSync(targetDirectory).isSymbolicLink()) fs.unlinkSync(targetDirectory);
    if (fs.existsSync(originalDirectory) && !fs.existsSync(targetDirectory)) fs.renameSync(originalDirectory, targetDirectory);
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
