import crypto from "node:crypto";

const PROFILE_PREFIX = "tj-profile:v1:";
const WRAPPED_KEY_PREFIX = "tj-data-key:v1:";

export class ProfileCrypto {
  constructor(
    private readonly userUUID: string,
    private readonly dataKey: Buffer,
  ) {
    if (!isUUID(userUUID) || dataKey.length !== 32) {
      throw new Error("个人配置加密参数无效");
    }
  }

  encrypt(plain: string): string {
    return PROFILE_PREFIX + seal(Buffer.from(plain, "utf8"), this.dataKey, profileAAD(this.userUUID));
  }

  decrypt(encoded: string): string {
    if (!encoded.startsWith(PROFILE_PREFIX)) throw new Error("个人配置密文版本无效");
    try {
      return open(encoded.slice(PROFILE_PREFIX.length), this.dataKey, profileAAD(this.userUUID)).toString("utf8");
    } catch {
      throw new Error("个人配置密文认证失败");
    }
  }
}

export function wrapUserDataKey(userUUID: string, dataKey: Buffer, platformWrappingKey: Buffer): string {
  if (!isUUID(userUUID) || dataKey.length !== 32 || platformWrappingKey.length !== 32) {
    throw new Error("用户数据密钥包装参数无效");
  }
  return WRAPPED_KEY_PREFIX + seal(dataKey, platformWrappingKey, Buffer.from(`tj-data-key:v1:${userUUID}`, "utf8"));
}

export function unwrapUserDataKey(userUUID: string, wrapped: string, platformWrappingKey: Buffer): Buffer {
  if (!wrapped.startsWith(WRAPPED_KEY_PREFIX) || platformWrappingKey.length !== 32) {
    throw new Error("用户数据密钥包装版本无效");
  }
  try {
    const key = open(
      wrapped.slice(WRAPPED_KEY_PREFIX.length),
      platformWrappingKey,
      Buffer.from(`tj-data-key:v1:${userUUID}`, "utf8"),
    );
    if (key.length !== 32) throw new Error("invalid key length");
    return key;
  } catch {
    throw new Error("用户数据密钥解包失败");
  }
}

function seal(plain: Buffer, key: Buffer, aad: Buffer): string {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, tag, ciphertext]).toString("base64url");
}

function open(encoded: string, key: Buffer, aad: Buffer): Buffer {
  const payload = Buffer.from(encoded, "base64url");
  if (payload.toString("base64url") !== encoded || payload.length < 28) {
    throw new Error("invalid payload");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, payload.subarray(0, 12));
  decipher.setAAD(aad);
  decipher.setAuthTag(payload.subarray(12, 28));
  return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]);
}

function profileAAD(userUUID: string): Buffer {
  return Buffer.from(`tj-profile:v1:${userUUID}`, "utf8");
}

function isUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
