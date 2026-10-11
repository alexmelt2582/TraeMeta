import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDaemonLogger, redactLogLine } from "../src/lib/daemon-log.js";

test("jwt shaped tokens are removed", () => {
  const line = "auth=Cloud-IDE-JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij";
  const redacted = redactLogLine(line);
  assert.equal(redacted.includes("eyJhbGciOiJIUzI1NiJ9"), false);
  assert.match(redacted, /<redacted/);
});

test("authorization headers are removed whatever the scheme", () => {
  for (const line of [
    "authorization: Bearer abcdefghijklmnop",
    "Cloud-IDE-JWT abcdefghijklmnop",
    "Bearer abcdefghijklmnop",
  ]) {
    const redacted = redactLogLine(line);
    assert.equal(redacted.includes("abcdefghijklmnop"), false, line);
  }
});

test("named secret assignments are removed", () => {
  for (const line of [
    "access_token=abcdef123456",
    "refreshToken: abcdef123456",
    "password = hunter2",
    "apiKey=abcdef123456",
    "cookie=session%3Dabc",
  ]) {
    const redacted = redactLogLine(line);
    assert.equal(/abcdef123456|hunter2|session%3Dabc/.test(redacted), false, line);
  }
});

test("secret query values and long hex strings are removed", () => {
  const redacted = redactLogLine(
    "GET https://api.trae.cn/x?did=987654321&token=zzz failed nonce=0123456789abcdef0123456789abcdef",
  );
  assert.equal(redacted.includes("987654321"), false);
  assert.equal(redacted.includes("zzz"), false);
  assert.equal(redacted.includes("0123456789abcdef0123456789abcdef"), false);
  assert.match(redacted, /did=<redacted>/);
});

test("ordinary text is left alone", () => {
  const line = "daemon listening on http://127.0.0.1:47837 accounts=3";
  assert.equal(redactLogLine(line), line);
});

test("non string input never becomes the literal text null or undefined", () => {
  assert.equal(redactLogLine(null), "");
  assert.equal(redactLogLine(undefined), "");
  assert.equal(redactLogLine(42), "42");
});

test("the logger writes redacted lines and creates its directory", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "trae-log-"));
  const logPath = path.join(dir, "nested", "daemon.log");
  try {
    const logger = createDaemonLogger({ logPath, mirror: false });
    logger.info("listening", { port: 47837 });
    logger.error(new Error("boom access_token=abc123"));
    const text = await fsp.readFile(logPath, "utf8");
    assert.match(text, /\[info\] listening \{"port":47837\}/);
    assert.match(text, /\[error\]/);
    assert.match(text, /boom/);
    assert.equal(text.includes("abc123"), false);
    const stamped = text.split("\n").filter((line) => line.startsWith("["));
    assert.equal(stamped.length, 2);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("console mirroring never calls the patched console methods", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "trae-log-"));
  const logPath = path.join(dir, "daemon.log");
  const stdout = { text: "", write(value) { this.text += value; } };
  const stderr = { text: "", write(value) { this.text += value; } };
  const originalLog = console.log;
  const originalError = console.error;
  try {
    const logger = createDaemonLogger({ logPath, stdout, stderr });
    console.log = () => {
      throw new Error("recursive console hook");
    };
    console.error = () => {
      throw new Error("recursive console hook");
    };
    logger.info("hello");
    logger.error("boom");
    assert.equal(stdout.text, "hello\n");
    assert.equal(stderr.text, "boom\n");
  } finally {
    console.log = originalLog;
    console.error = originalError;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("the logger rotates once the size limit is reached", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "trae-log-"));
  const logPath = path.join(dir, "daemon.log");
  try {
    const logger = createDaemonLogger({ logPath, mirror: false, maxBytes: 200, maxBackups: 2 });
    for (let index = 0; index < 12; index += 1) logger.info(`line ${index}`.padEnd(60, "."));
    const entries = await fsp.readdir(dir);
    const backups = entries.filter((entry) => entry.includes(".bak"));
    assert.equal(backups.length > 0, true);
    assert.equal(backups.length <= 2, true);
    assert.equal(entries.includes("daemon.log"), true);
    assert.equal(fs.statSync(logPath).size <= 200 + 120, true);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("a logger without a path is rejected", () => {
  assert.throws(() => createDaemonLogger({}), /requires a log path/);
  assert.throws(() => createDaemonLogger({ logPath: "   " }), /requires a log path/);
});
