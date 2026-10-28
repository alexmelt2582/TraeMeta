import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

import {
  decryptDatabaseImage,
  parseKeyHex,
} from "./trae-session-cipher.js";
import { scanTraeSessionKey } from "./trae-session-scan.js";

/**
 * Read-only Markdown export for Trae CN's local chat database.
 *
 * Pipeline per request: scan the key out of the running client's memory, copy
 * `database.db` (+ WAL) into buffers, decrypt them into a plaintext image in the
 * OS temp directory, open that image read-only with node:sqlite, then either
 * list sessions or reassemble one conversation as Markdown. The plaintext image
 * and the key are both deleted before this module returns — nothing decrypted
 * survives a request, and the original database is never opened for writing.
 *
 * Message reassembly follows the database's own storage: user text comes from
 * `chat_message_general`, the final answer and tool calls from
 * `chat_message_task` / `server_history_info`, with `history_v2` as the
 * assistant fallback when the stream grouping does not line up with the
 * `chat_message` turn list.
 */

const SOURCE_LABEL = "Trae CN 本地会话库";

/**
 * The SQLCipher key of the running client's chat database, in hex.
 *
 * Deliberately process-resident only: the scan takes ~45s of PowerShell, so
 * caching it here is what makes the second list/export request instant. It never
 * touches the disk, a log, or any structure an index refresh could carry away —
 * a stale key (TRAE restarted and re-keyed the database) is detected by the page-1
 * HMAC failure and re-scanned once inside `withDecryptedDatabase`.
 */
let cachedKeyHex = null;

/**
 * The scan itself shells out to PowerShell and needs a live TRAE, so tests
 * swap it out here; pass null to restore the real scanner.
 */
let keyScanner = scanTraeSessionKey;

export function setTraeSessionKeyScannerForTests(impl) {
  keyScanner = typeof impl === "function" ? impl : scanTraeSessionKey;
}

/**
 * Scans the key into the cache ahead of any user request.
 *
 * Fired from the daemon's CDP-connect hook so the scan cost is paid while the
 * user is still working, not after they click「会话导出」. `force` re-scans even
 * when a key is cached — a TRAE restart very likely re-keyed the database, and a
 * background rescan on reconnect is free. A failed scan keeps any previous cache
 * and only reports why; it never throws and never logs the key itself.
 */
export async function prewarmTraeSessionKey({
  traeExe,
  userDataDir,
  timeoutMs,
  force = false,
} = {}) {
  if (cachedKeyHex && !force) return { ok: true, cached: true };
  const scan = await keyScanner({
    traeExe,
    dbPath: traeSessionDbPath(userDataDir),
    timeoutMs,
  });
  if (!scan.ok) return { ok: false, code: scan.code, message: scan.message };
  cachedKeyHex = scan.keyHex;
  return { ok: true, cached: false };
}

/** One scan failure shaped as an Error, the way every caller reports it. */
function scanError(scan) {
  const error = new Error(scan.message);
  if (scan.code) error.code = scan.code;
  return error;
}

function isSessionId(value) {
  const trimmed = String(value || "").trim().toLowerCase();
  return (
    trimmed.length >= 20 &&
    trimmed.length <= 24 &&
    /^[0-9a-f]+$/.test(trimmed)
  );
}

/** Timestamps are Unix seconds (or ms) stored as bigint; rendered in UTC+8. */
function formatTimestamp(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "";
  }
  const ms = value > 1_000_000_000_000 ? value : value * 1000;
  const shifted = new Date(ms + 8 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(
    shifted.getUTCDate(),
  )} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(
    shifted.getUTCSeconds(),
  )}`;
}

export function safeFilename(name, sessionId) {
  const cleaned = String(name || "")
    .replace(/[\\/:*?"<>|\r\n\t]/g, "_")
    .trim();
  const base = cleaned || "session";
  return `${base.slice(0, 60)}_${String(sessionId).slice(0, 8)}.md`;
}

// ---------------------------------------------------------------------------
// Decrypted database lifecycle
// ---------------------------------------------------------------------------

async function readDatabaseFiles(dbPath) {
  const db = await fs.readFile(dbPath);
  const wal = await fs.readFile(`${dbPath}-wal`).catch(() => null);
  return { db, wal };
}

/**
 * Decrypts one snapshot, re-reading the files up to twice on a page-HMAC failure.
 *
 * Both files are being written while we read them, so a torn first read is
 * normal: a failed decryption gets a fresh snapshot before being treated as a
 * real (wrong-key) error. Returns the decrypted image together with the exact
 * files it came from, so the hot-WAL replay below can compare apples to apples.
 */
async function decryptImageWithRereads(key, readFiles) {
  let files = await readFiles();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return { decrypted: decryptDatabaseImage(key, files.db, files.wal), files };
    } catch (error) {
      if (attempt === 2) throw error;
      await delay(400);
      files = await readFiles();
    }
  }
  return null;
}

/**
 * Decrypts the chat database into a temp file and hands the read-only
 * connection to `run`. The temp directory is always removed afterwards.
 *
 * The key comes from the module cache first; a decryption failure against a
 * cached key means TRAE re-keyed its database (usually a restart), so the cache
 * is dropped and exactly one forced rescan gets a second complete chance. A
 * first-scan key that fails decryption is a real error, not a cache problem.
 */
async function withDecryptedDatabase({ traeExe, dbPath, timeoutMs }, run) {
  let keyHex = cachedKeyHex;
  const fromCache = Boolean(keyHex);
  if (!keyHex) {
    const scan = await keyScanner({ traeExe, dbPath, timeoutMs });
    if (!scan.ok) throw scanError(scan);
    keyHex = scan.keyHex;
    cachedKeyHex = keyHex;
  }

  const readFiles = () => readDatabaseFiles(dbPath);
  let result;
  try {
    result = await decryptImageWithRereads(parseKeyHex(keyHex), readFiles);
  } catch (error) {
    if (!fromCache) throw error;
    // The cached key no longer matches page 1: TRAE re-keyed the database.
    // Drop the cache and give exactly one forced rescan a complete chance.
    cachedKeyHex = null;
    console.warn(`[sessions] 缓存的库密钥已失效，正在重新扫描：${error.message || error}`);
    const scan = await keyScanner({ traeExe, dbPath, timeoutMs });
    if (!scan.ok) throw scanError(scan);
    keyHex = scan.keyHex;
    cachedKeyHex = keyHex;
    result = await decryptImageWithRereads(parseKeyHex(keyHex), readFiles);
  }
  if (!result) throw new Error("会话库解密失败");
  let { decrypted, files } = result;

  if (decrypted.walApplied === null || decrypted.walApplied === 0) {
    // The WAL is hot: a mid-write snapshot replays nothing. Re-read it once.
    await delay(300);
    const wal = await fs.readFile(`${dbPath}-wal`).catch(() => null);
    if (wal && !wal.equals(files.wal)) {
      try {
        decrypted = decryptDatabaseImage(parseKeyHex(keyHex), files.db, wal);
      } catch {
        // Keep the previous image; the note about possibly missing recent
        // messages covers this case.
      }
    }
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "traemeta-sessions-"));
  const imageFile = path.join(dir, "sessions.db");
  await fs.writeFile(imageFile, decrypted.image);
  let connection;
  try {
    connection = new DatabaseSync(imageFile, { readOnly: true });
    return await run(connection, { walApplied: decrypted.walApplied });
  } finally {
    try {
      connection?.close();
    } catch {
      // The connection may already be gone; the directory removal below is
      // what matters.
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Message text extraction
// ---------------------------------------------------------------------------

/** `chat_message_general.content` → user's typed text (clean original). */
function generalText(raw) {
  if (!raw) return "";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return String(raw).trim();
  }
  if (!Array.isArray(parsed)) return String(raw).trim();
  const parts = [];
  for (const piece of parsed) {
    const text = piece?.text_content ?? piece?.text;
    if (typeof text === "string" && text.trim()) parts.push(text.trim());
  }
  return parts.join("\n");
}

/** `history_v2.messages` → assistant text (concatenated text parts). */
function assistantHistoryText(raw) {
  if (!raw) return "";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "";
  }
  const messages = parsed?.raw_messages;
  if (!Array.isArray(messages)) return "";
  const parts = [];
  for (const message of messages) {
    if (message?.role !== "assistant") continue;
    const content = message?.content;
    if (Array.isArray(content)) {
      for (const piece of content) {
        if (piece?.type === "text" && typeof piece?.text === "string" && piece.text.trim()) {
          parts.push(piece.text.trim());
        }
      }
    } else if (typeof content === "string" && content.trim()) {
      parts.push(content.trim());
    }
  }
  return parts.join("\n\n");
}

/** `chat_message_task.content` → the turn's final full answer. */
function taskSummaryText(raw) {
  if (!raw) return "";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "";
  }
  const messages = parsed?.messages;
  if (!Array.isArray(messages)) return "";
  const parts = [];
  for (const message of messages) {
    const summary = message?.plan_item?.tool_call_info?.params?.summary;
    if (typeof summary === "string" && summary.trim()) parts.push(summary.trim());
  }
  return parts.join("\n\n");
}

/** Renders one tool call as a Markdown block (inputs kept whole). */
function renderToolCall(name, params) {
  const value = params && typeof params === "object" && !Array.isArray(params) ? params : {};
  const get = (key) => {
    const raw = value[key];
    return typeof raw === "string" ? raw : "";
  };
  const codeBlock = (text, lang = "") => `\`\`\`${lang}\n${text}\n\`\`\``;
  const lines = [`**[${name}]**`];
  switch (name) {
    case "Write":
      lines.push(`创建文件：\`${get("file_path")}\``, codeBlock(get("content")));
      break;
    case "Edit": {
      lines.push(`编辑文件：\`${get("file_path")}\``);
      if (get("old_string")) lines.push("旧内容：", codeBlock(get("old_string")));
      if (get("new_string")) lines.push("新内容：", codeBlock(get("new_string")));
      if (get("content")) lines.push(codeBlock(get("content")));
      break;
    }
    case "RunCommand":
    case "CheckCommandStatus":
    case "StopCommand":
      if (get("command")) lines.push(codeBlock(get("command"), "bash"));
      break;
    case "Read":
      lines.push(`读取文件：\`${get("file_path")}\``);
      break;
    case "Grep":
      lines.push(`搜索 \`${get("path")}\`：${get("pattern")}`);
      break;
    case "LS":
      lines.push(`列目录：\`${get("path")}\``);
      break;
    case "Glob":
      lines.push(`匹配 \`${get("path")}\`：${get("pattern")}`);
      break;
    case "DeleteFile":
      lines.push(`删除文件：${get("file_paths")}`);
      break;
    case "TodoWrite": {
      const todos = Array.isArray(value.todos) ? value.todos : [];
      for (const todo of todos) {
        if (todo && typeof todo === "object") {
          lines.push(`- [${todo.status ?? ""}] ${todo.content ?? ""}`);
        } else {
          lines.push(`- ${todo}`);
        }
      }
      break;
    }
    case "WebSearch":
      lines.push(`搜索：${get("query")}`);
      break;
    case "AskUserQuestion": {
      const questions = Array.isArray(value.questions) ? value.questions : [];
      for (const question of questions) {
        if (question && typeof question === "object") {
          lines.push(`提问：${question.question ?? ""}`);
        } else {
          lines.push(`提问：${question}`);
        }
      }
      break;
    }
    case "finish":
    case "CompactFake":
      return "";
    default: {
      let text;
      try {
        text = JSON.stringify(value) ?? "{}";
      } catch {
        text = "[无法序列化的参数]";
      }
      if (text.length > 1500) text = `${text.slice(0, 1500)} ...(截断)`;
      lines.push(codeBlock(text, "json"));
    }
  }
  return lines.join("\n").trim();
}

/** `chat_message_task.content` → rendered tool blocks + tool names per turn. */
function taskToolBlocks(raw) {
  const blocks = [];
  const names = [];
  if (!raw) return { blocks, names };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { blocks, names };
  }
  const messages = parsed?.messages;
  if (!Array.isArray(messages)) return { blocks, names };
  for (const message of messages) {
    const info = message?.plan_item?.tool_call_info;
    const name = info?.name;
    if (typeof name !== "string" || name === "finish" || name === "CompactFake") continue;
    const params = info?.params;
    if (
      name === "Edit" &&
      !params?.old_string &&
      !params?.new_string &&
      !params?.content
    ) {
      continue;
    }
    const block = renderToolCall(name, params);
    if (block) {
      blocks.push(block);
      if (!names.includes(name)) names.push(name);
    }
  }
  return { blocks, names };
}

/**
 * `server_history_info` incremental stream grouped at user boundaries.
 * Returns `{ groups, names }` (parallel arrays) or null.
 */
function serverStreamGroups(connection, sessionId) {
  let rows;
  try {
    rows = connection
      .prepare(
        "SELECT messages FROM server_history_info WHERE conversation_id = ? ORDER BY created_at, rowid",
      )
      .all(sessionId);
  } catch {
    return null;
  }
  if (!rows.length) return null;
  const groups = [];
  const names = [];
  for (const row of rows) {
    let parsed;
    try {
      parsed = JSON.parse(row.messages);
    } catch {
      continue;
    }
    const messages = parsed?.raw_messages;
    if (!Array.isArray(messages)) continue;
    for (const message of messages) {
      const role = message?.role;
      if (role === "user") {
        groups.push([]);
        names.push([]);
        continue;
      }
      if (role !== "assistant") continue;
      if (!groups.length) {
        groups.push([]);
        names.push([]);
      }
      const texts = [];
      const content = message?.content;
      if (Array.isArray(content)) {
        for (const piece of content) {
          if (piece?.type === "text" && typeof piece?.text === "string" && piece.text.trim()) {
            texts.push(piece.text.trim());
          }
        }
      } else if (typeof content === "string" && content.trim()) {
        texts.push(content.trim());
      }
      const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
      for (const call of toolCalls) {
        const functionCall = call?.function_call ?? {};
        const name = typeof functionCall?.name === "string" ? functionCall.name : "?";
        let args = functionCall?.arguments;
        let params;
        try {
          params = typeof args === "string" ? JSON.parse(args) : args ?? {};
        } catch {
          params = { raw: String(args ?? "").slice(0, 500) };
        }
        const block = renderToolCall(name, params);
        if (block) {
          texts.push(block);
          if (!names.at(-1).includes(name)) names.at(-1).push(name);
        }
      }
      const group = groups.at(-1);
      for (const text of texts) {
        if (!group.length || group.at(-1) !== text) group.push(text);
      }
    }
  }
  return groups.length ? { groups, names } : null;
}

// ---------------------------------------------------------------------------
// Conversation assembly
// ---------------------------------------------------------------------------

export function fetchConversationTurns(connection, sessionId) {
  const rows = connection
    .prepare(
      "SELECT message_id, message_role FROM chat_message WHERE session_id = ? AND ifnull(deleted_at,0)=0 ORDER BY message_index",
    )
    .all(sessionId);

  const assistantIds = rows
    .filter((row) => row.message_role === "assistant")
    .map((row) => row.message_id);
  const perAssistant = assistantIds.map((messageId) => {
    let taskRaw = "";
    try {
      taskRaw =
        connection
          .prepare("SELECT content FROM chat_message_task WHERE message_id = ?")
          .get(messageId)?.content ?? "";
    } catch {
      taskRaw = "";
    }
    return { summary: taskSummaryText(taskRaw), ...taskToolBlocks(taskRaw) };
  });

  const stream = serverStreamGroups(connection, sessionId);
  const streamTexts =
    stream && stream.groups.length === assistantIds.length
      ? stream.groups.map((texts) => texts.join("\n\n"))
      : null;

  const turns = [];
  let assistantIndex = 0;
  for (const row of rows) {
    if (row.message_role === "user") {
      let generalRaw = "";
      try {
        generalRaw =
          connection
            .prepare("SELECT content FROM chat_message_general WHERE message_id = ?")
            .get(row.message_id)?.content ?? "";
      } catch {
        generalRaw = "";
      }
      turns.push({ role: "user", text: generalText(generalRaw), tools: [] });
      continue;
    }
    const index = assistantIndex;
    assistantIndex += 1;
    const entry = perAssistant[index];
    let text;
    const tools = [...(stream?.names?.[index] ?? [])];
    if (streamTexts) {
      const pieces = [streamTexts[index], ...entry.blocks.filter(Boolean)];
      if (entry.summary && !streamTexts[index].includes(entry.summary)) {
        pieces.push(entry.summary);
      }
      text = pieces.filter(Boolean).join("\n\n");
    } else {
      let historyRows = [];
      try {
        historyRows = connection
          .prepare(
            "SELECT messages FROM history_v2 WHERE message_id = ? AND ifnull(deleted_at,0)=0 ORDER BY id",
          )
          .all(row.message_id);
      } catch {
        historyRows = [];
      }
      const pieces = [
        historyRows
          .map((item) => assistantHistoryText(item.messages))
          .filter(Boolean)
          .join("\n\n"),
        ...entry.blocks.filter(Boolean),
      ];
      if (entry.summary && !pieces.includes(entry.summary)) pieces.push(entry.summary);
      text = pieces.filter(Boolean).join("\n\n");
    }
    for (const name of entry.names) {
      if (!tools.includes(name)) tools.push(name);
    }
    turns.push({ role: "assistant", text: text.trim(), tools });
  }
  return turns;
}

// ---------------------------------------------------------------------------
// Public API: list + export
// ---------------------------------------------------------------------------

export function traeSessionDbPath(userDataDir) {
  return path.join(userDataDir, "ModularData", "ai-agent", "database.db");
}

/** The display name of a session's project: its label, else the path's tail. */
function projectDisplayName(name, absolutePath) {
  const label = String(name ?? "").trim();
  if (label) return label;
  const trimmed = String(absolutePath ?? "").trim();
  if (!trimmed) return "";
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

/**
 * Lists sessions of the running TRAE (newest activity first), each tagged with
 * its project display name ("" when the session belongs to no project).
 * `recentMessagesComplete` is false when the WAL could not be replayed, in
 * which case the newest messages may be missing from the result.
 */
export async function listTraeSessions({ traeExe, userDataDir, timeoutMs } = {}) {
  if (!traeExe) throw new Error("尚未配置 Trae CN 路径，无法定位会话库");
  const dbPath = traeSessionDbPath(userDataDir);
  return withDecryptedDatabase({ traeExe, dbPath, timeoutMs }, (connection, { walApplied }) => {
    // The project table arrived with workspace grouping; an older database
    // without it still lists fine, just ungrouped.
    let rows;
    try {
      rows = connection
        .prepare(
          "SELECT cs.session_id, cs.session_title, cs.created_at, cs.updated_at, p.name AS project_name, p.absolute_path AS project_path FROM chat_session cs LEFT JOIN project p ON cs.project_id = p.project_id WHERE ifnull(cs.deleted_at,0)=0 ORDER BY ifnull(cs.updated_at, cs.created_at) DESC",
        )
        .all();
    } catch {
      rows = connection
        .prepare(
          "SELECT session_id, session_title, created_at, updated_at, NULL AS project_name, NULL AS project_path FROM chat_session WHERE ifnull(deleted_at,0)=0 ORDER BY ifnull(updated_at, created_at) DESC",
        )
        .all();
    }
    const turnCounts = new Map(
      connection
        .prepare(
          "SELECT session_id, count(*) AS turns FROM chat_message WHERE message_role='user' AND ifnull(deleted_at,0)=0 GROUP BY session_id",
        )
        .all()
        .map((row) => [row.session_id, row.turns]),
    );
    return {
      sessions: rows.map((row) => ({
        id: row.session_id,
        title: String(row.session_title ?? "").trim() || row.session_id,
        createdAt: formatTimestamp(Number(row.created_at)),
        updatedAt: formatTimestamp(Number(row.updated_at)),
        turns: turnCounts.get(row.session_id) ?? 0,
        project: projectDisplayName(row.project_name, row.project_path),
      })),
      recentMessagesComplete: walApplied !== null,
    };
  });
}

/** Builds one conversation's Markdown document. */
export function buildSessionMarkdown({
  title,
  sessionId,
  createdAt,
  updatedAt,
  turns,
}) {
  const lines = [];
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`> 来源：${SOURCE_LABEL} · Session: \`${sessionId}\``);
  const userTurns = turns.filter((turn) => turn.role === "user").length;
  lines.push(
    `> 创建：${createdAt || "未知"} · 更新：${updatedAt || "未知"} · ${userTurns} 轮对话`,
  );
  lines.push("");
  lines.push("---");
  lines.push("");
  for (const turn of turns) {
    lines.push(`## ${turn.role}`);
    lines.push("");
    lines.push(turn.text || "（无记录）");
    lines.push("");
    lines.push("---");
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Exports one session as Markdown. Everything decrypted lives only inside this
 * call: the temp image is removed on return and the key never leaves memory.
 */
export async function exportTraeSessionMarkdown({
  traeExe,
  userDataDir,
  sessionId,
  timeoutMs,
} = {}) {
  const id = String(sessionId || "").trim();
  if (!isSessionId(id)) {
    throw new Error("会话 ID 格式不正确");
  }
  if (!traeExe) throw new Error("尚未配置 Trae CN 路径，无法定位会话库");
  const dbPath = traeSessionDbPath(userDataDir);
  return withDecryptedDatabase({ traeExe, dbPath, timeoutMs }, (connection) => {
    const session = connection
      .prepare(
        "SELECT session_title, created_at, updated_at FROM chat_session WHERE session_id = ?",
      )
      .get(id);
    if (!session) {
      const error = new Error("该会话不在当前 TRAE 的会话库中");
      error.code = "session-not-found";
      throw error;
    }
    const title = String(session.session_title ?? "").trim() || id;
    const turns = fetchConversationTurns(connection, id);
    const markdown = buildSessionMarkdown({
      title,
      sessionId: id,
      createdAt: formatTimestamp(Number(session.created_at)),
      updatedAt: formatTimestamp(Number(session.updated_at)),
      turns,
    });
    return {
      markdown,
      filename: safeFilename(title, id),
      meta: {
        title,
        turns: turns.filter((turn) => turn.role === "user").length,
        messages: turns.length,
      },
    };
  });
}
