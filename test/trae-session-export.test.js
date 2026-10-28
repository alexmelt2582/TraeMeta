import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  decryptDatabaseImage,
  deriveMacKey,
  HMAC_SIZE,
  IV_SIZE,
  PAGE_SIZE,
  parseKeyHex,
  RESERVE_SIZE,
  SALT_SIZE,
  verifyPage1Hmac,
  WAL_FRAME_HEADER_SIZE,
  WAL_HEADER_SIZE,
} from "../src/lib/trae-session-cipher.js";
import {
  buildSessionMarkdown,
  fetchConversationTurns,
  listTraeSessions,
  prewarmTraeSessionKey,
  safeFilename,
  setTraeSessionKeyScannerForTests,
} from "../src/lib/trae-session-export.js";

/**
 * Synthetic SQLCipher fixtures.
 *
 * The real database is decrypted end-to-end against the running client (see the
 * branch's verification notes); what a fixture can prove is the algorithm
 * itself: a plaintext SQLite file built by node:sqlite is encrypted here with
 * the same AES-256-CBC + HMAC-SHA512 layout the cipher module expects, then
 * decrypted back and re-opened. The WAL cases cover the two layouts that
 * actually occur — page-1 frames keep the salt prefix, every other frame is a
 * standard image — plus the stop-on-foreign-frame and commit-only semantics.
 */

const KEY = crypto.randomBytes(32);
const KEY_HEX = KEY.toString("hex");

/** Encrypts one page exactly the way SQLCipher 4 lays it out. */
function encryptPage(encKey, salt, plaintext, pgno) {
  const iv = crypto.randomBytes(IV_SIZE);
  const cipher = crypto.createCipheriv("aes-256-cbc", encKey, iv);
  cipher.setAutoPadding(false);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const page = Buffer.alloc(PAGE_SIZE);
  if (pgno === 1) {
    salt.copy(page, 0);
    ciphertext.copy(page, SALT_SIZE);
  } else {
    ciphertext.copy(page, 0);
  }
  iv.copy(page, PAGE_SIZE - RESERVE_SIZE);
  const hmac = crypto.createHmac("sha512", deriveMacKey(encKey, salt));
  hmac.update(
    page.subarray(pgno === 1 ? SALT_SIZE : 0, PAGE_SIZE - RESERVE_SIZE + IV_SIZE),
  );
  const pgnoBuf = Buffer.alloc(4);
  pgnoBuf.writeUInt32LE(pgno, 0);
  hmac.update(pgnoBuf);
  hmac.digest().copy(page, PAGE_SIZE - HMAC_SIZE);
  return page;
}

/** Builds a real database, returns both its plaintext images and the encrypted one. */
async function buildEncryptedDatabase(dir, rows) {
  const file = path.join(dir, "plain.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE demo (id INTEGER PRIMARY KEY, note TEXT)");
  db.prepare("INSERT INTO demo (note) VALUES (?)").run(rows[0]);
  db.close();
  const plainA = await fs.readFile(file);
  // UPDATE rewrites the leaf page in place, so both versions keep the same page
  // count and the WAL frames map onto pages the encrypted image actually has.
  const db2 = new DatabaseSync(file);
  db2.prepare("UPDATE demo SET note = ?").run(rows[1]);
  db2.close();
  const plainB = await fs.readFile(file);
  assert.equal(plainA.length, plainB.length);

  const salt = crypto.randomBytes(SALT_SIZE);
  const pages = plainA.length / PAGE_SIZE;
  const encryptedPages = [];
  for (let pgno = 1; pgno <= pages; pgno += 1) {
    const start = (pgno - 1) * PAGE_SIZE;
    const content = plainA.subarray(
      start + (pgno === 1 ? 16 : 0),
      start + PAGE_SIZE - RESERVE_SIZE,
    );
    encryptedPages.push(encryptPage(KEY, salt, content, pgno));
  }
  return { plainA, plainB, salt, image: Buffer.concat(encryptedPages) };
}

/** Builds a synthetic WAL whose frames carry the given plaintext page versions. */
function buildWal(encKey, dbSalt, frames) {
  const header = Buffer.alloc(WAL_HEADER_SIZE);
  header.writeUInt32BE(0x377f0682, 0);
  header.writeUInt32BE(3007000, 4);
  header.writeUInt32BE(PAGE_SIZE, 8);
  const salt1 = crypto.randomBytes(4);
  const salt2 = crypto.randomBytes(4);
  salt1.copy(header, 16);
  salt2.copy(header, 20);
  const parts = [header];
  for (const frame of frames) {
    const frameHeader = Buffer.alloc(WAL_FRAME_HEADER_SIZE);
    frameHeader.writeUInt32BE(frame.pgno, 0);
    frameHeader.writeUInt32BE(frame.commit ?? 0, 4);
    salt1.copy(frameHeader, 8);
    salt2.copy(frameHeader, 12);
    const plaintext = frame.plaintextSubarray;
    parts.push(
      frameHeader,
      encryptPage(
        encKey,
        frame.foreignSalt ? crypto.randomBytes(SALT_SIZE) : dbSalt,
        plaintext,
        frame.pgno,
      ),
    );
  }
  return Buffer.concat(parts);
}

/** Page subarrays (with page 1 keeping its 16-byte header) from a plain image. */
function plaintextPages(plain) {
  const pages = new Map();
  for (let pgno = 1; pgno <= plain.length / PAGE_SIZE; pgno += 1) {
    const start = (pgno - 1) * PAGE_SIZE;
    pages.set(
      pgno,
      plain.subarray(start + (pgno === 1 ? 16 : 0), start + PAGE_SIZE - RESERVE_SIZE),
    );
  }
  return pages;
}

function changedPages(plainA, plainB) {
  const changed = [];
  for (let pgno = 1; pgno <= plainA.length / PAGE_SIZE; pgno += 1) {
    const start = (pgno - 1) * PAGE_SIZE;
    if (!plainA.subarray(start, start + PAGE_SIZE).equals(plainB.subarray(start, start + PAGE_SIZE))) {
      changed.push(pgno);
    }
  }
  return changed;
}

async function withTempDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "traemeta-fixture-"));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("parseKeyHex 只接受 64 位十六进制并输出 32 字节", () => {
  assert.deepEqual(parseKeyHex(KEY_HEX.toUpperCase()), KEY);
  assert.throws(() => parseKeyHex("zz"), /64 位十六进制/);
  assert.throws(() => parseKeyHex(`${KEY_HEX}00`), /64 位十六进制/);
});

test("verifyPage1Hmac 区分正确与错误密钥", async () => {
  await withTempDir(async (dir) => {
    const { image } = await buildEncryptedDatabase(dir, ["第一行", "第二行"]);
    assert.equal(verifyPage1Hmac(KEY, image.subarray(0, PAGE_SIZE)), true);
    assert.equal(verifyPage1Hmac(crypto.randomBytes(32), image.subarray(0, PAGE_SIZE)), false);
  });
});

test("decryptDatabaseImage 解出与明文逐字节一致的页内容", async () => {
  await withTempDir(async (dir) => {
    const { plainA, image } = await buildEncryptedDatabase(dir, ["第一行", "第二行"]);
    const decrypted = decryptDatabaseImage(KEY, image, null);
    assert.equal(decrypted.walApplied, null);
    assert.equal(decrypted.image.subarray(0, 16).toString("ascii"), "SQLite format 3\0");
    // fixture 的明文库是普通 sqlite（页尾 80 字节没有保留区），所以只比较
    // SQLCipher 的可用区 [0, 4016)；真实库的完整可打开性已由真机验证覆盖。
    const usable = PAGE_SIZE - RESERVE_SIZE;
    for (let pgno = 1; pgno <= plainA.length / PAGE_SIZE; pgno += 1) {
      const start = (pgno - 1) * PAGE_SIZE;
      assert.ok(
        decrypted.image.subarray(start, start + usable).equals(plainA.subarray(start, start + usable)),
        `页 ${pgno} 解密后与明文不一致`,
      );
    }
  });
});

test("decryptDatabaseImage 拒绝错误密钥", async () => {
  await withTempDir(async (dir) => {
    const { image } = await buildEncryptedDatabase(dir, ["第一行", "第二行"]);
    assert.throws(
      () => decryptDatabaseImage(crypto.randomBytes(32), image, null),
      /密钥与会话库不匹配/,
    );
  });
});

test("WAL 回放应用提交帧并还原修改（含页 1 盐前缀分支）", async () => {
  await withTempDir(async (dir) => {
    const { plainA, plainB, salt, image } = await buildEncryptedDatabase(dir, [
      "第一行",
      "第二行（已更新）",
    ]);
    const pagesA = plaintextPages(plainA);
    const pagesB = plaintextPages(plainB);
    const changed = changedPages(plainA, plainB);
    assert.ok(changed.length >= 1);
    const frames = changed.map((pgno) => ({
      pgno,
      plaintextSubarray: pagesB.get(pgno),
    }));
    frames[frames.length - 1].commit = frames[frames.length - 1].pgno;
    const wal = buildWal(KEY, salt, frames);

    const decrypted = decryptDatabaseImage(KEY, image, wal);
    assert.equal(decrypted.walApplied, frames.length);
    // 帧覆盖的页换成 plainB 版本，其余页保持 plainA。
    const usable = PAGE_SIZE - RESERVE_SIZE;
    const replaced = (plain, pgno) => {
      const start = (pgno - 1) * PAGE_SIZE;
      return decrypted.image.subarray(start, start + usable).equals(plain.subarray(start, start + usable));
    };
    for (const pgno of changed) assert.ok(replaced(plainB, pgno), `页 ${pgno} 未被 WAL 帧更新`);
    for (let pgno = 1; pgno <= plainA.length / PAGE_SIZE; pgno += 1) {
      if (!changed.includes(pgno)) assert.ok(replaced(plainA, pgno), `页 ${pgno} 不应被改动`);
    }
    // 页 1 在 WAL 里时解密回 SQLite 头，而不是把盐留在文件头。
    assert.equal(decrypted.image.subarray(0, 16).toString("ascii"), "SQLite format 3\0");
    assert.ok(pagesA.get(1) && pagesB.get(1));
  });
});

test("WAL 无提交标记的帧不应用", async () => {
  await withTempDir(async (dir) => {
    const { plainA, plainB, salt, image } = await buildEncryptedDatabase(dir, [
      "第一行",
      "第二行（已更新）",
    ]);
    const pagesB = plaintextPages(plainB);
    const changed = changedPages(plainA, plainB);
    const wal = buildWal(
      KEY,
      salt,
      changed.map((pgno) => ({ pgno, plaintextSubarray: pagesB.get(pgno), commit: 0 })),
    );
    const decrypted = decryptDatabaseImage(KEY, image, wal);
    assert.equal(decrypted.walApplied, 0);
    const usable = PAGE_SIZE - RESERVE_SIZE;
    for (const pgno of changed) {
      const start = (pgno - 1) * PAGE_SIZE;
      assert.ok(
        decrypted.image.subarray(start, start + usable).equals(plainA.subarray(start, start + usable)),
        `页 ${pgno} 在无提交标记时不应被应用`,
      );
    }
  });
});

test("WAL 遇到盐失配的帧即停，只应用之前已提交的部分", async () => {
  await withTempDir(async (dir) => {
    const { plainA, plainB, salt, image } = await buildEncryptedDatabase(dir, [
      "第一行",
      "第二行（已更新）",
    ]);
    const pagesB = plaintextPages(plainB);
    const changed = changedPages(plainA, plainB);
    const frames = changed.map((pgno) => ({ pgno, plaintextSubarray: pagesB.get(pgno) }));
    frames[0].commit = frames[0].pgno;
    if (frames.length > 1) {
      frames[1].foreignSalt = true;
    }
    const wal = buildWal(KEY, salt, frames);
    const decrypted = decryptDatabaseImage(KEY, image, wal);
    assert.equal(decrypted.walApplied, 1);
    const start = (changed[0] - 1) * PAGE_SIZE;
    const usable = PAGE_SIZE - RESERVE_SIZE;
    assert.ok(
      decrypted.image.subarray(start, start + usable).equals(plainB.subarray(start, start + usable)),
    );
  });
});

// ---------------------------------------------------------------------------
// 会话重组纯函数（内存库 fixture）
// ---------------------------------------------------------------------------

const TURNS_SCHEMA = `
  CREATE TABLE chat_message (
    session_id TEXT, message_id TEXT, message_role TEXT,
    message_index INTEGER, deleted_at INTEGER
  );
  CREATE TABLE chat_message_general (message_id TEXT, content TEXT);
  CREATE TABLE chat_message_task (message_id TEXT, content TEXT);
  CREATE TABLE server_history_info (
    conversation_id TEXT, messages TEXT, created_at INTEGER
  );
  CREATE TABLE history_v2 (
    id INTEGER PRIMARY KEY, message_id TEXT, session_id TEXT,
    messages TEXT, deleted_at INTEGER
  );
`;

function insertTurn(db, sessionId, index, role, messageId) {
  db.prepare(
    "INSERT INTO chat_message (session_id, message_id, message_role, message_index, deleted_at) VALUES (?, ?, ?, ?, 0)",
  ).run(sessionId, messageId, role, index);
}

test("fetchConversationTurns 走 server_history_info 流分组并渲染工具调用", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(TURNS_SCHEMA);
  const session = "6adf586af17f9f4570eeea00";
  insertTurn(db, session, 0, "user", "u1");
  insertTurn(db, session, 1, "assistant", "a1");
  insertTurn(db, session, 2, "user", "u2");
  insertTurn(db, session, 3, "assistant", "a2");
  db.prepare("INSERT INTO chat_message_general (message_id, content) VALUES (?, ?)").run(
    "u1",
    JSON.stringify([{ type: "text", text_content: "帮我写个文件" }]),
  );
  db.prepare("INSERT INTO chat_message_general (message_id, content) VALUES (?, ?)").run(
    "u2",
    JSON.stringify([{ type: "text", text_content: "继续" }]),
  );
  db.prepare("INSERT INTO chat_message_task (message_id, content) VALUES (?, ?)").run(
    "a1",
    JSON.stringify({
      messages: [
        {
          plan_item: {
            tool_call_info: {
              name: "RunCommand",
              params: { command: "npm test", summary: "测试全部通过" },
            },
          },
        },
      ],
    }),
  );
  db.prepare("INSERT INTO server_history_info (conversation_id, messages, created_at) VALUES (?, ?, ?)").run(
    session,
    JSON.stringify({
      raw_messages: [
        { role: "user", content: "帮我写个文件" },
        {
          role: "assistant",
          content: [{ type: "text", text: "好的，我来创建文件。" }],
          tool_calls: [
            {
              function_call: {
                name: "Write",
                arguments: JSON.stringify({ file_path: "d:/demo/a.js", content: "console.log(1);\n" }),
              },
            },
          ],
        },
        { role: "user", content: "继续" },
        { role: "assistant", content: [{ type: "text", text: "已完成。" }] },
      ],
    }),
    1000,
  );

  const turns = fetchConversationTurns(db, session);
  assert.equal(turns.length, 4);
  assert.equal(turns[0].role, "user");
  assert.equal(turns[0].text, "帮我写个文件");
  assert.equal(turns[1].role, "assistant");
  assert.match(turns[1].text, /好的，我来创建文件。/);
  assert.match(turns[1].text, /\*\*\[Write\]\*\*/);
  assert.match(turns[1].text, /d:\/demo\/a\.js/);
  // task summary 与流文本都保留。
  assert.match(turns[1].text, /测试全部通过/);
  assert.match(turns[1].text, /```bash\nnpm test\n```/);
  assert.deepEqual(turns[1].tools, ["Write", "RunCommand"]);
  assert.equal(turns[3].text, "已完成。");
  db.close();
});

test("fetchConversationTurns 在流分组不齐时回退 history_v2", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(TURNS_SCHEMA);
  const session = "6ae053f2f17f9f4570eef01c";
  insertTurn(db, session, 0, "user", "u1");
  insertTurn(db, session, 1, "assistant", "a1");
  insertTurn(db, session, 2, "assistant", "a2");
  db.prepare("INSERT INTO chat_message_general (message_id, content) VALUES (?, ?)").run(
    "u1",
    JSON.stringify([{ type: "text", text_content: "问题" }]),
  );
  db.prepare("INSERT INTO server_history_info (conversation_id, messages, created_at) VALUES (?, ?, ?)").run(
    session,
    JSON.stringify({
      raw_messages: [
        { role: "user", content: "问题" },
        { role: "assistant", content: [{ type: "text", text: "只覆盖第一条" }] },
      ],
    }),
    1000,
  );
  db.prepare("INSERT INTO history_v2 (message_id, session_id, messages, deleted_at) VALUES (?, ?, ?, 0)").run(
    "a1",
    session,
    JSON.stringify({
      raw_messages: [{ role: "assistant", content: [{ type: "text", text: "回退答案一" }] }],
    }),
  );
  db.prepare("INSERT INTO history_v2 (message_id, session_id, messages, deleted_at) VALUES (?, ?, ?, 0)").run(
    "a2",
    session,
    JSON.stringify({
      raw_messages: [{ role: "assistant", content: [{ type: "text", text: "回退答案二" }] }],
    }),
  );

  const turns = fetchConversationTurns(db, session);
  assert.equal(turns.length, 3);
  assert.match(turns[1].text, /回退答案一/);
  assert.match(turns[2].text, /回退答案二/);
  db.close();
});

test("buildSessionMarkdown 与 safeFilename 的基本形状", () => {
  const markdown = buildSessionMarkdown({
    title: "检查发布状态",
    sessionId: "6adf586af17f9f4570eeea00",
    createdAt: "2026-10-26 21:40:58",
    updatedAt: "2026-10-28 16:02:29",
    turns: [
      { role: "user", text: "问题", tools: [] },
      { role: "assistant", text: "回答", tools: ["Write"] },
    ],
  });
  assert.match(markdown, /^# 检查发布状态\n/);
  assert.match(markdown, /来源：Trae CN 本地会话库/);
  assert.match(markdown, /6adf586af17f9f4570eeea00/);
  assert.match(markdown, /1 轮对话/);
  assert.match(markdown, /## user\n\n问题/);
  assert.match(markdown, /## assistant\n\n回答/);

  assert.equal(safeFilename('标题:含/非法*字符?', "abcdef123456"), "标题_含_非法_字符__abcdef12.md");
  assert.equal(safeFilename("", "abcdef123456"), "session_abcdef12.md");
  assert.equal(
    safeFilename("x".repeat(80), "abcdef123456"),
    `${"x".repeat(60)}_abcdef12.md`,
  );
});

// ---------------------------------------------------------------------------
// 密钥缓存（stub 扫描器 + 单页空库 fixture）
// ---------------------------------------------------------------------------

/**
 * 一个只有一页的空 SQLite 库（仅写 user_version 触发头部落盘，无任何表），
 * 按 SQLCipher 布局加密后落到 `<userDataDir>/ModularData/ai-agent/database.db`。
 *
 * 空库每页页尾 80 字节本来就是零，与 buildEncryptedDatabase 不同，这里的解密
 * 镜像是一个真正可打开的 SQLite 文件——`listTraeSessions` 能走完「扫描→缓存→
 * 解密→只读打开」全程，最后停在 `no such table: chat_session`，这个报错正是
 * 断言的落点：它证明解密和打开都真的发生了，而不是密钥或解密层的失败。
 */
async function writeEncryptedEmptyDatabase(dir, encKey = KEY) {
  const plainFile = path.join(dir, "plain-empty.db");
  const db = new DatabaseSync(plainFile);
  db.exec("PRAGMA user_version = 1");
  db.close();
  const plain = await fs.readFile(plainFile);
  assert.equal(plain.length, PAGE_SIZE);
  const salt = crypto.randomBytes(SALT_SIZE);
  const image = encryptPage(
    encKey,
    salt,
    plain.subarray(16, PAGE_SIZE - RESERVE_SIZE),
    1,
  );
  const dbDir = path.join(dir, "ModularData", "ai-agent");
  await fs.mkdir(dbDir, { recursive: true });
  await fs.writeFile(path.join(dbDir, "database.db"), image);
  return dir;
}

test("密钥缓存：预扫之后再次预扫与列表都复用缓存，不重复扫描", async (t) => {
  let calls = 0;
  setTraeSessionKeyScannerForTests(() => {
    calls += 1;
    return { ok: true, keyHex: KEY_HEX };
  });
  t.after(() => setTraeSessionKeyScannerForTests(null));
  await withTempDir(async (dir) => {
    const userDataDir = await writeEncryptedEmptyDatabase(dir);
    const options = { traeExe: "Trae CN.exe", userDataDir, timeoutMs: 1000 };

    const first = await prewarmTraeSessionKey({ ...options, force: true });
    assert.deepEqual(first, { ok: true, cached: false });
    assert.equal(calls, 1);

    const second = await prewarmTraeSessionKey(options);
    assert.deepEqual(second, { ok: true, cached: true });
    assert.equal(calls, 1);

    // 列表直接用缓存：扫描次数不变；报错停在缺表上，证明解密与只读打开
    // 都真的发生了（密钥错会是「密钥与会话库不匹配」，不会走到 SQL）。
    await assert.rejects(listTraeSessions(options), /no such table/i);
    assert.equal(calls, 1);
  });
});

test("密钥缓存：缓存密钥与库失配时清缓存并恰好重扫一次", async (t) => {
  const key2 = crypto.randomBytes(32);
  const key2Hex = key2.toString("hex");
  let calls = 0;
  let currentKey = KEY_HEX;
  setTraeSessionKeyScannerForTests(() => {
    calls += 1;
    return { ok: true, keyHex: currentKey };
  });
  t.after(() => setTraeSessionKeyScannerForTests(null));
  await withTempDir(async (dir) => {
    // 库用 key2 加密，但先把 key1 缓存进来（模拟 TRAE 重启换钥之前的旧缓存）。
    const userDataDir = await writeEncryptedEmptyDatabase(dir, key2);
    const options = { traeExe: "Trae CN.exe", userDataDir, timeoutMs: 1000 };
    await prewarmTraeSessionKey({ ...options, force: true });
    assert.equal(calls, 1);

    currentKey = key2Hex;
    // 失配：页 1 HMAC 三次重读都失败 → 清缓存 → 恰好一次强制重扫拿到 key2
    // → 解密成功走到 SQL，同样停在缺表上。
    await assert.rejects(listTraeSessions(options), /no such table/i);
    assert.equal(calls, 2);
  });
});
