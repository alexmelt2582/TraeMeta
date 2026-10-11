/**
 * Reads and edits the ONE setting that stops TRAE from updating itself.
 *
 * Why `update.mode` and nothing else. TRAE's updater reads the value once, when
 * the update service starts, and the branch is explicit in the shipped build
 * (`resources/app/out/main.js`):
 *
 *   update#initialize: region = CN, ... quality = stable
 *   ICUBE:update scheduleCheckForUpdates, updateInterval -> 60   <- mode "default"
 *   ...  update#ctor - manual checks only; automatic updates are disabled
 *        by user preference                                    <- mode "manual"
 *
 * So `manual` is the documented switch for "no automatic update checks", and
 * `update.enableWindowsBackgroundUpdates` is already false by default (it only
 * matters for a per-user install that would otherwise install in the background).
 * `extensions.autoUpdate` does not exist in this build at all.
 *
 * Why this file is edited as TEXT. `User/settings.json` is JSONC: it may contain
 * comments and trailing commas. Parsing and re-serialising it would silently
 * delete every comment the user (or TRAE itself) put there, so the change is a
 * targeted splice that leaves the rest of the file byte-identical.
 *
 * What is never touched: the installation directory, `app.asar`, `product.json`,
 * and every other setting.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { DEFAULT_TRAE_USER_DATA_DIR } from "../constants.js";

/** The setting TRAE's updater reads: "manual" | "start" | "default". */
export const TRAE_UPDATE_MODE_KEY = "update.mode";
export const TRAE_UPDATE_MODES = ["manual", "start", "default"];
/** The only value that stops the automatic checks entirely. */
export const TRAE_UPDATE_MODE_SUPPRESSED = "manual";

export function traeSettingsPath(userDataDir = DEFAULT_TRAE_USER_DATA_DIR) {
  return path.join(userDataDir, "User", "settings.json");
}

export function traeSettingsBackupPath(userDataDir = DEFAULT_TRAE_USER_DATA_DIR) {
  return `${traeSettingsPath(userDataDir)}.traemeta.bak`;
}

/* -------------------------------------------------------------------------- *
 * A minimal JSONC scanner
 *
 * Only enough of one to answer two questions: which top-level keys exist, and
 * where does each value begin and end. Nesting, strings, escapes and both comment
 * styles are handled so that a brace inside a comment or a string can never be
 * mistaken for structure.
 * -------------------------------------------------------------------------- */

function skipString(text, start) {
  let index = start + 1;
  while (index < text.length) {
    const ch = text[index];
    if (ch === "\\") {
      index += 2;
      continue;
    }
    if (ch === '"') return index + 1;
    index += 1;
  }
  return text.length;
}

function skipLineComment(text, start) {
  const end = text.indexOf("\n", start);
  return end < 0 ? text.length : end + 1;
}

function skipBlockComment(text, start) {
  const end = text.indexOf("*/", start + 2);
  return end < 0 ? text.length : end + 2;
}

/** Whitespace and comments are not part of any value. */
function skipTrivia(text, start) {
  let index = start;
  while (index < text.length) {
    const ch = text[index];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      index += 1;
      continue;
    }
    if (ch === "/" && text[index + 1] === "/") {
      index = skipLineComment(text, index);
      continue;
    }
    if (ch === "/" && text[index + 1] === "*") {
      index = skipBlockComment(text, index);
      continue;
    }
    break;
  }
  return index;
}

/**
 * Returns the index just past the value starting at `start`.
 *
 * Objects and arrays are matched by depth; a primitive runs until a structural
 * separator at its own level.
 */
function skipValue(text, start) {
  const ch = text[start];
  if (ch === '"') return skipString(text, start);

  if (ch === "{" || ch === "[") {
    const open = ch;
    const close = ch === "{" ? "}" : "]";
    let depth = 0;
    let index = start;
    while (index < text.length) {
      const current = text[index];
      if (current === '"') {
        index = skipString(text, index);
        continue;
      }
      if (current === "/" && text[index + 1] === "/") {
        index = skipLineComment(text, index);
        continue;
      }
      if (current === "/" && text[index + 1] === "*") {
        index = skipBlockComment(text, index);
        continue;
      }
      if (current === open) depth += 1;
      else if (current === close) {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
      index += 1;
    }
    return text.length;
  }

  let index = start;
  while (index < text.length) {
    const current = text[index];
    if (current === "," || current === "}" || current === "]") break;
    index += 1;
  }
  // Trailing whitespace and comments between the value and the separator are not
  // part of the value.
  let end = index;
  while (end > start && /[\s]/.test(text[end - 1])) end -= 1;
  return end;
}

function decodeKeyToken(token) {
  const text = token.slice(1, -1);
  try {
    return JSON.parse(`"${text}"`);
  } catch {
    return text;
  }
}

/**
 * Every top-level key of the root object, with the exact text span of its value.
 *
 * A file with no root object yields an empty list, which callers treat as "not a
 * settings file we understand" and refuse to edit.
 */
export function scanTopLevelKeys(text) {
  const spans = [];
  let depth = 0;
  let index = 0;
  let rootOpen = -1;
  let rootClose = -1;

  while (index < text.length) {
    const ch = text[index];
    if (ch === '"') {
      const end = skipString(text, index);
      const after = skipTrivia(text, end);
      if (depth === 1 && text[after] === ":") {
        const valueStart = skipTrivia(text, after + 1);
        const valueEnd = skipValue(text, valueStart);
        spans.push({
          key: decodeKeyToken(text.slice(index, end)),
          keyStart: index,
          keyEnd: end,
          valueStart,
          valueEnd,
        });
        index = valueEnd;
        continue;
      }
      index = end;
      continue;
    }
    if (ch === "/" && text[index + 1] === "/") {
      index = skipLineComment(text, index);
      continue;
    }
    if (ch === "/" && text[index + 1] === "*") {
      index = skipBlockComment(text, index);
      continue;
    }
    if (ch === "{") {
      depth += 1;
      if (depth === 1) rootOpen = index;
      index += 1;
      continue;
    }
    if (ch === "}") {
      if (depth === 1) rootClose = index;
      depth -= 1;
      index += 1;
      continue;
    }
    if (ch === "[") {
      depth += 1;
      index += 1;
      continue;
    }
    if (ch === "]") {
      depth -= 1;
      index += 1;
      continue;
    }
    index += 1;
  }

  return { spans, rootOpen, rootClose };
}

/** The literal text of a top-level value, or null when the key is absent. */
export function readTopLevelRawValue(text, key) {
  const { spans } = scanTopLevelKeys(text);
  const span = spans.find((entry) => entry.key === key);
  return span ? text.slice(span.valueStart, span.valueEnd) : null;
}

/** The decoded value of a top-level key, or undefined when it is unreadable. */
export function readTopLevelValue(text, key) {
  const raw = readTopLevelRawValue(text, key);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function detectEol(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Sets a top-level string value, leaving every other byte of the file alone.
 *
 * An existing entry is spliced in place. A missing entry is inserted immediately
 * inside the root object, using the indentation the file already uses.
 */
export function setTopLevelString(text, key, value) {
  const encoded = JSON.stringify(String(value));
  const { spans, rootOpen, rootClose } = scanTopLevelKeys(text);
  if (rootOpen < 0 || rootClose < 0) {
    throw new Error("settings.json does not contain a JSON object at the top level");
  }

  const targets = spans.filter((span) => span.key === key);
  if (targets.length) {
    let next = text;
    // Replace from the end so earlier spans keep their offsets.
    for (const span of [...targets].sort((a, b) => b.valueStart - a.valueStart)) {
      next = next.slice(0, span.valueStart) + encoded + next.slice(span.valueEnd);
    }
    return next;
  }

  const eol = detectEol(text);
  const indent = /(^|\r?\n)([ \t]+)\S/.exec(text.slice(rootOpen, rootClose))?.[2] ?? "\t";
  const entry = `"${key}": ${encoded}`;
  const isEmpty = text.slice(rootOpen + 1, rootClose).trim() === "";
  if (isEmpty) {
    return `${text.slice(0, rootOpen + 1)}${eol}${indent}${entry}${eol}${text.slice(rootClose)}`;
  }
  return `${text.slice(0, rootOpen + 1)}${eol}${indent}${entry},${text.slice(rootOpen + 1)}`;
}

/**
 * Removes a top-level entry, taking the surrounding comma with it.
 *
 * Removing the last entry of an otherwise single-entry object leaves `{}` rather
 * than a trailing comma, which JSONC would tolerate but other readers may not.
 */
export function removeTopLevelKey(text, key) {
  const { spans, rootOpen, rootClose } = scanTopLevelKeys(text);
  const target = spans.find((span) => span.key === key);
  if (!target) return text;

  const remaining = spans.filter((span) => span !== target);
  if (!remaining.length) {
    const eol = detectEol(text);
    return `${text.slice(0, rootOpen + 1)}${eol}${text.slice(rootClose)}`;
  }

  // Delete from the start of the line that holds the key to just past the value,
  // including the following comma when there is one.
  let start = target.keyStart;
  const lineStart = text.lastIndexOf("\n", start - 1);
  if (text.slice(lineStart + 1, start).trim() === "") start = lineStart + 1;

  let end = target.valueEnd;
  const after = skipTrivia(text, end);
  if (text[after] === ",") {
    end = after + 1;
    if (text[end] === "\r") end += 1;
    if (text[end] === "\n") end += 1;
  } else {
    // Last entry in the object: drop the comma of the entry before it instead.
    const before = text.slice(0, start);
    const comma = before.lastIndexOf(",");
    if (comma >= 0 && /^[\s]*$/.test(before.slice(comma + 1))) {
      start = comma;
      if (text[start - 1] === "\r") start -= 1;
      if (text[start - 1] === "\n") start -= 1;
    }
  }
  return text.slice(0, start) + text.slice(end);
}

/* -------------------------------------------------------------------------- *
 * Applying the setting to a real installation
 * -------------------------------------------------------------------------- */

/** How the on-disk setting reads right now. */
export async function readTraeUpdateState({ userDataDir = DEFAULT_TRAE_USER_DATA_DIR } = {}) {
  const settingsPath = traeSettingsPath(userDataDir);
  let text;
  try {
    text = await fs.readFile(settingsPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        path: settingsPath,
        exists: false,
        mode: null,
        // Absent means TRAE's own default, which is periodic automatic checks.
        suppressed: false,
        readable: true,
        error: null,
      };
    }
    return {
      path: settingsPath,
      exists: false,
      mode: null,
      suppressed: false,
      readable: false,
      error: error?.message || String(error),
    };
  }

  const mode = readTopLevelValue(text, TRAE_UPDATE_MODE_KEY);
  return {
    path: settingsPath,
    exists: true,
    mode: typeof mode === "string" ? mode : null,
    suppressed: mode === TRAE_UPDATE_MODE_SUPPRESSED,
    readable: true,
    error: null,
  };
}

/**
 * Writes `update.mode` — either the suppressing value, or the value that was there
 * before this project touched the file.
 *
 * The first write copies the file to `<settings.json>.traemeta.bak`, and a
 * failed write restores it, so a half-written settings file can never be left
 * behind. Writing nothing when the file already reads correctly keeps the file's
 * mtime stable across daemon restarts.
 */
export async function applyTraeUpdateSetting({
  userDataDir = DEFAULT_TRAE_USER_DATA_DIR,
  suppress,
  previousMode = null,
} = {}) {
  const settingsPath = traeSettingsPath(userDataDir);
  const current = await readTraeUpdateState({ userDataDir });

  if (current.readable === false) {
    throw new Error(`无法读取 TRAE 的设置文件：${current.error ?? settingsPath}`);
  }

  const desired = suppress
    ? TRAE_UPDATE_MODE_SUPPRESSED
    : typeof previousMode === "string" && TRAE_UPDATE_MODES.includes(previousMode)
      ? previousMode
      : null; // Restore with nothing remembered means "let TRAE use its own default".

  // Restoring has nothing to undo unless the file currently carries the value this
  // project writes, so a mode the user chose themselves is left alone.
  if (!suppress && current.mode !== TRAE_UPDATE_MODE_SUPPRESSED) {
    return { changed: false, mode: current.mode, path: settingsPath, backupPath: null, restored: false };
  }
  if (suppress && current.mode === desired) {
    return { changed: false, mode: current.mode, path: settingsPath, backupPath: null, restored: false };
  }

  let original = null;
  try {
    original = await fs.readFile(settingsPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(`无法读取 TRAE 的设置文件：${error?.message || error}`);
    }
  }

  const base = original ?? "{\n}\n";
  const next =
    desired === null
      ? removeTopLevelKey(base, TRAE_UPDATE_MODE_KEY)
      : setTopLevelString(base, TRAE_UPDATE_MODE_KEY, desired);

  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  let backupPath = null;
  if (original !== null) {
    backupPath = traeSettingsBackupPath(userDataDir);
    await fs.copyFile(settingsPath, backupPath).catch(() => {
      backupPath = null;
    });
  }

  try {
    await fs.writeFile(settingsPath, next, "utf8");
  } catch (error) {
    if (original !== null) {
      await fs.writeFile(settingsPath, original, "utf8").catch(() => {});
    }
    throw new Error(`写入 TRAE 设置失败，已回滚：${error?.message || error}`);
  }

  const written = await readTraeUpdateState({ userDataDir });
  return {
    changed: true,
    mode: written.mode,
    path: settingsPath,
    backupPath,
    restored: !suppress,
  };
}
