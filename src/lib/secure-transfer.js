import crypto from "node:crypto";
import { promisify } from "node:util";
import zlib from "node:zlib";

import { validateAuthSnapshot } from "./trae-storage.js";

const FORMAT = "trae-meta";
const EXPORT_TYPE = "accounts";
const VERSION = 1;
const COMPRESSION = "gzip";
const CIPHER = "aes-256-gcm";
const KDF = "scrypt";
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 1024;
const MAX_ACCOUNTS = 500;
const MAX_PLAINTEXT_BYTES = 64 * 1024 * 1024;

const scryptAsync = promisify(crypto.scrypt);
const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);

function requiredPassword(value, { allowEmpty = false } = {}) {
  const password = typeof value === "string" ? value : "";
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`密码不能超过 ${MAX_PASSWORD_LENGTH} 个字符`);
  }
  if (!allowEmpty && password.trim().length < MIN_PASSWORD_LENGTH) {
    throw new Error(`密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符`);
  }
  return password;
}

function buildAad(metadata) {
  return Buffer.from(JSON.stringify(metadata), "utf8");
}

function envelopeMetadata(envelope) {
  return {
    format: envelope.format,
    version: envelope.version,
    exportType: envelope.exportType,
    createdAt: envelope.createdAt,
    compression: envelope.compression,
    encryption: {
      algorithm: envelope.encryption?.algorithm,
      kdf: envelope.encryption?.kdf,
      n: envelope.encryption?.n,
      r: envelope.encryption?.r,
      p: envelope.encryption?.p,
      salt: envelope.encryption?.salt,
      iv: envelope.encryption?.iv,
    },
  };
}

function decodeBase64(value, expectedLength, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`导出文件缺少有效的 ${label}`);
  }
  const buffer = Buffer.from(value, "base64");
  if (expectedLength && buffer.length !== expectedLength) {
    throw new Error(`导出文件缺少有效的 ${label}`);
  }
  return buffer;
}

function validateEnvelope(envelope) {
  if (
    !envelope ||
    envelope.format !== FORMAT ||
    envelope.version !== VERSION ||
    envelope.exportType !== EXPORT_TYPE ||
    envelope.compression !== COMPRESSION ||
    envelope.encryption?.algorithm !== CIPHER ||
    envelope.encryption?.kdf !== KDF ||
    envelope.encryption.n !== SCRYPT_N ||
    envelope.encryption.r !== SCRYPT_R ||
    envelope.encryption.p !== SCRYPT_P
  ) {
    throw new Error("不是有效的 Trae Meta 账号导出文件");
  }
}

async function deriveKey(password, salt) {
  return await scryptAsync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAX_MEMORY,
  });
}

export async function createAccountsExport(accounts, password, { now = Date.now() } = {}) {
  const checkedPassword = requiredPassword(password);
  if (!Array.isArray(accounts) || !accounts.length) {
    throw new Error("没有可导出的账号备份");
  }
  if (accounts.length > MAX_ACCOUNTS) {
    throw new Error(`单次最多导出 ${MAX_ACCOUNTS} 个账号`);
  }
  for (const item of accounts) {
    validateAuthSnapshot(item?.snapshot);
  }

  const createdAt = new Date(now).toISOString();
  const payload = {
    format: FORMAT,
    exportType: EXPORT_TYPE,
    version: VERSION,
    exportedAt: createdAt,
    accounts: accounts.map((item) => ({
      accountId: item.account.id,
      snapshot: item.snapshot,
    })),
  };
  const compressed = await gzipAsync(Buffer.from(JSON.stringify(payload), "utf8"));
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const envelope = {
    format: FORMAT,
    version: VERSION,
    exportType: EXPORT_TYPE,
    createdAt,
    compression: COMPRESSION,
    encryption: {
      algorithm: CIPHER,
      kdf: KDF,
      n: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: "",
    },
    data: "",
  };
  const cipher = crypto.createCipheriv(CIPHER, await deriveKey(checkedPassword, salt), iv);
  cipher.setAAD(buildAad(envelopeMetadata(envelope)));
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  envelope.encryption.tag = cipher.getAuthTag().toString("base64");
  envelope.data = encrypted.toString("base64");
  return {
    filename: `TraeMeta-账号导出-${createdAt.slice(0, 10)}.json`,
    mimeType: "application/json",
    content: `${JSON.stringify(envelope, null, 2)}\n`,
    count: accounts.length,
  };
}

export async function openAccountsExport(content, password) {
  const checkedPassword = requiredPassword(password, { allowEmpty: true });
  let envelope;
  try {
    envelope = JSON.parse(String(content || ""));
  } catch {
    throw new Error("文件不是有效的导出 JSON");
  }
  validateEnvelope(envelope);
  const salt = decodeBase64(envelope.encryption.salt, SALT_LENGTH, "加密 salt");
  const iv = decodeBase64(envelope.encryption.iv, IV_LENGTH, "加密 iv");
  const tag = decodeBase64(envelope.encryption.tag, TAG_LENGTH, "认证标签");
  const encrypted = decodeBase64(envelope.data, null, "加密数据");
  if (!encrypted.length) throw new Error("导出数据不完整或已损坏");

  let compressed;
  try {
    const decipher = crypto.createDecipheriv(
      CIPHER,
      await deriveKey(checkedPassword, salt),
      iv,
    );
    decipher.setAAD(buildAad(envelopeMetadata(envelope)));
    decipher.setAuthTag(tag);
    compressed = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    throw new Error("密码错误或导出文件已损坏");
  }

  let payload;
  try {
    const plaintext = await gunzipAsync(compressed, {
      maxOutputLength: MAX_PLAINTEXT_BYTES,
    });
    payload = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new Error("导出数据无法解析或已损坏");
  }
  if (
    payload?.format !== FORMAT ||
    payload?.exportType !== EXPORT_TYPE ||
    payload?.version !== VERSION ||
    !Array.isArray(payload.accounts)
  ) {
    throw new Error("导出文件类型不匹配");
  }
  if (!payload.accounts.length) {
    throw new Error("导入文件中没有账号数据");
  }
  if (payload.accounts.length > MAX_ACCOUNTS) {
    throw new Error(`单次最多导入 ${MAX_ACCOUNTS} 个账号`);
  }
  for (const item of payload.accounts) {
    validateAuthSnapshot(item?.snapshot);
  }
  return payload;
}

export const secureTransferConstants = Object.freeze({
  FORMAT,
  EXPORT_TYPE,
  VERSION,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  MAX_ACCOUNTS,
});
