import crypto from "node:crypto";

/**
 * SQLCipher 4 page decryption for Trae CN's chat database.
 *
 * The database lives at `<Trae user-data>/ModularData/ai-agent/database.db`
 * (SQLCipher 4: AES-256-CBC, HMAC-SHA512, page 4096, reserve 80 = IV 16 + HMAC
 * 64). The 64-hex-char key found in the running client's memory is the raw
 * 32-byte encryption key itself — there is no passphrase KDF; only the per-page
 * MAC key is derived (PBKDF2-HMAC-SHA512, two iterations, salt XOR 0x3a).
 *
 * Everything here is pure computation over buffers so it can be exercised by
 * synthetic fixtures without touching a real database or a live process.
 */

export const PAGE_SIZE = 4096;
export const KEY_SIZE = 32;
export const SALT_SIZE = 16;
export const IV_SIZE = 16;
export const HMAC_SIZE = 64;
export const RESERVE_SIZE = 80;
export const WAL_HEADER_SIZE = 32;
export const WAL_FRAME_HEADER_SIZE = 24;
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "ascii");
const WAL_MAGIC = 0x377f0682;

export function parseKeyHex(keyHex) {
  const value = String(keyHex || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("会话库密钥必须是 64 位十六进制字符串");
  }
  return Buffer.from(value, "hex");
}

function macSalt(pageSalt) {
  const out = Buffer.alloc(SALT_SIZE);
  for (let i = 0; i < SALT_SIZE; i += 1) out[i] = pageSalt[i] ^ 0x3a;
  return out;
}

export function deriveMacKey(encKey, pageSalt) {
  return crypto.pbkdf2Sync(encKey, macSalt(pageSalt), 2, KEY_SIZE, "sha512");
}

/**
 * Page-1 HMAC is the only key-correctness oracle SQLCipher gives us, so both
 * the memory scanner (PowerShell port) and this module test the same structure:
 * HMAC-SHA512 over ciphertext+IV with the little-endian page number appended.
 */
export function verifyPage1Hmac(encKey, page1) {
  if (!Buffer.isBuffer(encKey) || encKey.length !== KEY_SIZE) return false;
  if (!Buffer.isBuffer(page1) || page1.length < PAGE_SIZE) return false;
  const macKey = deriveMacKey(encKey, page1.subarray(0, SALT_SIZE));
  const hmac = crypto.createHmac("sha512", macKey);
  hmac.update(page1.subarray(SALT_SIZE, PAGE_SIZE - RESERVE_SIZE + IV_SIZE));
  const pgno = Buffer.alloc(4);
  pgno.writeUInt32LE(1, 0);
  hmac.update(pgno);
  return crypto.timingSafeEqual(hmac.digest(), page1.subarray(PAGE_SIZE - HMAC_SIZE));
}

export function decryptPage(encKey, page, pgno) {
  if (!Buffer.isBuffer(page) || page.length < PAGE_SIZE) {
    throw new Error(`页面 ${pgno} 不完整，数据库可能已损坏`);
  }
  const iv = page.subarray(PAGE_SIZE - RESERVE_SIZE, PAGE_SIZE - RESERVE_SIZE + IV_SIZE);
  const decipher = crypto.createDecipheriv("aes-256-cbc", encKey, iv);
  decipher.setAutoPadding(false);
  const body =
    pgno === 1
      ? decipher.update(page.subarray(SALT_SIZE, PAGE_SIZE - RESERVE_SIZE))
      : decipher.update(page.subarray(0, PAGE_SIZE - RESERVE_SIZE));
  decipher.final();
  return Buffer.concat([pgno === 1 ? SQLITE_HEADER : Buffer.alloc(0), body]);
}

/** Decrypts a standard page image (no salt prefix), padding to the page size. */
function decryptStandardPage(encKey, page) {
  const iv = page.subarray(PAGE_SIZE - RESERVE_SIZE, PAGE_SIZE - RESERVE_SIZE + IV_SIZE);
  const decipher = crypto.createDecipheriv("aes-256-cbc", encKey, iv);
  decipher.setAutoPadding(false);
  const body = Buffer.concat([
    decipher.update(page.subarray(0, PAGE_SIZE - RESERVE_SIZE)),
    decipher.final(),
  ]);
  return body.length >= PAGE_SIZE ? body.subarray(0, PAGE_SIZE) : Buffer.concat([body, Buffer.alloc(PAGE_SIZE - body.length)]);
}

/**
 * Verifies one WAL frame and returns its decrypted page, or null when the frame
 * does not belong to this WAL generation or fails the page MAC.
 *
 * A WAL frame encrypts exactly what the main file would: page 1 keeps the salt
 * prefix, every other page is a standard image. The MAC key is derived from the
 * database salt — the WAL header's first bytes are magic and format fields, not
 * the salt; only the frame-header salts select generations.
 */
function decryptWalFrame(encKey, dbSalt, walHeader, frame, framePgno) {
  const salt1 = walHeader.subarray(16, 20);
  const salt2 = walHeader.subarray(20, 24);
  if (!frame.subarray(8, 12).equals(salt1) || !frame.subarray(12, 16).equals(salt2)) {
    return null;
  }
  const page = frame.subarray(WAL_FRAME_HEADER_SIZE);
  const macKey = deriveMacKey(encKey, dbSalt);
  const hmac = crypto.createHmac("sha512", macKey);
  hmac.update(
    framePgno === 1
      ? page.subarray(SALT_SIZE, PAGE_SIZE - RESERVE_SIZE + IV_SIZE)
      : page.subarray(0, PAGE_SIZE - RESERVE_SIZE + IV_SIZE),
  );
  const pgnoBuf = Buffer.alloc(4);
  pgnoBuf.writeUInt32LE(framePgno, 0);
  hmac.update(pgnoBuf);
  if (!hmac.digest().equals(page.subarray(PAGE_SIZE - HMAC_SIZE))) return null;
  return framePgno === 1
    ? decryptPage(encKey, page, 1)
    : decryptStandardPage(encKey, page);
}

/**
 * Decrypts the whole database image with the raw 32-byte key and replays the
 * WAL on top of it.
 *
 * The plaintext image is a plain SQLite file; opening it read-only never
 * touches the original. WAL replay is best effort: frames are applied only up
 * to the last commit marker, and any structural surprise downgrades the result
 * to the main file alone (marked by `walApplied: null`), exactly the "latest
 * messages may lag" case the UI must disclose.
 */
export function decryptDatabaseImage(encKey, db, wal = null) {
  if (!Buffer.isBuffer(encKey) || encKey.length !== KEY_SIZE) {
    throw new Error("会话库密钥格式不正确");
  }
  if (!Buffer.isBuffer(db) || db.length < PAGE_SIZE) {
    throw new Error("会话库太小或为空，无法解密");
  }
  if (!verifyPage1Hmac(encKey, db.subarray(0, PAGE_SIZE))) {
    throw new Error("密钥与会话库不匹配：TRAE 可能重新登录过，请重试扫描");
  }

  const pages = Math.floor(db.length / PAGE_SIZE);
  const image = Buffer.alloc(pages * PAGE_SIZE);
  for (let pgno = 1; pgno <= pages; pgno += 1) {
    decryptPage(encKey, db.subarray((pgno - 1) * PAGE_SIZE, pgno * PAGE_SIZE), pgno).copy(
      image,
      (pgno - 1) * PAGE_SIZE,
    );
  }

  let walApplied = null;
  let walError = null;
  if (Buffer.isBuffer(wal) && wal.length >= WAL_HEADER_SIZE) {
    try {
      walApplied = replayWal(encKey, db.subarray(0, SALT_SIZE), wal, image);
    } catch (error) {
      walError = error instanceof Error ? error.message : String(error);
    }
  }
  return { image, walApplied, walError };
}

function replayWal(encKey, dbSalt, wal, image) {
  const magic = wal.readUInt32BE(0);
  if (magic !== WAL_MAGIC && magic !== (WAL_MAGIC | 1)) return null;
  const pageSize = wal.readUInt32BE(8);
  if (pageSize !== PAGE_SIZE) return null;

  const frameSize = WAL_FRAME_HEADER_SIZE + PAGE_SIZE;
  const totalFrames = Math.floor((wal.length - WAL_HEADER_SIZE) / frameSize);
  let applied = 0;
  let pending = [];
  for (let i = 0; i < totalFrames; i += 1) {
    const offset = WAL_HEADER_SIZE + i * frameSize;
    const frame = wal.subarray(offset, offset + frameSize);
    const framePgno = frame.readUInt32BE(0);
    const commitSize = frame.readUInt32BE(4);
    if (framePgno === 0 || framePgno * PAGE_SIZE > image.length) return applied || null;
    const decrypted = decryptWalFrame(
      encKey,
      dbSalt,
      wal.subarray(0, WAL_HEADER_SIZE),
      frame,
      framePgno,
    );
    if (!decrypted) return applied || null;
    pending.push({ framePgno, decrypted });
    if (commitSize !== 0) {
      for (const { framePgno: pgno, decrypted: page } of pending) {
        page.copy(image, (pgno - 1) * PAGE_SIZE);
        applied += 1;
      }
      pending = [];
    }
  }
  return applied;
}
