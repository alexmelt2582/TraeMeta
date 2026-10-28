/**
 * User-level configuration for this installation.
 *
 * It lives next to the executable (inside the resolved data directory) so that
 * a portable copy carries its own settings and never borrows another copy's.
 *
 * Validation is strict and rejects malformed values instead of silently falling
 * back, because a wrong TRAE path would otherwise only surface much later as an
 * unexplained failure during a switch. Values written by an older version of
 * this app are the one exception — they are migrated, because a leftover setting
 * must never make the whole file unreadable.
 */
import path from "node:path";

import { readJsonFile, writeJsonAtomic } from "./json-file.js";
import { PROXY_MODES, PROXY_SCHEMES } from "./system-proxy.js";
import { TRAE_UPDATE_MODES } from "./trae-settings.js";

export const CONFIG_FILE_NAME = "config.json";

export function configPath(dataDir) {
  return path.join(dataDir, CONFIG_FILE_NAME);
}

export function normalizeTraeExe(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error("config.traeExe must be a string or null");
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.includes("\0")) throw new Error("config.traeExe contains a null byte");
  if (!path.isAbsolute(trimmed)) {
    throw new Error(`config.traeExe must be an absolute path, got ${JSON.stringify(trimmed)}`);
  }
  if (path.extname(trimmed).toLowerCase() !== ".exe") {
    throw new Error(`config.traeExe must point to an .exe, got ${JSON.stringify(trimmed)}`);
  }
  return path.normalize(trimmed);
}

export const TRUE_WORDS = new Set(["1", "true", "yes", "on"]);
export const FALSE_WORDS = new Set(["0", "false", "no", "off", ""]);

/**
 * Whether TRAE's own updater should stay switched off, and what the setting read
 * before this project changed it.
 *
 * `previousMode` exists so "允许自动更新" can put back what the user had instead of
 * assuming there was nothing. Null means the entry was absent, which TRAE treats
 * as its own default.
 */
export function normalizeTraeUpdate(raw) {
  if (raw === null || raw === undefined) return { suppress: true, previousMode: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config.traeUpdate must be a JSON object");
  }
  let suppress = true;
  if (raw.suppress !== null && raw.suppress !== undefined) {
    if (typeof raw.suppress === "boolean") suppress = raw.suppress;
    else if (typeof raw.suppress === "string") {
      const normalized = raw.suppress.trim().toLowerCase();
      if (TRUE_WORDS.has(normalized)) suppress = true;
      else if (FALSE_WORDS.has(normalized)) suppress = false;
      else throw new Error(`config.traeUpdate.suppress must be a boolean, got ${JSON.stringify(raw.suppress)}`);
    } else {
      throw new Error(`config.traeUpdate.suppress must be a boolean, got ${JSON.stringify(raw.suppress)}`);
    }
  }

  let previousMode = null;
  if (raw.previousMode !== null && raw.previousMode !== undefined) {
    if (typeof raw.previousMode !== "string" || !TRAE_UPDATE_MODES.includes(raw.previousMode)) {
      throw new Error(
        `config.traeUpdate.previousMode must be one of ${TRAE_UPDATE_MODES.join(", ")}, got ${JSON.stringify(raw.previousMode)}`,
      );
    }
    previousMode = raw.previousMode;
  }
  return { suppress, previousMode };
}

/**
 * Automatic check-in.
 *
 * These fields never reject a value: anything unrecognized falls back to the
 * default instead of failing the whole file. Every other setting here is strict
 * because a wrong value stays invisible until much later, but a check-in
 * interval has no such failure mode — the panel only offers the fixed options
 * below, so an odd value can only come from hand-editing, and refusing to start
 * the daemon over it would cost far more than ignoring it. The effective value
 * is echoed back to the panel on every read, so a fallback is never hidden.
 */
export const CHECKIN_INTERVALS = [15, 30, 60, 120];
export const CHECKIN_DEFAULTS = {
  auto: true,
  intervalMinutes: 30,
  onClientLoad: true,
  // How many days ahead of its expiry a credit segment starts being flagged in
  // the account list. It lives in the check-in block because the panel renders it
  // inside the check-in card, next to the sweep interval: both answer "when does
  // this helper act on its own". The name keeps the subject explicit, because the
  // reminder is about credits, not about check-in.
  reminderDays: 7,
};

/** The reminder thresholds the panel offers, in days. */
export const CREDIT_REMINDER_DAYS = [1, 3, 7, 14, 30];

function normalizeCheckinFlag(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (TRUE_WORDS.has(normalized)) return true;
    if (FALSE_WORDS.has(normalized)) return false;
  }
  return fallback;
}

export function normalizeCheckinInterval(value) {
  const numeric = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return CHECKIN_INTERVALS.includes(numeric) ? numeric : CHECKIN_DEFAULTS.intervalMinutes;
}

export function normalizeReminderDays(value) {
  const numeric = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return CREDIT_REMINDER_DAYS.includes(numeric) ? numeric : CHECKIN_DEFAULTS.reminderDays;
}

export function normalizeCheckin(raw) {
  if (raw === null || raw === undefined) return { ...CHECKIN_DEFAULTS };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config.checkin must be a JSON object");
  }
  return {
    auto: normalizeCheckinFlag(raw.auto, CHECKIN_DEFAULTS.auto),
    intervalMinutes: normalizeCheckinInterval(raw.intervalMinutes),
    onClientLoad: normalizeCheckinFlag(raw.onClientLoad, CHECKIN_DEFAULTS.onClientLoad),
    reminderDays: normalizeReminderDays(raw.reminderDays),
  };
}

/**
 * Whether this helper checks GitHub for a newer release of itself.
 *
 * A separate namespace from `traeUpdate`, which controls TRAE's own updater —
 * the two are different programs and switching one off must never affect the
 * other. Like `checkin`, a bad value falls back instead of refusing to start:
 * the only source of an odd value is hand-editing, and the effective value is
 * echoed back to the panel on every read.
 */
export const APP_UPDATE_DEFAULTS = { autoCheck: true };

export function normalizeAppUpdate(raw) {
  if (raw === null || raw === undefined) return { ...APP_UPDATE_DEFAULTS };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config.appUpdate must be a JSON object");
  }
  return { autoCheck: normalizeCheckinFlag(raw.autoCheck, APP_UPDATE_DEFAULTS.autoCheck) };
}

/**
 * Proxy configuration.
 *
 * Three modes only: direct, follow the Windows proxy, or a fixed address. The
 * old `env` mode is gone — Node cannot reach HTTPS through a SOCKS value in the
 * environment, so promising that mode would be a promise the runtime cannot
 * keep. Legacy keys (`useEnvProxy`, `url`) are simply not read, which is what
 * "discard" means here: nothing is migrated and nothing is silently honoured.
 *
 * The port is only required for `custom`. Switching to `off` keeps whatever the
 * user typed so switching back restores it, and an empty port is normal then.
 */
export const PROXY_DEFAULTS = {
  mode: "off",
  scheme: "http",
  host: "",
  port: 0,
  username: "",
  password: "",
  noProxy: "",
};

/**
 * The exclusions a proxy gets when the user has not typed any: loopback names
 * (also enforced unconditionally by the runtime) plus Windows' `<local>`
 * wildcard, which the runtime resolves as every dotless intranet hostname.
 */
export const DEFAULT_NO_PROXY = "<local>,localhost,127.0.0.1,::1";

function normalizeProxyText(value, field) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`config.proxy.${field} must be a string`);
  }
  const text = String(value);
  if (text.includes("\0")) throw new Error(`config.proxy.${field} contains a null byte`);
  return text.trim();
}

function normalizeProxyPort(value) {
  if (value === null || value === undefined || value === "") return 0;
  const numeric = typeof value === "string" ? Number(value.trim()) : value;
  return Number.isInteger(numeric) ? numeric : Number.NaN;
}

/**
 * A credential, kept exactly as typed.
 *
 * The password is deliberately not trimmed: a leading or trailing space can be
 * part of it, and a value that works in the panel must keep working here. The
 * username is trimmed like every other text field, matching what the panel sends.
 */
function normalizeProxySecret(value) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error("config.proxy.password must be a string");
  }
  const text = String(value);
  if (text.includes("\0")) throw new Error("config.proxy.password contains a null byte");
  return text;
}

export function normalizeNoProxy(value) {
  const text = normalizeProxyText(value, "noProxy");
  if (!text) return "";
  const entries = [];
  for (const part of text.split(",")) {
    const entry = part.trim();
    if (entry && !entries.includes(entry)) entries.push(entry);
  }
  return entries.join(",");
}

export function normalizeProxy(raw) {
  if (raw === null || raw === undefined) return { ...PROXY_DEFAULTS };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config.proxy must be a JSON object");
  }

  const mode =
    raw.mode === null || raw.mode === undefined || String(raw.mode).trim() === ""
      ? "off"
      : String(raw.mode).trim();
  if (!PROXY_MODES.includes(mode)) {
    throw new Error(`config.proxy.mode 必须是 ${PROXY_MODES.join(" / ")} 之一`);
  }

  const scheme = normalizeProxyText(raw.scheme, "scheme").toLowerCase() || "http";
  if (!PROXY_SCHEMES.includes(scheme)) {
    throw new Error(`config.proxy.scheme 必须是 ${PROXY_SCHEMES.join(" / ")} 之一`);
  }

  const host = normalizeProxyText(raw.host, "host");
  const port = normalizeProxyPort(raw.port);
  if (mode === "custom") {
    if (!host) throw new Error("使用自定义代理时必须填写代理地址");
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("自定义代理的端口必须是 1-65535 之间的整数");
    }
  } else if (!(Number.isInteger(port) && port >= 0 && port <= 65535)) {
    throw new Error("config.proxy.port 必须是 0-65535 之间的整数");
  }

  const noProxy = normalizeNoProxy(raw.noProxy);
  // Proxying without exclusions means the intranet leaks through the proxy by
  // default. When a proxy is actually in use, an empty list gets the standard
  // local defaults instead — Windows' `<local>` short-name wildcard plus the
  // loopback names. `off` proxies nothing, so it keeps no list at all.
  return {
    mode,
    scheme,
    host,
    port,
    username: normalizeProxyText(raw.username, "username"),
    password: normalizeProxySecret(raw.password),
    noProxy: mode === "off" ? noProxy : noProxy || DEFAULT_NO_PROXY,
  };
}

/**
 * The `proxy.mode` values written before this version, and what each became.
 *
 * `manual` stored one URL and was this project's name for what is now `custom`.
 * `env` read the proxy out of `HTTP_PROXY`/`HTTPS_PROXY`, which this version no
 * longer supports at all: it maps to `system`, the surviving way of saying "use
 * whatever this machine is configured with". On a machine with no system proxy
 * that resolves to nothing, so it behaves exactly like `off`.
 */
const LEGACY_PROXY_MODES = new Map([
  ["off", "off"],
  ["system", "system"],
  ["manual", "custom"],
  ["env", "system"],
]);

/** Splits the one URL a legacy `manual` entry stored into its parts. */
function legacyProxyTarget(url) {
  const text = typeof url === "string" ? url.trim() : "";
  if (!text) return null;
  let parsed;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    return null;
  }
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (!PROXY_SCHEMES.includes(scheme) || !parsed.hostname) return null;
  return { scheme, host: parsed.hostname, port: Number(parsed.port) || (scheme === "https" ? 443 : 80) };
}

/**
 * Reads the `proxy` block that came from disk.
 *
 * A mode written by an older version must never make the whole file unreadable.
 * It did: a config that still said `manual` made `normalizeConfig` throw, so
 * `loadAppConfig` failed and `locate`, `configure` and the daemon all died with
 * exit code 1 — a leftover proxy setting bricked the entire installation. Stored
 * values are therefore migrated rather than rejected; only the panel and the
 * CLI, where a human is waiting to be told what is wrong, go through the strict
 * `normalizeProxy`.
 */
export function normalizeStoredProxy(rawProxy, legacyUseEnvProxy) {
  if (rawProxy === null || rawProxy === undefined) {
    return { ...PROXY_DEFAULTS, mode: legacyUseEnvProxy === true ? "system" : "off" };
  }
  if (typeof rawProxy !== "object" || Array.isArray(rawProxy)) {
    return { ...PROXY_DEFAULTS };
  }

  const declared = typeof rawProxy.mode === "string" ? rawProxy.mode.trim().toLowerCase() : "";
  if (PROXY_MODES.includes(declared)) return normalizeProxy(rawProxy);

  const mode = LEGACY_PROXY_MODES.get(declared) ?? (legacyUseEnvProxy === true ? "system" : "off");
  const target = mode === "custom" ? legacyProxyTarget(rawProxy.url) : null;
  // A `manual` entry whose URL cannot be read back is not a proxy we can point
  // at; an empty custom address would be unsavable and would route nothing.
  if (mode === "custom" && !target) return { ...PROXY_DEFAULTS };

  return normalizeProxy({
    mode,
    scheme: target?.scheme ?? PROXY_DEFAULTS.scheme,
    host: target?.host ?? "",
    port: target?.port ?? PROXY_DEFAULTS.port,
    noProxy: typeof rawProxy.noProxy === "string" ? rawProxy.noProxy : "",
  });
}

export function normalizeConfig(raw) {
  if (raw === null || raw === undefined) {
    return {
      traeExe: null,
      traeUpdate: { suppress: true, previousMode: null },
      checkin: { ...CHECKIN_DEFAULTS },
      appUpdate: { ...APP_UPDATE_DEFAULTS },
      proxy: { ...PROXY_DEFAULTS },
    };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("the configuration file must contain a JSON object");
  }
  return {
    traeExe: normalizeTraeExe(raw.traeExe),
    traeUpdate: normalizeTraeUpdate(raw.traeUpdate),
    checkin: normalizeCheckin(raw.checkin),
    appUpdate: normalizeAppUpdate(raw.appUpdate),
    proxy: normalizeStoredProxy(raw.proxy, raw.useEnvProxy),
  };
}

export async function loadAppConfig(dataDir) {
  const raw = await readJsonFile(configPath(dataDir), { required: false });
  return normalizeConfig(raw);
}

export async function saveAppConfig(dataDir, patch) {
  const current = await loadAppConfig(dataDir);
  const next = normalizeConfig({ ...current, ...patch });
  await writeJsonAtomic(configPath(dataDir), next, { mode: 0o600 });
  return next;
}
