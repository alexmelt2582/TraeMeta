import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  APP_UPDATE_DEFAULTS,
  CHECKIN_DEFAULTS,
  CHECKIN_INTERVALS,
  CONFIG_FILE_NAME,
  CREDIT_REMINDER_DAYS,
  PROXY_DEFAULTS,
  configPath,
  loadAppConfig,
  normalizeAppUpdate,
  normalizeCheckin,
  normalizeCheckinInterval,
  normalizeConfig,
  normalizeProxy,
  normalizeReminderDays,
  normalizeTraeExe,
  normalizeTraeUpdate,
  saveAppConfig,
} from "../src/lib/app-config.js";

const DEFAULT_TRAE_UPDATE = { suppress: true, previousMode: null };
const DEFAULTS = {
  traeExe: null,
  traeUpdate: DEFAULT_TRAE_UPDATE,
  checkin: CHECKIN_DEFAULTS,
  appUpdate: APP_UPDATE_DEFAULTS,
  proxy: PROXY_DEFAULTS,
};

test("a missing or empty trae path normalizes to null", () => {
  assert.equal(normalizeTraeExe(null), null);
  assert.equal(normalizeTraeExe(undefined), null);
  assert.equal(normalizeTraeExe(""), null);
  assert.equal(normalizeTraeExe("   "), null);
});

test("a usable trae path is normalized", () => {
  assert.equal(
    normalizeTraeExe("  D:\\Me\\副业\\Trae CN.exe  "),
    path.normalize("D:\\Me\\副业\\Trae CN.exe"),
  );
});

test("a relative or non executable path is rejected instead of being stored", () => {
  assert.throws(() => normalizeTraeExe("Trae CN.exe"), /must be an absolute path/);
  assert.throws(() => normalizeTraeExe(".\\Trae CN.exe"), /must be an absolute path/);
  assert.throws(() => normalizeTraeExe("C:\\apps\\readme.txt"), /must point to an \.exe/);
  assert.throws(() => normalizeTraeExe(42), /must be a string or null/);
  assert.throws(() => normalizeTraeExe("C:\\a\0b.exe"), /null byte/);
});

test("an absent configuration normalizes to defaults", () => {
  assert.deepEqual(normalizeConfig(null), DEFAULTS);
  assert.deepEqual(normalizeConfig(undefined), DEFAULTS);
  assert.deepEqual(normalizeConfig({}), DEFAULTS);
});

test("the trae auto-update preference defaults to suppressed", () => {
  assert.deepEqual(normalizeTraeUpdate(null), DEFAULT_TRAE_UPDATE);
  assert.deepEqual(normalizeTraeUpdate({}), DEFAULT_TRAE_UPDATE);
  assert.deepEqual(normalizeTraeUpdate({ suppress: false }), {
    suppress: false,
    previousMode: null,
  });
  assert.deepEqual(normalizeTraeUpdate({ suppress: "off", previousMode: "start" }), {
    suppress: false,
    previousMode: "start",
  });
  assert.throws(() => normalizeTraeUpdate({ suppress: "maybe" }), /must be a boolean/);
  assert.throws(() => normalizeTraeUpdate([]), /must be a JSON object/);
  assert.throws(() => normalizeTraeUpdate({ previousMode: "sometimes" }), /must be one of/);
});

test("automatic check-in defaults to on, every 30 minutes, with the client-load run", () => {
  assert.deepEqual(normalizeCheckin(null), CHECKIN_DEFAULTS);
  assert.deepEqual(normalizeCheckin(undefined), CHECKIN_DEFAULTS);
  assert.deepEqual(normalizeCheckin({}), CHECKIN_DEFAULTS);
  assert.deepEqual(CHECKIN_INTERVALS, [15, 30, 60, 120]);
});

test("every offered check-in interval is accepted and nothing else is", () => {
  for (const minutes of CHECKIN_INTERVALS) {
    assert.equal(normalizeCheckinInterval(minutes), minutes);
    // A string is accepted too: the value arrives back through JSON.
    assert.equal(normalizeCheckinInterval(String(minutes)), minutes);
  }
  for (const value of [0, 7, 999, -30, 30.5, "abc", "", null, undefined, true, [], {}]) {
    assert.equal(normalizeCheckinInterval(value), CHECKIN_DEFAULTS.intervalMinutes);
  }
});

test("a bad check-in entry falls back instead of failing the whole file", () => {
  assert.deepEqual(normalizeCheckin({ auto: "maybe", intervalMinutes: 7, onClientLoad: 42 }), CHECKIN_DEFAULTS);
  assert.deepEqual(normalizeCheckin({ auto: false, intervalMinutes: "60", onClientLoad: "off" }), {
    auto: false,
    intervalMinutes: 60,
    onClientLoad: false,
    reminderDays: 7,
  });
  // The container itself stays strict: a string here means the file is structurally wrong.
  assert.throws(() => normalizeCheckin([]), /must be a JSON object/);
  assert.throws(() => normalizeCheckin("on"), /must be a JSON object/);
});

test("the credit reminder threshold is limited to the offered values", () => {
  assert.deepEqual(CREDIT_REMINDER_DAYS, [1, 3, 7, 14, 30]);
  assert.equal(CHECKIN_DEFAULTS.reminderDays, 7);
  for (const days of CREDIT_REMINDER_DAYS) {
    assert.equal(normalizeReminderDays(days), days);
    // A string is accepted too: the value arrives back through JSON.
    assert.equal(normalizeReminderDays(String(days)), days);
  }
  for (const value of [0, 2, 6, 8, 90, 7.5, "abc", "", null, undefined, true, [], {}]) {
    assert.equal(normalizeReminderDays(value), CHECKIN_DEFAULTS.reminderDays);
  }
  assert.equal(normalizeCheckin({ reminderDays: 30 }).reminderDays, 30);
  assert.equal(normalizeCheckin({ reminderDays: "abc" }).reminderDays, 7);
});

test("a configuration written before the check-in block existed gains the defaults", () => {
  const migrated = normalizeConfig({ traeExe: null });
  assert.deepEqual(migrated.checkin, CHECKIN_DEFAULTS);
  assert.deepEqual(migrated.appUpdate, APP_UPDATE_DEFAULTS);
  assert.deepEqual(migrated.proxy, PROXY_DEFAULTS);
});

test("the assistant update check defaults to on and only rejects a wrong container", () => {
  assert.deepEqual(normalizeAppUpdate(null), APP_UPDATE_DEFAULTS);
  assert.deepEqual(normalizeAppUpdate(undefined), APP_UPDATE_DEFAULTS);
  assert.deepEqual(normalizeAppUpdate({}), APP_UPDATE_DEFAULTS);
  assert.deepEqual(normalizeAppUpdate({ autoCheck: false }), { autoCheck: false });
  // Strings arrive back through JSON, so they are read like the check-in flags.
  assert.deepEqual(normalizeAppUpdate({ autoCheck: "off" }), { autoCheck: false });
  assert.deepEqual(normalizeAppUpdate({ autoCheck: "on" }), { autoCheck: true });
  // A bad value falls back rather than refusing to start; the panel echoes the
  // effective value back on every read, so the fallback is never hidden.
  assert.deepEqual(normalizeAppUpdate({ autoCheck: "maybe" }), APP_UPDATE_DEFAULTS);
  assert.throws(() => normalizeAppUpdate([]), /must be a JSON object/);
});

test("the assistant update check is a namespace of its own", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "trae-config-"));
  try {
    await saveAppConfig(dir, { appUpdate: { autoCheck: false } });
    const loaded = await loadAppConfig(dir);
    // TRAE's own updater is a different program with a different setting.
    assert.deepEqual(loaded.appUpdate, { autoCheck: false });
    assert.deepEqual(loaded.traeUpdate, DEFAULT_TRAE_UPDATE);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a malformed configuration file is rejected instead of ignored", () => {
  assert.throws(() => normalizeConfig([]), /must contain a JSON object/);
  assert.throws(() => normalizeConfig("nope"), /must contain a JSON object/);
  assert.throws(() => normalizeConfig({ traeExe: "relative.exe" }), /absolute path/);
  // The proxy block is the exception: anything unrecognisable in it reads back as
  // the default instead of making the file unreadable (see the migration test).
  assert.deepEqual(normalizeConfig({ proxy: [] }).proxy, PROXY_DEFAULTS);
});

test("loading a missing configuration file yields defaults", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "trae-config-"));
  try {
    assert.deepEqual(await loadAppConfig(dir), DEFAULTS);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("saving then loading keeps the selected trae path", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "trae-config-"));
  const exe = path.normalize("D:\\Me\\副业\\Trae CN.exe");
  try {
    await saveAppConfig(dir, { traeExe: exe });
    assert.deepEqual(await loadAppConfig(dir), { ...DEFAULTS, traeExe: exe });

    const written = JSON.parse(await fs.readFile(configPath(dir), "utf8"));
    assert.deepEqual(written, { ...DEFAULTS, traeExe: exe });

    const stats = await fs.stat(path.join(dir, CONFIG_FILE_NAME));
    assert.equal(stats.isFile(), true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("saving a patch keeps the previous values", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "trae-config-"));
  const exe = path.normalize("C:\\apps\\Trae CN.exe");
  try {
    await saveAppConfig(dir, { traeExe: exe });
    await saveAppConfig(dir, { checkin: { auto: false } });
    assert.deepEqual(await loadAppConfig(dir), {
      ...DEFAULTS,
      traeExe: exe,
      checkin: { ...CHECKIN_DEFAULTS, auto: false },
    });

    const cleared = await saveAppConfig(dir, { traeExe: null });
    assert.deepEqual(cleared, {
      ...DEFAULTS,
      traeExe: null,
      checkin: { ...CHECKIN_DEFAULTS, auto: false },
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("saving an invalid path does not overwrite a good configuration", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "trae-config-"));
  const exe = path.normalize("C:\\apps\\Trae CN.exe");
  try {
    await saveAppConfig(dir, { traeExe: exe });
    await assert.rejects(
      () => saveAppConfig(dir, { traeExe: "relative.exe" }),
      /must be an absolute path/,
    );
    assert.deepEqual(await loadAppConfig(dir), { ...DEFAULTS, traeExe: exe });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the proxy defaults to direct, with no credential", () => {
  assert.deepEqual(PROXY_DEFAULTS, {
    mode: "off",
    scheme: "http",
    host: "",
    port: 0,
    username: "",
    password: "",
    noProxy: "",
  });
  assert.deepEqual(normalizeProxy(undefined), PROXY_DEFAULTS);
  assert.deepEqual(normalizeProxy({}), PROXY_DEFAULTS);
});

test("an unknown proxy mode is rejected rather than coerced", () => {
  assert.throws(() => normalizeProxy({ mode: "manual" }), /必须是 off \/ system \/ custom/);
  assert.throws(() => normalizeProxy({ mode: "env" }), /必须是 off \/ system \/ custom/);
});

test("a custom proxy requires an address and an in-range port", () => {
  assert.throws(() => normalizeProxy({ mode: "custom" }), /必须填写代理地址/);
  assert.throws(() => normalizeProxy({ mode: "custom", host: "127.0.0.1" }), /端口/);
  assert.throws(() => normalizeProxy({ mode: "custom", host: "127.0.0.1", port: 0 }), /端口/);
  assert.throws(() => normalizeProxy({ mode: "custom", host: "127.0.0.1", port: 65536 }), /端口/);
  assert.throws(
    () => normalizeProxy({ mode: "custom", host: "127.0.0.1", port: 7890, scheme: "ftp" }),
    /scheme/,
  );
  assert.deepEqual(normalizeProxy({ mode: "custom", host: " 127.0.0.1 ", port: "7890" }), {
    ...PROXY_DEFAULTS,
    mode: "custom",
    host: "127.0.0.1",
    port: 7890,
  });
});

test("a non-custom mode may keep an empty port", () => {
  // Switching back to `custom` must still find what the user typed, so `off`
  // and `system` tolerate the fields being blank rather than rejecting the save.
  assert.deepEqual(normalizeProxy({ mode: "off", port: "" }), PROXY_DEFAULTS);
  assert.deepEqual(normalizeProxy({ mode: "system", port: "" }), {
    ...PROXY_DEFAULTS,
    mode: "system",
  });
});

test("proxy credentials survive a round trip and the password keeps its spaces", () => {
  const stored = normalizeProxy({
    mode: "custom",
    host: "127.0.0.1",
    port: 7890,
    username: "  alice  ",
    password: "  s3cret  ",
  });
  assert.equal(stored.username, "alice");
  assert.equal(stored.password, "  s3cret  ");
});

test("the exception list is trimmed, de-duplicated and comma-joined", () => {
  assert.equal(
    normalizeProxy({ mode: "off", noProxy: " *.corp.example.com , localhost ,*.corp.example.com,, " })
      .noProxy,
    "*.corp.example.com,localhost",
  );
});

test("a null byte anywhere in a proxy field is rejected", () => {
  assert.throws(
    () => normalizeProxy({ mode: "custom", host: "127.0.0.1\0", port: 7890 }),
    /null byte/,
  );
  assert.throws(
    () => normalizeProxy({ mode: "custom", host: "127.0.0.1", port: 7890, password: "a\0b" }),
    /null byte/,
  );
});

test("a proxy block written before this namespace existed is migrated, never fatal", () => {
  // A machine that had one of these on disk made `loadAppConfig` throw, which took
  // down `locate`, `configure` and the daemon together: a leftover setting bricked
  // the whole installation, including the installer's own configure step.
  const manual = normalizeConfig({
    proxy: { mode: "manual", url: "http://127.0.0.1:7890", noProxy: "*.corp.cn" },
  });
  assert.deepEqual(manual.proxy, {
    ...PROXY_DEFAULTS,
    mode: "custom",
    host: "127.0.0.1",
    port: 7890,
    noProxy: "*.corp.cn",
  });

  assert.equal(normalizeConfig({ proxy: { mode: "env" } }).proxy.mode, "system");
  assert.equal(normalizeConfig({ proxy: { mode: "system" } }).proxy.mode, "system");
  assert.equal(normalizeConfig({ proxy: { mode: "off" } }).proxy.mode, "off");
  // v1.0.0 wrote the boolean instead of a mode, meaning the same thing as `env`.
  assert.equal(normalizeConfig({ useEnvProxy: true }).proxy.mode, "system");

  // Nothing readable left to point at: direct is the honest answer, not a custom
  // entry with an empty address that could never be saved again.
  assert.equal(normalizeConfig({ proxy: { mode: "manual", url: "" } }).proxy.mode, "off");
  assert.equal(normalizeConfig({ proxy: { mode: "manual", url: "http://" } }).proxy.mode, "off");
  // A mode that is not ours either way still reads back as the default.
  assert.equal(normalizeConfig({ proxy: { mode: "banana" } }).proxy.mode, "off");

  // Migrating something already migrated must not move it again.
  assert.deepEqual(normalizeConfig(manual), manual);

  // Only stored values are lenient; the panel and the CLI still get an error.
  assert.throws(() => normalizeProxy({ mode: "manual", url: "http://127.0.0.1:7890" }), /mode/);
});

test("saving a proxy block keeps the other settings", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "trae-config-"));
  try {
    await saveAppConfig(dir, { checkin: { auto: false } });
    const saved = await saveAppConfig(dir, {
      proxy: { mode: "custom", host: "127.0.0.1", port: 7890 },
    });
    assert.deepEqual(saved.proxy, { ...PROXY_DEFAULTS, mode: "custom", host: "127.0.0.1", port: 7890 });
    assert.deepEqual(saved.checkin, { ...CHECKIN_DEFAULTS, auto: false });
    // A rejected value must leave the file exactly as it was.
    await assert.rejects(() => saveAppConfig(dir, { proxy: { mode: "custom" } }), /地址/);
    assert.deepEqual((await loadAppConfig(dir)).proxy, saved.proxy);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
