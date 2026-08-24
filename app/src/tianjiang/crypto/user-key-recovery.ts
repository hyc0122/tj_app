import crypto from "node:crypto";

import type { CentralSession } from "../auth/central-session";
import { isKeyServiceUnavailableError } from "../auth/key-service-error";
import { API_CONTRACT, buildAPIPath } from "../contracts";
import {
  CredentialDecryptionError,
  unreadableBackupKey,
  type CredentialStore,
} from "./credential-store";

interface BusinessGateway {
  forwardBusinessRequest(
    session: CentralSession,
    pathname: string,
    method: string,
    body?: unknown,
  ): Promise<unknown>;
}

interface RecoveryChallenge {
  challengeId: string;
  challenge: string;
  signingPayload: string;
  expiresAt: string;
}

interface RecoveryResult {
  deviceCiphertext: string;
  binding: string;
  keyVersion: string;
}

export interface DeviceRecoveryIdentity {
  publicKey: string;
  publicFingerprint: string;
  /** 本次是否因不可读密文而轮换了设备恢复密钥对 */
  rotated: boolean;
}

/** 安全中文：中央恢复失败，禁止附带原始异常。 */
export const PROFILE_KEY_RECOVERY_FAILED_MESSAGE =
  "个人配置密钥恢复失败，请检查网络后重新登录；已保留本地备份密文";

export class UserKeyRecoveryClient {
  constructor(
    private readonly gateway: BusinessGateway,
    private readonly session: CentralSession,
    private readonly deviceUUID: string,
    private readonly credentials: CredentialStore,
  ) {
    if (!isUUID(deviceUUID)) throw new Error("设备 UUID 无效");
  }

  /**
   * 读取或生成设备恢复密钥对。
   * 公私钥不可解密时：备份不可读密文 → 生成新密钥对覆盖原键 → 调用方须 registerDevice。
   * 幂等：备份键已存在时不重复写入备份；已可读的新密钥直接复用。
   */
  deviceIdentity(): DeviceRecoveryIdentity {
    const publicName = `device-recovery-public:${this.deviceUUID}`;
    const privateName = `device-recovery-private:${this.deviceUUID}`;

    let publicKey = this.tryGet(publicName);
    let privateKey = this.tryGet(privateName);
    let rotated = false;

    if (publicKey.status === "undecryptable") {
      this.backupUnreadable(publicName);
      rotated = true;
    }
    if (privateKey.status === "undecryptable") {
      this.backupUnreadable(privateName);
      rotated = true;
    }

    if (
      !rotated
      && publicKey.status === "ok"
      && privateKey.status === "ok"
      && publicKey.value
      && privateKey.value
    ) {
      return this.toIdentity(publicKey.value, false);
    }

    // 缺失或不可读：生成新密钥对（覆盖原键，备份已在上面保留）
    const generated = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    // 私钥由 Electron safeStorage 加密后落盘；普通配置、SQLite 和 renderer 均不可访问。
    this.credentials.set(privateName, generated.privateKey);
    this.credentials.set(publicName, generated.publicKey);
    return this.toIdentity(generated.publicKey, rotated || publicKey.status !== "ok" || privateKey.status !== "ok");
  }

  /**
   * 加载或从中央恢复 32 字节 profile key。
   * - 本机可读：直接返回，不访问中央。
   * - 本机不可读：备份密文后走中央 challenge/recover，禁止新建随机 profile key。
   * - 中央失败：不覆盖 unreadable-backup，抛安全中文错误。
   */
  async loadOrRecover(userUUID: string): Promise<Buffer> {
    if (!isUUID(userUUID)) throw new Error("用户 UUID 无效");
    const credentialName = `profile-key:${userUUID}`;

    const local = this.tryGet(credentialName);
    if (local.status === "ok" && local.value) {
      return decodeDataKey(local.value);
    }
    if (local.status === "undecryptable") {
      this.backupUnreadable(credentialName);
    }

    try {
      return await this.recoverFromCentral(userUUID, credentialName);
    } catch (error) {
      // 中央失败不得删除/覆盖备份键
      // 中文注释：密钥服务暂不可用是登录协调器的可降级信号，必须保留错误码与可重试语义。
      if (isKeyServiceUnavailableError(error)) {
        throw error;
      }
      if (error instanceof Error && error.message === PROFILE_KEY_RECOVERY_FAILED_MESSAGE) {
        throw error;
      }
      throw new Error(PROFILE_KEY_RECOVERY_FAILED_MESSAGE);
    }
  }

  private async recoverFromCentral(userUUID: string, credentialName: string): Promise<Buffer> {
    const identity = this.deviceIdentity();
    const challenge = asChallenge(await this.gateway.forwardBusinessRequest(
      this.session,
      contractEndpointPath("issueUserKeyChallenge"),
      "POST",
      {
        deviceUuid: this.deviceUUID,
        // 服务端登记阶段已保存同一公钥；携带此字段便于受控测试核对，不作为授权依据。
        recoveryPublicKey: identity.publicKey,
      },
    ));
    const expectedPayload = [
      "tj-key-recovery:v1",
      challenge.challengeId,
      challenge.challenge,
      String(this.session.user.id),
      this.deviceUUID,
    ].join(":");
    if (challenge.signingPayload !== expectedPayload || Date.parse(challenge.expiresAt) <= Date.now()) {
      throw new Error(PROFILE_KEY_RECOVERY_FAILED_MESSAGE);
    }
    const privateKey = this.tryGet(`device-recovery-private:${this.deviceUUID}`);
    if (privateKey.status !== "ok" || !privateKey.value) {
      throw new Error(PROFILE_KEY_RECOVERY_FAILED_MESSAGE);
    }
    const signature = crypto.sign("sha256", Buffer.from(challenge.signingPayload, "utf8"), {
      key: privateKey.value,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    }).toString("base64url");
    const recovered = asRecoveryResult(await this.gateway.forwardBusinessRequest(
      this.session,
      contractEndpointPath("recoverUserDataKey"),
      "POST",
      {
        deviceUuid: this.deviceUUID,
        challengeId: challenge.challengeId,
        challenge: challenge.challenge,
        signature,
      },
    ));
    const expectedBinding = `tj-device-key:v1:${this.session.user.id}:${this.deviceUUID}`;
    if (recovered.binding !== expectedBinding) {
      throw new Error(PROFILE_KEY_RECOVERY_FAILED_MESSAGE);
    }
    let dataKey: Buffer;
    try {
      dataKey = crypto.privateDecrypt({
        key: privateKey.value,
        oaepHash: "sha256",
        oaepLabel: Buffer.from(expectedBinding, "utf8"),
      }, Buffer.from(recovered.deviceCiphertext, "base64url"));
    } catch {
      throw new Error(PROFILE_KEY_RECOVERY_FAILED_MESSAGE);
    }
    if (dataKey.length !== 32) throw new Error(PROFILE_KEY_RECOVERY_FAILED_MESSAGE);
    // 仅在成功后写入新密文；备份键保持不动
    this.credentials.set(credentialName, dataKey.toString("base64url"));
    return dataKey;
  }

  private tryGet(name: string): { status: "ok" | "missing" | "undecryptable"; value?: string } {
    try {
      const value = this.credentials.get(name);
      if (value === undefined) return { status: "missing" };
      return { status: "ok", value };
    } catch (error) {
      if (error instanceof CredentialDecryptionError) {
        return { status: "undecryptable" };
      }
      throw error;
    }
  }

  private backupUnreadable(name: string): void {
    const backup = unreadableBackupKey(name);
    if (this.credentials.has(backup)) return;
    this.credentials.backupUnreadableCiphertext(name);
  }

  private toIdentity(publicKey: string, rotated: boolean): DeviceRecoveryIdentity {
    const publicDER = crypto.createPublicKey(publicKey).export({ type: "spki", format: "der" });
    return {
      publicKey,
      publicFingerprint: crypto.createHash("sha256").update(publicDER).digest("base64url"),
      rotated,
    };
  }
}

function contractEndpointPath(
  name: "issueUserKeyChallenge" | "recoverUserDataKey",
): string {
  const endpoint = API_CONTRACT.endpoints[name];
  if (endpoint.method !== "POST" || !endpoint.path.startsWith("/profile-key/")) {
    throw new Error("个人密钥公共契约无效");
  }
  return buildAPIPath(name);
}

function asChallenge(value: unknown): RecoveryChallenge {
  const item = asRecord(value);
  return {
    challengeId: requiredString(item.challengeId),
    challenge: requiredString(item.challenge),
    signingPayload: requiredString(item.signingPayload),
    expiresAt: requiredString(item.expiresAt),
  };
}

function asRecoveryResult(value: unknown): RecoveryResult {
  const item = asRecord(value);
  return {
    deviceCiphertext: requiredString(item.deviceCiphertext),
    binding: requiredString(item.binding),
    keyVersion: requiredString(item.keyVersion),
  };
}

function decodeDataKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== encoded) {
    throw new Error("本机个人配置密钥损坏");
  }
  return key;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredString(value: unknown): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(PROFILE_KEY_RECOVERY_FAILED_MESSAGE);
}

function isUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
