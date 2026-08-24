import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Knex } from "knex";

import { accountDatabase } from "@/utils/db";
import { findProfileSyncRegistration } from "./profile-sync-registry";
import type { ProfileSync } from "./profile-sync";
import { bumpModelCatalogVersion } from "../model-providers/model-catalog-invalidation";
import {
  readBoundModelPromptContent,
  resolveAccountModelPromptFile,
} from "../prompts/account-model-prompt";
import getPath from "@/utils/getPath";
import { currentUserStorage, userStorageRoot } from "../runtime/user-storage-context";

export { readBoundModelPromptContent };

export const MEMORY_SETTING_KEYS = [
  "messagesPerSummary",
  "shortTermLimit",
  "summaryMaxLength",
  "summaryLimit",
  "ragLimit",
  "deepRetrieveSummaryLimit",
  "modelOnnxFile",
  "modelDtype",
  "agentUseMode",
] as const;

const COLLECTION_PREFIXES = ["vendorItem.", "vendor.", "prompt.", "model.", "agent.", "skill."] as const;

const CAPTURE_TABLES = [
  "o_vendorconfig",
  "o_modelprompt",
  "o_prompt",
  "o_agentdeploy",
  "o_setting",
  "o_skilllist",
];

let boundSync: ProfileSync | null = null;
let boundReadWait: Promise<unknown> | null = null;
let lastCalibrationState: "idle" | "calibrating" | "ready" | "failed" | "stale" = "idle";
let applying = false;
let captureTimer: ReturnType<typeof setTimeout> | undefined;
let captureInFlight: Promise<void> | null = null;
let captureDirty = false;

export function bindAccountProfileSync(sync: ProfileSync | null): void {
  boundSync = sync;
}

/** 中文注释：登录成功后只绑定账号 ProfileSync。即梦全部状态保持纯本机存储。 */
export function bindAccountSyncBindings(sync: ProfileSync | null): void {
  bindAccountProfileSync(sync);
}

export function restoreAccountSyncBindings(sync: ProfileSync | null): void {
  bindAccountSyncBindings(sync);
}

export function bindSettingsDependentRead(wait: Promise<unknown> | null): void {
  boundReadWait = wait;
  if (wait) {
    lastCalibrationState = "calibrating";
    void Promise.resolve(wait).then((result) => {
      if (boundReadWait !== wait && boundReadWait !== null) return;
      if (result && typeof result === "object" && "state" in result && (result as { state?: string }).state === "failed") {
        lastCalibrationState = "failed";
        return;
      }
      lastCalibrationState = boundSync?.status().state === "failed" ? "failed" : "ready";
    }).catch(() => {
      if (boundReadWait !== wait && boundReadWait !== null) return;
      lastCalibrationState = "failed";
    });
  }
}

export async function awaitSettingsDependentRead(): Promise<void> {
  // 中文注释：本地首屏与缓存目录不得等待远端 ProfileSync；校准状态另行暴露。
  return;
}

export function getSettingsCalibrationState(): "idle" | "calibrating" | "ready" | "failed" | "stale" {
  if (boundReadWait || boundSync?.currentReconcile()) return "calibrating";
  const state = boundSync?.status().state;
  if (state === "failed") return "failed";
  if (state === "syncing") return "calibrating";
  if (state === "synced") return "ready";
  return lastCalibrationState;
}

export function isApplyingProfileSettings(): boolean {
  return applying;
}

export function shouldCaptureAccountSql(sql: string): boolean {
  const text = sql.toLowerCase();
  if (!/\b(insert|update|delete)\b/.test(text)) return false;
  return CAPTURE_TABLES.some((table) => text.includes(table));
}

export function scheduleAccountSettingsCapture(): void {
  if (applying || !boundSync) return;
  if (captureTimer) clearTimeout(captureTimer);
  captureTimer = setTimeout(() => {
    void notifyAccountSettingsMutated().catch(() => undefined);
  }, 20);
}

export async function notifyAccountSettingsMutated(): Promise<void> {
  if (applying || !boundSync) return;
  if (captureInFlight) {
    captureDirty = true;
    return captureInFlight;
  }
  const running = (async () => {
    do {
      captureDirty = false;
      if (!boundSync || applying) return;
      await recordLiveSettingsToProfile(boundSync);
    } while (captureDirty);
  })().finally(() => {
    if (captureInFlight === running) captureInFlight = null;
  });
  captureInFlight = running;
  return running;
}

export async function afterAccountSettingsWrite(): Promise<void> {
  await notifyAccountSettingsMutated();
  bumpModelCatalogVersion("setting-write");
}

export interface VendorLogicalMutation {
  op: "upsert" | "delete";
  id: string;
}

export const VENDOR_MUTATION_OUTBOX = "o_profileVendorOutbox";

/** 中文注释：账号库 durable outbox，禁止再使用进程全局数组表达明确 mutation。 */
export async function ensureVendorMutationOutbox(db: Knex): Promise<void> {
  await db.raw(`
    CREATE TABLE IF NOT EXISTS ${VENDOR_MUTATION_OUTBOX} (
      operationId TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL,
      op TEXT NOT NULL CHECK (op IN ('upsert', 'delete')),
      vendorId TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'profile_written')),
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `);
}

/**
 * 中文注释：o_vendorConfig 业务修改与 outbox 必须同一账号事务提交或回滚。
 * 不得写入 inputValues、API Key 或其他凭据。
 */
export async function commitVendorConfigMutation(
  db: Knex,
  mutation: VendorLogicalMutation,
  work: (trx: Knex.Transaction) => Promise<void>,
): Promise<string> {
  if (mutation.op !== "upsert" && mutation.op !== "delete") {
    throw new Error("供应商变更类型无效");
  }
  const vendorId = assertVendorCollectionId(String(mutation.id ?? ""));
  const operationId = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.transaction(async (trx) => {
    await work(trx);
    await ensureVendorMutationOutbox(trx);
    const last = await trx(VENDOR_MUTATION_OUTBOX).max<{ m: number | null }>("sequence as m").first();
    await trx(VENDOR_MUTATION_OUTBOX).insert({
      operationId,
      sequence: Number(last?.m ?? 0) + 1,
      op: mutation.op,
      vendorId,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    });
  });
  return operationId;
}

interface VendorOutboxRow {
  operationId: string;
  sequence: number;
  op: "upsert" | "delete";
  vendorId: string;
}

async function loadConvergedVendorOutbox(db: Knex): Promise<VendorOutboxRow[]> {
  await ensureVendorMutationOutbox(db);
  const rows = await db(VENDOR_MUTATION_OUTBOX)
    .where({ status: "queued" })
    .orderBy("sequence", "asc")
    .select("operationId", "sequence", "op", "vendorId");
  const latest = new Map<string, VendorOutboxRow>();
  for (const row of rows as VendorOutboxRow[]) {
    latest.set(row.vendorId, row);
  }
  return [...latest.values()].sort((left, right) => left.sequence - right.sequence);
}

async function confirmVendorOutbox(db: Knex, vendorId: string, sequence: number): Promise<void> {
  await db(VENDOR_MUTATION_OUTBOX)
    .where({ vendorId })
    .andWhere("sequence", "<=", sequence)
    .andWhere({ status: "queued" })
    .update({
      status: "profile_written",
      updatedAt: new Date().toISOString(),
    });
}

/**
 * 中文注释：登录前把所属账号 queued outbox 幂等写成 profile.sqlite pending。
 * 只允许本地 SQLite I/O，禁止先请求远端 metadata/current。
 */
export async function prepareVendorOutboxForProfileLogin(sync: ProfileSync): Promise<void> {
  const bound = typeof sync.accountBinding === "function" ? sync.accountBinding() : undefined;
  const current = currentUserStorage();
  if (!bound || !current || bound.userId !== current.userId || bound.issuer !== current.issuer) {
    throw new Error("供应商变更恢复必须绑定当前账号");
  }
  const database = resolveAccountDb();
  if (!database) {
    throw new Error("供应商变更恢复缺少账号库");
  }
  const mutations = await loadConvergedVendorOutbox(database);
  for (const mutation of mutations) {
    if (mutation.op === "upsert") {
      const row = await database("o_vendorConfig").where({ id: mutation.vendorId }).first();
      if (!row) {
        throw new Error("供应商变更无法恢复：本机供应商记录缺失");
      }
      const live = JSON.stringify({
        id: row.id,
        inputValues: parseJson(row.inputValues, {}),
        models: parseJson(row.models, []),
        enable: Number(row.enable ?? 0),
      });
      // 中文注释：先把权威 live pending 落盘，成功后才确认 outbox。
      sync.replaceVendorLogicalSnapshot(String(mutation.vendorId), live);
      await ensureVendorTombstoneTable(database);
      await clearVendorTombstone(database, String(mutation.vendorId));
      await confirmVendorOutbox(database, mutation.vendorId, mutation.sequence);
      continue;
    }
    sync.tombstoneVendorLogicalSnapshot(String(mutation.vendorId));
    await ensureVendorTombstoneTable(database);
    await writeVendorTombstone(database, String(mutation.vendorId));
    await confirmVendorOutbox(database, mutation.vendorId, mutation.sequence);
  }
}

/** 中文注释：只通知与 boundSync 账号完全匹配的消费方，切号不得替别人消费 outbox。 */
export async function afterVendorConfigWrite(_mutation?: VendorLogicalMutation): Promise<void> {
  const current = currentUserStorage();
  const bound = boundSync;
  if (!bound || !current) return;
  const account = typeof bound.accountBinding === "function" ? bound.accountBinding() : undefined;
  if (!account || account.userId !== current.userId || account.issuer !== current.issuer) return;
  await afterAccountSettingsWrite();
}

export type ProfileCollectionName = "vendor" | "prompt" | "model" | "agent" | "skill";

export interface LiveSettingsInventory {
  values: Record<string, string>;
  complete: Record<ProfileCollectionName, boolean>;
}

export async function recordLiveSettingsToProfile(sync: ProfileSync): Promise<void> {
  const capture = async () => {
    const database = resolveAccountDb();
    if (!database) {
      // 中文注释：没有账号库时禁止把空 live 当成“用户删除了全部集合”。
      return;
    }
    let inventory: LiveSettingsInventory;
    try {
      inventory = await captureLiveAccountInventory(database);
    } catch (error) {
      sync.reportFailure(error);
      throw error;
    }
    const values = inventory.values;
    const liveKeys = new Set(Object.keys(values));
    const liveVendorIds = new Set(
      Object.values(values)
        .map((value) => {
          const parsed = parseJson(value, {}) as { id?: unknown };
          return typeof parsed.id === "string" ? parsed.id : "";
        })
        .filter(Boolean),
    );
    dropRedundantVendorAliases(sync, liveVendorIds);
    const boundAccount = typeof sync.accountBinding === "function" ? sync.accountBinding() : undefined;
    const current = currentUserStorage();
    const sameAccount = Boolean(
      boundAccount
      && current
      && boundAccount.userId === current.userId
      && boundAccount.issuer === current.issuer,
    );
    // 中文注释：outbox 只能由与 ProfileSync.accountBinding 完全匹配的账号消费。
    const mutations = sameAccount ? await loadConvergedVendorOutbox(database) : [];
    const explicitUpserts = new Set(mutations.filter((item) => item.op === "upsert").map((item) => item.vendorId));
    const explicitDeletes = new Set(mutations.filter((item) => item.op === "delete").map((item) => item.vendorId));
    for (const mutation of mutations) {
      if (mutation.op === "upsert") {
        const live = values[authoritativeVendorKey(mutation.vendorId)];
        if (!live) continue;
        sync.replaceVendorLogicalSnapshot(mutation.vendorId, live);
        await ensureVendorTombstoneTable(database);
        await clearVendorTombstone(database, mutation.vendorId);
        await confirmVendorOutbox(database, mutation.vendorId, mutation.sequence);
        continue;
      }
      sync.tombstoneVendorLogicalSnapshot(mutation.vendorId);
      await ensureVendorTombstoneTable(database);
      await writeVendorTombstone(database, mutation.vendorId);
      await confirmVendorOutbox(database, mutation.vendorId, mutation.sequence);
    }
    for (const [key, value] of Object.entries(values)) {
      const registration = findProfileSyncRegistration(key);
      if (!registration) continue;
      if (isVendorSnapshotKey(key)) {
        const parsed = parseJson(value, {}) as { id?: unknown };
        const id = typeof parsed.id === "string" ? parsed.id : "";
        if (id && (explicitUpserts.has(id) || explicitDeletes.has(id))) continue;
        if (id && await vendorHasLogicalTombstone(sync, database, id)) {
          liveKeys.add(key);
          continue;
        }
      }
      sync.setPersistent(key, value, registration.sensitivity === "encrypted");
    }
    // 中文注释：旧客户端上传的未修改内置 Skill 必须显式 compact，禁止变成用户 tombstone。
    await compactLegacyUntouchedBuiltinSkills(sync);
    // 中文注释：只有完整可信的集合盘点才能推导用户删除。
    const trusted = COLLECTION_PREFIXES.filter((prefix) => {
      if (prefix === "vendorItem." || prefix === "vendor.") return inventory.complete.vendor;
      const name = prefix.slice(0, -1) as ProfileCollectionName;
      return inventory.complete[name] === true;
    });
    sync.forgetMissingCollectionKeys(liveKeys, trusted);
  };
  const account = typeof sync.accountBinding === "function" ? sync.accountBinding() : undefined;
  if (account) {
    const { prepareUserDatabase } = await import("@/utils/db");
    const { runWithUserStorage } = await import("../runtime/user-storage-context");
    await prepareUserDatabase(account);
    await runWithUserStorage(account, capture);
    return;
  }
  await capture();
}

function resolveAccountDb(db?: Knex): Knex | undefined {
  if (db) return db;
  try {
    return accountDatabase();
  } catch (error) {
    if (error instanceof Error && error.message.includes("缺少中央用户存储上下文")) return undefined;
    throw error;
  }
}

export async function captureLiveAccountSettings(db?: Knex): Promise<Record<string, string>> {
  return (await captureLiveAccountInventory(db)).values;
}

export async function captureLiveAccountInventory(db?: Knex): Promise<LiveSettingsInventory> {
  await recoverProfileApplyJournal();
  const database = resolveAccountDb(db);
  const complete: LiveSettingsInventory["complete"] = {
    vendor: false,
    prompt: false,
    model: false,
    agent: false,
    skill: false,
  };
  if (!database) return { values: {}, complete };
  db = database;
  const output: Record<string, string> = {};
  const vendors = await db("o_vendorConfig").select("id", "inputValues", "models", "enable");
  for (const row of vendors) {
    if (!row.id) continue;
    const vendorPayload = JSON.stringify({
      id: row.id,
      inputValues: parseJson(row.inputValues, {}),
      models: parseJson(row.models, []),
      enable: Number(row.enable ?? 0),
    });
    output[authoritativeVendorKey(String(row.id))] = vendorPayload;
  }

  const modelPrompts = await db("o_modelPrompt").select("vendorId", "model", "path", "fileName");
  for (const row of modelPrompts) {
    if (!row.vendorId || !row.model) continue;
    let content = "";
    try {
      if (row.path) {
        const file = resolveAccountModelPromptFile({ relativePath: String(row.path).replace(/\\/g, "/") });
        if (fs.existsSync(file)) content = fs.readFileSync(file, "utf8");
      }
    } catch {
      content = "";
    }
    output[`model.${row.vendorId}.${stableToken(row.model)}`] = JSON.stringify({
      vendorId: row.vendorId,
      model: row.model,
      path: row.path ?? "",
      fileName: row.fileName ?? "",
      content,
    });
  }

  const prompts = await db("o_prompt").select("id", "name", "type", "data", "useData");
  for (const row of prompts) {
    if (row.id == null) continue;
    output[`prompt.${row.id}`] = JSON.stringify({
      id: row.id,
      name: row.name ?? "",
      type: row.type ?? "",
      data: row.data ?? "",
      useData: row.useData ?? "",
    });
  }

  const agents = await db("o_agentDeploy").select(
    "key", "name", "desc", "vendorId", "model", "modelName", "disabled", "temperature", "maxOutputTokens",
  );
  for (const row of agents) {
    if (!row.key) continue;
    output[`agent.${String(row.key).replace(/[^a-zA-Z0-9._-]/g, "-")}`] = JSON.stringify({
      key: row.key,
      name: row.name ?? "",
      desc: row.desc ?? "",
      vendorId: row.vendorId,
      model: row.model,
      modelName: row.modelName,
      disabled: row.disabled,
      temperature: row.temperature,
      maxOutputTokens: row.maxOutputTokens,
    });
  }

  const settings = await db("o_setting").select("key", "value");
  for (const row of settings) {
    if (!row.key) continue;
    if (row.key === "theme" || row.key === "language") {
      output[row.key] = String(row.value ?? "");
      continue;
    }
    if ((MEMORY_SETTING_KEYS as readonly string[]).includes(row.key)) {
      output[row.key] = String(row.value ?? "");
    }
  }

  complete.vendor = true;
  complete.prompt = true;
  complete.model = true;
  complete.agent = true;
  try {
    await captureSkillFiles(output);
    complete.skill = true;
  } catch (error) {
    // 中文注释：Skill 盘点失败必须向上返回，禁止空盘点被当成用户删除。
    throw new Error(`Skill 盘点失败，禁止推断删除: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { values: output, complete };
}

async function compactLegacyUntouchedBuiltinSkills(sync: ProfileSync): Promise<void> {
  if (typeof sync.listStoredKeys !== "function" || typeof sync.dropSnapshotKey !== "function") return;
  const { resolveBuiltinSkillsResources } = await import("../skills/account-skills");
  const { loadBuiltinSkillsManifest } = await import("../skills/builtin-skill-installer");
  const resources = resolveBuiltinSkillsResources();
  const manifest = loadBuiltinSkillsManifest(resources.manifestPath);
  const builtinSha = new Map(
    manifest.files.map((item) => [item.path.replace(/\\/g, "/"), item.sha256.toLowerCase()]),
  );
  for (const key of sync.listStoredKeys()) {
    if (!key.startsWith("skill.")) continue;
    const parsed = parseJson(sync.readStored(key) ?? "", {}) as {
      path?: string;
      sha256?: string;
      content?: string;
      kind?: string;
    };
    const relative = String(parsed.path ?? "").replace(/\\/g, "/");
    const baseline = builtinSha.get(relative);
    const digest = String(parsed.sha256 ?? "").toLowerCase();
    if (!baseline || !digest || baseline !== digest) continue;
    sync.dropSnapshotKey(key);
  }
  sync.markSkillSyncSchema("2");
}

async function captureSkillFiles(output: Record<string, string>): Promise<void> {
  const { ensureCurrentAccountBuiltinSkills, resolveBuiltinSkillsResources } = await import("../skills/account-skills");
  const { hashFileSha256, loadBuiltinSkillsManifest } = await import("../skills/builtin-skill-installer");
  const { skillsRoot } = await ensureCurrentAccountBuiltinSkills(getPath());
  const resources = resolveBuiltinSkillsResources();
  const manifest = loadBuiltinSkillsManifest(resources.manifestPath);
  const builtinSha = new Map(
    manifest.files.map((item) => [item.path.replace(/\\/g, "/"), item.sha256.toLowerCase()]),
  );
  const walk = (dir: string, rel = ""): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, nextRel);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const stat = fs.statSync(full);
      if (stat.size > 256 * 1024) continue;
      const relative = nextRel.replace(/\\/g, "/");
      const digest = hashFileSha256(full).toLowerCase();
      const baseline = builtinSha.get(relative);
      // 中文注释：未修改的程序内置 Skill 不是用户数据，禁止进入 ProfileSync。
      if (baseline && baseline === digest) continue;
      output[`skill.${stableToken(relative)}`] = JSON.stringify({
        path: relative,
        fileName: entry.name,
        content: fs.readFileSync(full, "utf8"),
        kind: baseline ? "override" : "custom",
        sha256: digest,
      });
    }
  };
  if (fs.existsSync(skillsRoot)) walk(skillsRoot);
}

export async function applyLiveAccountSettings(
  values: Record<string, string>,
  db?: Knex,
): Promise<void> {
  const database = resolveAccountDb(db);
  if (!database) {
    if (Object.keys(values).length === 0) return;
    throw new Error("缺少中央用户存储上下文");
  }
  applying = true;
  try {
    const incomingVendors = new Set<string>();
    const incomingPrompts = new Set<number>();
    const incomingModels = new Set<string>();
    const incomingAgents = new Set<string>();
    const incomingSkills = new Set<string>();
    const deletedVendors = new Set<string>();
    const deletedPrompts = new Set<number>();
    const deletedModels = new Set<string>();
    const deletedAgents = new Set<string>();
    const deletedSkills = new Set<string>();
    const modelFilesToRemove = new Set<string>();
    const hasSkillWork = Object.keys(values).some((key) =>
      key.startsWith("skill.") || key.startsWith("deleted.skill."));
    let skillsRoot: string | undefined;
    let resolveSkillFile: typeof import("../skills/account-skills").resolveAccountSkillFile | undefined;
    if (hasSkillWork) {
      const skillsMod = await import("../skills/account-skills");
      const ensured = await skillsMod.ensureCurrentAccountBuiltinSkills(getPath());
      skillsRoot = ensured.skillsRoot;
      resolveSkillFile = skillsMod.resolveAccountSkillFile;
    }
    await recoverProfileApplyJournal();
    // 中文注释：先校验全部路径并写 staging，禁止在 SQLite 事务里覆盖正式文件。
    const operationId = crypto.randomUUID();
    const plannedWrites = planApplyFileWrites(values, skillsRoot, resolveSkillFile);
    const staged = stageApplyWrites(plannedWrites);
    const preparedJournal: ApplyJournal = {
      operationId,
      phase: "prepared",
      writes: staged,
      deletes: [],
    };
    writeApplyJournal(preparedJournal);
    try {
    const vendorDecisions = collectVendorApplyDecisions(values);
    await database.transaction(async (trx) => {
      await ensureVendorTombstoneTable(trx);
      for (const decision of vendorDecisions) {
        if (decision.delete) {
          deletedVendors.add(decision.id);
          await writeVendorTombstone(trx, decision.id);
          continue;
        }
        if (!decision.payload) continue;
        const existingTombstone = await trx(VENDOR_TOMBSTONE_TABLE).where({ id: decision.id }).first();
        if (existingTombstone && !decision.hasAuthoritativeLive) {
          // 中文注释：逻辑删除后只拒绝非权威别名复活，权威键无 tombstone 视为用户重建。
          continue;
        }
        incomingVendors.add(decision.id);
        await clearVendorTombstone(trx, decision.id);
        const exists = await trx("o_vendorConfig").where({ id: decision.id }).first();
        const row = {
          id: decision.id,
          inputValues: JSON.stringify(decision.payload.inputValues ?? {}),
          models: JSON.stringify(decision.payload.models ?? []),
          enable: Number(decision.payload.enable ?? 0),
        };
        if (exists) await trx("o_vendorConfig").where({ id: decision.id }).update(row);
        else await trx("o_vendorConfig").insert(row);
      }
      for (const [key, raw] of Object.entries(values)) {
        if (key === "theme" || key === "language" || (MEMORY_SETTING_KEYS as readonly string[]).includes(key)) {
          await upsertSetting(trx, key, raw);
          continue;
        }
        if (key.startsWith("dreamina.")) {
          continue;
        }
        if (isVendorSnapshotKey(key)) continue;
        if (key.startsWith("deleted.")) {
          collectDeletedMembership(key.slice("deleted.".length), raw, {
            vendors: deletedVendors,
            prompts: deletedPrompts,
            models: deletedModels,
            agents: deletedAgents,
            skills: deletedSkills,
            modelFiles: modelFilesToRemove,
          });
          continue;
        }
        if (key.startsWith("model.")) {
          const payload = parseJson(raw, {}) as {
            vendorId?: string;
            model?: string;
            path?: string;
            fileName?: string;
            content?: string;
            $tombstone?: boolean;
          };
          if (payload.$tombstone === true) {
            if (payload.vendorId && payload.model) deletedModels.add(`${payload.vendorId}\0${payload.model}`);
            if (payload.path) modelFilesToRemove.add(String(payload.path).replace(/\\/g, "/"));
            continue;
          }
          if (!payload.vendorId || !payload.model) continue;
          incomingModels.add(`${payload.vendorId}\0${payload.model}`);
          const rel = String(payload.path || `video/${payload.fileName || "prompt.md"}`).replace(/\\/g, "/");
          const exists = await trx("o_modelPrompt")
            .where({ vendorId: payload.vendorId, model: payload.model })
            .first();
          const row = {
            vendorId: payload.vendorId,
            model: payload.model,
            path: rel,
            fileName: payload.fileName ?? path.posix.basename(rel),
          };
          if (exists) {
            await trx("o_modelPrompt").where({ vendorId: payload.vendorId, model: payload.model }).update(row);
          } else {
            await trx("o_modelPrompt").insert(row);
          }
          continue;
        }
        if (key.startsWith("prompt.")) {
          const payload = parseJson(raw, {}) as {
            id?: number;
            name?: string;
            type?: string;
            data?: string;
            useData?: string;
            $tombstone?: boolean;
          };
          if (payload.$tombstone === true) {
            if (payload.id != null) deletedPrompts.add(Number(payload.id));
            continue;
          }
          if (payload.id == null) continue;
          incomingPrompts.add(Number(payload.id));
          const exists = await trx("o_prompt").where({ id: payload.id }).first();
          if (exists) {
            await trx("o_prompt").where({ id: payload.id }).update({
              name: payload.name,
              type: payload.type,
              data: payload.data,
              useData: payload.useData,
            });
          } else {
            await trx("o_prompt").insert({
              id: payload.id,
              name: payload.name,
              type: payload.type,
              data: payload.data,
              useData: payload.useData,
            });
          }
          continue;
        }
        if (key.startsWith("agent.")) {
          const payload = parseJson(raw, {}) as {
            key?: string;
            vendorId?: string | null;
            model?: string | null;
            modelName?: string | null;
            name?: string | null;
            desc?: string | null;
            disabled?: boolean | number | null;
            temperature?: number | null;
            maxOutputTokens?: number | null;
            $tombstone?: boolean;
          };
          if (payload.$tombstone === true) {
            if (payload.key) deletedAgents.add(payload.key);
            continue;
          }
          if (!payload.key) continue;
          incomingAgents.add(payload.key);
          const row = {
            name: payload.name ?? payload.key,
            desc: payload.desc ?? "",
            vendorId: payload.vendorId,
            model: payload.model,
            modelName: payload.modelName,
            disabled: payload.disabled,
            temperature: payload.temperature,
            maxOutputTokens: payload.maxOutputTokens,
          };
          const exists = await trx("o_agentDeploy").where({ key: payload.key }).first();
          if (exists) {
            await trx("o_agentDeploy").where({ key: payload.key }).update(row);
          } else {
            const maxId = await trx("o_agentDeploy").max<{ maxId: number | null }>("id as maxId").first();
            await trx("o_agentDeploy").insert({
              id: Number(maxId?.maxId ?? 0) + 1,
              key: payload.key,
              ...row,
            });
          }
          continue;
        }
        if (key.startsWith("skill.")) {
          const payload = parseJson(raw, {}) as {
            path?: string;
            fileName?: string;
            content?: string;
            $tombstone?: boolean;
          };
          if (payload.$tombstone === true) {
            if (payload.path) deletedSkills.add(payload.path.replace(/\\/g, "/"));
            continue;
          }
          if (!payload.path || typeof payload.content !== "string") continue;
          incomingSkills.add(payload.path.replace(/\\/g, "/"));
          continue;
        }
        if (key.startsWith("memory.")) {
          const payloadKey = key.slice("memory.".length);
          const settingKey = payloadKey.includes("-") ? payloadKey.replace(/-/g, "") : payloadKey;
          const source = parseJson(raw, raw);
          const liveKey = typeof source === "object" && source && "key" in source
            ? String((source as { key: string }).key)
            : settingKey;
          await upsertSetting(trx, liveKey, typeof source === "string" ? source : raw);
        }
      }
      // 中文注释：只能按显式 tombstone 删除集合成员，禁止用「快照缺席」剪掉未观察到的行。
      for (const id of deletedVendors) {
        await trx("o_vendorConfig").where({ id }).del();
      }
      for (const id of deletedPrompts) {
        await trx("o_prompt").where({ id }).del();
      }
      if (deletedModels.size > 0) {
        const rows = await trx("o_modelPrompt").select("vendorId", "model", "path");
        for (const row of rows) {
          const member = `${row.vendorId}\0${row.model}`;
          if (!deletedModels.has(member)) continue;
          if (row.path) modelFilesToRemove.add(String(row.path).replace(/\\/g, "/"));
          await trx("o_modelPrompt").where({ vendorId: row.vendorId, model: row.model }).del();
        }
      }
      for (const key of deletedAgents) {
        await trx("o_agentDeploy").where({ key }).del();
      }
      const committedJournal: ApplyJournal = {
        operationId,
        phase: "db-committed",
        writes: staged,
        deletes: [...modelFilesToRemove],
      };
      await writeApplyMarker(trx, committedJournal);
    });
    } catch (error) {
      discardStagedWrites(staged);
      await clearApplyMarker(database).catch(() => undefined);
      clearApplyJournal();
      throw error;
    }
    const committedJournal: ApplyJournal = {
      operationId,
      phase: "db-committed",
      writes: staged,
      deletes: [...modelFilesToRemove],
    };
    writeApplyJournal(committedJournal);
    await finalizeCommittedApply(committedJournal);
    if (deletedSkills.size > 0) {
      await applySkillTombstones(deletedSkills, skillsRoot);
    }
    bumpModelCatalogVersion("profile-apply");
  } finally {
    applying = false;
  }
}

async function applySkillTombstones(deletedSkills: Set<string>, preparedRoot?: string): Promise<void> {
  const skillsMod = await import("../skills/account-skills");
  const { loadBuiltinSkillsManifest } = await import("../skills/builtin-skill-installer");
  const skillsRoot = preparedRoot
    ?? (await skillsMod.ensureCurrentAccountBuiltinSkills(getPath())).skillsRoot;
  const resources = skillsMod.resolveBuiltinSkillsResources();
  const manifest = loadBuiltinSkillsManifest(resources.manifestPath);
  const builtin = new Map(manifest.files.map((item) => [item.path.replace(/\\/g, "/"), item]));
  for (const relative of deletedSkills) {
    const file = skillsMod.resolveAccountSkillFile(skillsRoot, relative, { mustExist: false });
    const baseline = builtin.get(relative);
    if (baseline) {
      const source = path.join(resources.builtinRoot, ...relative.split("/"));
      if (!fs.existsSync(source)) throw new Error(`内置 Skill 基线缺失，无法恢复：${relative}`);
      atomicReplaceTextFile(file, fs.readFileSync(source, "utf8"));
      continue;
    }
    if (fs.existsSync(file)) fs.rmSync(file);
  }
}

async function upsertSetting(db: Knex, key: string, value: string): Promise<void> {
  const exists = await db("o_setting").where({ key }).first();
  if (exists) await db("o_setting").where({ key }).update({ value });
  else await db("o_setting").insert({ key, value });
}

const VENDOR_TOMBSTONE_TABLE = "o_profileVendorTombstone";
const SAFE_VENDOR_KEY_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const VENDOR_ITEM_TOKEN_RE = /^[0-9a-f]{16}$/;
const MAX_VENDOR_COLLECTION_ID_LENGTH = 64;

interface VendorApplyDecision {
  id: string;
  delete: boolean;
  hasAuthoritativeLive: boolean;
  payload?: {
    inputValues: unknown;
    models: unknown;
    enable: number;
  };
}

interface VendorApplyGroup {
  id: string;
  lives: Array<{ key: string; normalized: string; payload: NonNullable<VendorApplyDecision["payload"]> }>;
  tombstones: string[];
}

function vendorItemKey(id: string): string {
  return `vendorItem.${stableToken(id)}`;
}

export function authoritativeVendorKey(id: string): string {
  return SAFE_VENDOR_KEY_ID_RE.test(id) ? `vendor.${id}` : vendorItemKey(id);
}

export function listVendorKeyAliases(id: string): {
  authoritative: string;
  live: string[];
  deleted: string[];
} {
  const authoritative = authoritativeVendorKey(id);
  const live = [...new Set([authoritative, vendorItemKey(id), `vendor.${id}`])];
  return {
    authoritative,
    live,
    deleted: live.map((key) => `deleted.${key}`),
  };
}

async function vendorHasLogicalTombstone(
  sync: ProfileSync,
  db: Knex,
  id: string,
): Promise<boolean> {
  const aliases = listVendorKeyAliases(id);
  for (const key of aliases.deleted) {
    if (sync.listStoredKeys().includes(key) || sync.readStored(key)) return true;
  }
  for (const key of sync.listStoredKeys()) {
    if (!key.startsWith("deleted.vendor")) continue;
    const parsed = parseJson(sync.readStored(key) ?? "", {}) as { id?: unknown };
    if (parsed.id === id) return true;
  }
  if (!await db.schema.hasTable(VENDOR_TOMBSTONE_TABLE)) return false;
  return Boolean(await db(VENDOR_TOMBSTONE_TABLE).where({ id }).first());
}

function isVendorSnapshotKey(key: string): boolean {
  const live = key.startsWith("deleted.") ? key.slice("deleted.".length) : key;
  return live.startsWith("vendorItem.") || live.startsWith("vendor.");
}

function dropRedundantVendorAliases(sync: ProfileSync, liveVendorIds: Set<string>): void {
  if (typeof sync.listStoredKeys !== "function" || typeof sync.readStored !== "function") return;
  if (typeof sync.dropSnapshotKey !== "function") return;
  for (const key of sync.listStoredKeys()) {
    if (key.startsWith("deleted.") || !isVendorSnapshotKey(key)) continue;
    const raw = sync.readStored(key) ?? "";
    const parsed = parseJson(raw, {}) as { id?: unknown };
    const id = inspectVendorCollectionId(key, parsed, raw);
    if (!id || !liveVendorIds.has(id)) continue;
    if (key === authoritativeVendorKey(id)) continue;
    // 中文注释：去掉历史双键别名只删快照键，禁止写成用户删除 tombstone。
    sync.dropSnapshotKey(key);
  }
}

function isVendorCollectionValue(raw: string): boolean {
  const parsed = parseJson(raw, null);
  return Boolean(
    parsed
    && typeof parsed === "object"
    && !Array.isArray(parsed)
    && ("inputValues" in parsed || "models" in parsed || "enable" in parsed || "id" in parsed),
  );
}

function assertVendorCollectionId(id: string): string {
  const value = id.trim();
  if (!value) throw new Error("供应商 id 无效");
  if (value.length > MAX_VENDOR_COLLECTION_ID_LENGTH) throw new Error("供应商 id 过长");
  if (
    value.includes(":")
    || value.includes("/")
    || value.includes("\\")
    || value.includes("..")
    || /[\u0000-\u001f]/.test(value)
    || /\s/.test(value)
  ) {
    throw new Error("供应商 id 非法");
  }
  return value;
}

function inspectVendorCollectionId(
  key: string,
  parsed: { id?: unknown },
  raw: string,
): string | undefined {
  try {
    return resolveVendorCollectionId(key, parsed, raw, false);
  } catch {
    return undefined;
  }
}

function resolveVendorCollectionId(
  key: string,
  parsed: { id?: unknown },
  raw: string,
  failClosed = true,
): string | undefined {
  const liveKey = key.startsWith("deleted.") ? key.slice("deleted.".length) : key;
  if (liveKey.startsWith("vendorItem.")) {
    const token = liveKey.slice("vendorItem.".length);
    if (!VENDOR_ITEM_TOKEN_RE.test(token)) {
      if (failClosed) throw new Error("供应商 vendorItem token 非法");
      return undefined;
    }
    if (typeof parsed.id !== "string" || !parsed.id.trim()) {
      if (failClosed) throw new Error("供应商 vendorItem 缺少有效 id");
      return undefined;
    }
    const id = assertVendorCollectionId(parsed.id);
    if (token !== stableToken(id)) {
      if (failClosed) throw new Error("供应商 vendorItem token 与 payload.id 摘要不匹配");
      return undefined;
    }
    return id;
  }
  if (!liveKey.startsWith("vendor.")) return undefined;
  const suffix = liveKey.slice("vendor.".length);
  if (typeof parsed.id === "string") {
    if (!parsed.id.trim()) {
      if (failClosed && (isVendorCollectionValue(raw) || isTombstoneValue(raw))) {
        throw new Error("供应商 id 无效");
      }
      return undefined;
    }
    const id = assertVendorCollectionId(parsed.id);
    if (id !== suffix) {
      if (failClosed) throw new Error("供应商键与 payload.id 不匹配");
      return undefined;
    }
    return id;
  }
  if (!isVendorCollectionValue(raw) && !isTombstoneValue(raw)) return undefined;
  const rest = liveKey.slice("vendor.".length);
  if (!rest || rest.includes(":") || rest.includes(".")) return undefined;
  return assertVendorCollectionId(rest);
}

function canonicalizeVendorJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalizeVendorJson(item));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      next[key] = canonicalizeVendorJson(record[key]);
    }
    return next;
  }
  return value;
}

function normalizeVendorPayload(parsed: {
  inputValues?: unknown;
  models?: unknown;
  enable?: unknown;
}): NonNullable<VendorApplyDecision["payload"]> {
  return {
    inputValues: parsed.inputValues ?? {},
    models: parsed.models ?? [],
    enable: Number(parsed.enable ?? 0),
  };
}

function collectVendorApplyDecisions(values: Record<string, string>): VendorApplyDecision[] {
  const groups = new Map<string, VendorApplyGroup>();
  const remember = (id: string): VendorApplyGroup => {
    const existing = groups.get(id);
    if (existing) return existing;
    const created: VendorApplyGroup = { id, lives: [], tombstones: [] };
    groups.set(id, created);
    return created;
  };
  for (const [key, raw] of Object.entries(values)) {
    if (!isVendorSnapshotKey(key)) continue;
    const liveKey = key.startsWith("deleted.") ? key.slice("deleted.".length) : key;
    const parsed = parseJson(raw, {}) as {
      id?: unknown;
      inputValues?: unknown;
      models?: unknown;
      enable?: unknown;
      $tombstone?: boolean;
    };
    const isTombstoneKey = key.startsWith("deleted.") || isTombstoneValue(raw) || parsed.$tombstone === true;
    const id = isTombstoneKey
      ? inspectVendorCollectionId(liveKey, parsed, raw)
      : resolveVendorCollectionId(liveKey, parsed, raw, true);
    if (!id) continue;
    const group = remember(id);
    if (isTombstoneKey) {
      group.tombstones.push(key);
      continue;
    }
    const payload = normalizeVendorPayload(parsed);
    group.lives.push({
      key: liveKey,
      normalized: JSON.stringify(canonicalizeVendorJson({ id, ...payload })),
      payload,
    });
  }
  const decisions: VendorApplyDecision[] = [];
  for (const group of groups.values()) {
    const distinct = [...new Set(group.lives.map((item) => item.normalized))];
    if (distinct.length > 1) {
      const keys = group.lives.map((item) => item.key).sort().join(",");
      throw new Error(`供应商 ${group.id} 存在冲突的双表示，已拒绝按遍历顺序覆盖 keys=${keys}`);
    }
    decisions.push({
      id: group.id,
      delete: group.tombstones.length > 0,
      hasAuthoritativeLive: group.lives.some((item) => item.key === authoritativeVendorKey(group.id)),
      payload: group.lives[0]?.payload,
    });
  }
  return decisions;
}

async function ensureVendorTombstoneTable(db: Knex): Promise<void> {
  await db.raw(`
    CREATE TABLE IF NOT EXISTS ${VENDOR_TOMBSTONE_TABLE} (
      id TEXT PRIMARY KEY,
      updatedAt TEXT NOT NULL
    )
  `);
}

async function writeVendorTombstone(db: Knex, id: string): Promise<void> {
  await db(VENDOR_TOMBSTONE_TABLE).where({ id }).del();
  await db(VENDOR_TOMBSTONE_TABLE).insert({
    id,
    updatedAt: new Date().toISOString(),
  });
}

async function clearVendorTombstone(db: Knex, id: string): Promise<void> {
  await db(VENDOR_TOMBSTONE_TABLE).where({ id }).del();
}

function isTombstoneValue(raw: string): boolean {
  const parsed = parseJson(raw, null);
  return Boolean(parsed && typeof parsed === "object" && (parsed as { $tombstone?: unknown }).$tombstone === true);
}

function collectDeletedMembership(
  originalKey: string,
  raw: string,
  buckets: {
    vendors: Set<string>;
    prompts: Set<number>;
    models: Set<string>;
    agents: Set<string>;
    skills: Set<string>;
    modelFiles: Set<string>;
  },
): void {
  const payload = parseJson(raw, {}) as {
    id?: string | number;
    key?: string;
    vendorId?: string;
    model?: string;
    path?: string;
  };
  if (originalKey.startsWith("vendorItem.") || originalKey.startsWith("vendor.")) {
    const id = inspectVendorCollectionId(originalKey, payload, raw);
    if (id) buckets.vendors.add(id);
    return;
  }
  if (originalKey.startsWith("prompt.")) {
    const id = payload.id != null ? Number(payload.id) : Number(originalKey.slice("prompt.".length));
    if (Number.isFinite(id)) buckets.prompts.add(id);
    return;
  }
  if (originalKey.startsWith("model.")) {
    if (payload.vendorId && payload.model) buckets.models.add(`${payload.vendorId}\0${payload.model}`);
    if (payload.path) buckets.modelFiles.add(String(payload.path).replace(/\\/g, "/"));
    return;
  }
  if (originalKey.startsWith("agent.")) {
    buckets.agents.add(typeof payload.key === "string" ? payload.key : originalKey.slice("agent.".length));
    return;
  }
  if (originalKey.startsWith("skill.") && payload.path) {
    buckets.skills.add(String(payload.path).replace(/\\/g, "/"));
  }
}

interface PlannedFileWrite {
  target: string;
  content: string;
}

interface StagedFileWrite {
  target: string;
  staging: string;
  sha256: string;
  size: number;
}

export interface ApplyJournal {
  operationId: string;
  phase: "prepared" | "staging" | "db-committed";
  writes: StagedFileWrite[];
  deletes: string[];
}

const APPLY_MARKER_TABLE = "o_profileApplyMarker";

function planApplyFileWrites(
  values: Record<string, string>,
  skillsRoot: string | undefined,
  resolveSkillFile: typeof import("../skills/account-skills").resolveAccountSkillFile | undefined,
): PlannedFileWrite[] {
  const planned: PlannedFileWrite[] = [];
  for (const [key, raw] of Object.entries(values)) {
    if (key.startsWith("model.")) {
      const payload = parseJson(raw, {}) as {
        vendorId?: string;
        model?: string;
        path?: string;
        fileName?: string;
        content?: string;
        $tombstone?: boolean;
      };
      if (payload.$tombstone === true || !payload.vendorId || !payload.model) continue;
      if (typeof payload.content !== "string") continue;
      const rel = String(payload.path || `video/${payload.fileName || "prompt.md"}`).replace(/\\/g, "/");
      planned.push({
        target: resolveAccountModelPromptFile({ relativePath: rel }),
        content: payload.content,
      });
      continue;
    }
    if (key.startsWith("skill.")) {
      const payload = parseJson(raw, {}) as {
        path?: string;
        content?: string;
        $tombstone?: boolean;
      };
      if (payload.$tombstone === true || !payload.path || typeof payload.content !== "string") continue;
      if (!skillsRoot || !resolveSkillFile) throw new Error("账号 Skills 根未准备");
      planned.push({
        target: resolveSkillFile(skillsRoot, payload.path, { mustExist: false }),
        content: payload.content,
      });
    }
  }
  return planned;
}

function stageApplyWrites(planned: PlannedFileWrite[]): StagedFileWrite[] {
  return planned.map((item, index) => {
    fs.mkdirSync(path.dirname(item.target), { recursive: true });
    const staging = `${item.target}.${process.pid}.${index}.staging`;
    fs.writeFileSync(staging, item.content, "utf8");
    const digest = hashFileSha256Sync(staging);
    return {
      target: item.target,
      staging,
      sha256: digest,
      size: fs.statSync(staging).size,
    };
  });
}

function discardStagedWrites(writes: StagedFileWrite[]): void {
  for (const item of writes) {
    if (fs.existsSync(item.staging)) fs.rmSync(item.staging, { force: true });
  }
}

function applyJournalPath(): string {
  const identity = currentUserStorage();
  if (!identity) throw new Error("缺少中央用户存储上下文");
  return path.join(userStorageRoot(getPath(), identity), "profile-apply-journal.json");
}

function writeApplyJournal(journal: ApplyJournal): void {
  const file = applyJournalPath();
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(journal), "utf8");
  fs.renameSync(temporary, file);
}

function clearApplyJournal(): void {
  const file = applyJournalPath();
  if (fs.existsSync(file)) fs.rmSync(file, { force: true });
}

async function ensureApplyMarkerTable(db: Knex): Promise<void> {
  await db.raw(`
    CREATE TABLE IF NOT EXISTS ${APPLY_MARKER_TABLE} (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      operationId TEXT NOT NULL,
      phase TEXT NOT NULL,
      journalJson TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `);
}

async function writeApplyMarker(db: Knex, journal: ApplyJournal): Promise<void> {
  await ensureApplyMarkerTable(db);
  await db(APPLY_MARKER_TABLE).where({ id: 1 }).del();
  await db(APPLY_MARKER_TABLE).insert({
    id: 1,
    operationId: journal.operationId,
    phase: journal.phase,
    journalJson: JSON.stringify(journal),
    updatedAt: new Date().toISOString(),
  });
}

async function readApplyMarker(): Promise<ApplyJournal | undefined> {
  const database = resolveAccountDb();
  if (!database) return undefined;
  if (!await database.schema.hasTable(APPLY_MARKER_TABLE)) return undefined;
  const row = await database(APPLY_MARKER_TABLE).where({ id: 1 }).first();
  if (!row?.journalJson) return undefined;
  const parsed = parseJson(String(row.journalJson), null) as ApplyJournal | null;
  return parsed && Array.isArray(parsed.writes) ? parsed : undefined;
}

async function clearApplyMarker(db?: Knex): Promise<void> {
  const database = db ?? resolveAccountDb();
  if (!database || !await database.schema.hasTable(APPLY_MARKER_TABLE)) return;
  await database(APPLY_MARKER_TABLE).where({ id: 1 }).del();
}

function hashFileSha256Sync(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function fileMatchesExpectation(file: string, sha256: string | undefined, size: number | undefined): boolean {
  if (!fs.existsSync(file) || !sha256 || !Number.isInteger(size)) return false;
  const stat = fs.statSync(file);
  if (stat.size !== size) return false;
  return hashFileSha256Sync(file) === sha256;
}

function promoteOneWrite(item: StagedFileWrite): void {
  const expectedSha = item.sha256;
  const expectedSize = item.size;
  if (fs.existsSync(item.staging)) {
    if (!fileMatchesExpectation(item.staging, expectedSha, expectedSize)) {
      throw new Error("apply staging 校验失败，禁止提升");
    }
    try {
      fs.renameSync(item.staging, item.target);
    } catch (error) {
      // 中文注释：不能原子替换时必须保留 staging/journal 并失败，禁止 copy 覆盖正式文件。
      throw new Error(
        `正式文件无法原子替换，已保留 staging：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!fileMatchesExpectation(item.target, expectedSha, expectedSize)) {
      throw new Error("apply 提升后 target 校验失败");
    }
    return;
  }
  if (fileMatchesExpectation(item.target, expectedSha, expectedSize)) return;
  throw new Error("apply 恢复失败：staging 缺失且 target 不匹配");
}

async function finalizeCommittedApply(journal: ApplyJournal): Promise<void> {
  for (const item of journal.writes) {
    promoteOneWrite(item);
  }
  for (const relative of journal.deletes ?? []) {
    unlinkAccountModelPromptFile(relative);
  }
  const database = resolveAccountDb();
  if (database) await clearApplyMarker(database);
  clearApplyJournal();
}

/** 中文注释：账号设置被当作有效状态读取前必须先恢复未完成的 apply。 */
export async function recoverProfileApplyJournal(): Promise<void> {
  let file: string | undefined;
  try {
    file = applyJournalPath();
  } catch {
    file = undefined;
  }
  const fileJournal = file && fs.existsSync(file)
    ? parseJson(fs.readFileSync(file, "utf8"), null) as ApplyJournal | null
    : null;
  const markerJournal = await readApplyMarker();
  const committed = markerJournal?.phase === "db-committed"
    || fileJournal?.phase === "db-committed";
  const journal = (committed ? (markerJournal ?? fileJournal) : fileJournal) as ApplyJournal | null;
  if (!journal || !Array.isArray(journal.writes)) {
    if (file && fs.existsSync(file) && !committed) clearApplyJournal();
    return;
  }
  if (!committed) {
    discardStagedWrites(journal.writes);
    await clearApplyMarker().catch(() => undefined);
    clearApplyJournal();
    return;
  }
  await finalizeCommittedApply({ ...journal, phase: "db-committed" });
}

function atomicReplaceTextFile(target: string, content: string): void {
  const staged = stageApplyWrites([{ target, content }]);
  for (const item of staged) promoteOneWrite(item);
}

function unlinkAccountModelPromptFile(relativePath: string): void {
  const file = resolveAccountModelPromptFile({ relativePath: relativePath.replace(/\\/g, "/") });
  if (fs.existsSync(file)) fs.rmSync(file);
}

function parseJson(value: unknown, fallback: unknown): unknown {
  if (typeof value !== "string") return value ?? fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stableToken(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}
