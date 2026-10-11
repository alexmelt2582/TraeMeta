import assert from "node:assert/strict";
import test from "node:test";

import {
  commandArguments,
  flagValue,
  parseServiceArgs,
} from "../src/lib/cli-args.js";

const NODE = "C:\\nodejs\\node.exe";
const SCRIPT = "D:\\app\\scripts\\service.js";
const EXE = "D:\\app\\TraeMeta.exe";

test("source mode reads the command after the script path", () => {
  const parsed = parseServiceArgs([NODE, SCRIPT, "status"]);
  assert.equal(parsed.command, "status");
  assert.equal(parsed.hasCommand, true);
  assert.deepEqual(parsed.rest, []);
});

test("a bundled executable reads the command after its embedded script name", () => {
  const parsed = parseServiceArgs([EXE, EXE, "stop"]);
  assert.equal(parsed.command, "stop");
  assert.equal(parsed.hasCommand, true);
});

test("the internal switch never becomes the command", () => {
  const parsed = parseServiceArgs([EXE, EXE, "--internal-service", "stop"]);
  assert.equal(parsed.command, "stop");
  assert.equal(parsed.hasCommand, true);
  assert.deepEqual(parsed.rest, []);
});

test("the internal switch is dropped even when it trails the command", () => {
  const parsed = parseServiceArgs([EXE, EXE, "tray", "--internal-service"]);
  assert.equal(parsed.command, "tray");
  assert.deepEqual(parsed.rest, []);
});

test("no arguments at all defaults to start so a double click does something", () => {
  assert.equal(parseServiceArgs([EXE, EXE]).command, "start");
  assert.equal(parseServiceArgs([EXE, EXE]).hasCommand, false);
  assert.equal(parseServiceArgs([NODE, SCRIPT]).command, "start");
});

test("a leading flag is not treated as a command", () => {
  const parsed = parseServiceArgs([EXE, EXE, "--verbose"]);
  assert.equal(parsed.hasCommand, false);
  assert.equal(parsed.command, "start");
});

test("the command is matched case insensitively", () => {
  assert.equal(parseServiceArgs([EXE, EXE, "STATUS"]).command, "status");
});

test("extra arguments are passed through to the command", () => {
  const parsed = parseServiceArgs([EXE, EXE, "configure", "--trae-exe", "D:\\a\\b.exe"]);
  assert.equal(parsed.command, "configure");
  assert.deepEqual(parsed.rest, ["--trae-exe", "D:\\a\\b.exe"]);
});

test("a different drop count is supported for a custom entry point", () => {
  assert.deepEqual(commandArguments(["a", "b", "c"], { drop: 1 }), ["b", "c"]);
  assert.deepEqual(commandArguments(["a"], { drop: 2 }), []);
});

test("flag values are read by name and never guessed", () => {
  assert.equal(flagValue(["--trae-exe", "D:\\a.exe"], "--trae-exe"), "D:\\a.exe");
  assert.equal(flagValue(["--other", "x", "--trae-exe", "D:\\b.exe"], "--trae-exe"), "D:\\b.exe");
  assert.equal(flagValue(["--trae-exe"], "--trae-exe"), null);
  assert.equal(flagValue([], "--trae-exe"), null);
  assert.equal(flagValue(["status"], "--trae-exe"), null);
});
