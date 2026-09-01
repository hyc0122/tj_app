import crypto from "node:crypto";

import { defaultCredentialStore } from "../crypto/default-credential-store";
import { currentUserStorage } from "../runtime/user-storage-context";

const ENVELOPE_VERSION = 1;

function accountKey(): Buffer {
  const ctx = currentUserStorage();
  if (!ctx) throw new Error("缺少中央用户存储上下文");
  const keyName = `canvas-raw-inbox-key:${ctx.segment}`;
  let encoded = defaultCredentialStore.get(keyName);
  if (!encoded) {
    // 中文注释：每个账号使用独立随机密钥；Electron 生产环境由 OS safeStorage 加密保存。
    encoded = crypto.randomBytes(32).toString("base64");
    defaultCredentialStore.set(keyName, encoded);
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("raw inbox 加密密钥无效");
  return key;
}

export function encryptRawInboxPayload(
  plaintext: Buffer,
  aad: string,
): { envelopeVersion: number; nonce: string; ciphertext: string; tag: string } {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", accountKey(), nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    envelopeVersion: ENVELOPE_VERSION,
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptRawInboxPayload(envelope: {
  nonce: string;
  ciphertext: string;
  tag: string;
}, aad: string): Buffer {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    accountKey(),
    Buffer.from(envelope.nonce, "base64"),
  );
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);
}
