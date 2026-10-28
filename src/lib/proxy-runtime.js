/**
 * Holds the one dispatcher every outbound request in this process goes through.
 *
 * The daemon reads the proxy configuration once at start-up and again on every
 * save, builds a dispatcher from it, and swaps the old one out atomically. A
 * configuration change therefore takes effect immediately: no restart, and no
 * window in which a request could leave through the previous path.
 *
 * A build failure never silently falls back to a direct connection — that is the
 * most dangerous outcome of all, because "I thought the proxy was on but it was
 * direct" is invisible until something leaks. The previous dispatcher is kept and
 * the failure is reported in `reason`/`notes` instead.
 *
 * Credentials are passed as structured options, never interpolated into a proxy
 * URL: a URL string can escape into a log or an exception message, an object
 * field cannot.
 */
import { ProxyAgent, Socks5ProxyAgent } from "undici";

import {
  PROXY_REASON_TEXT,
  describeSystemProxy,
  readWindowsSystemProxy,
  redactProxyUrl,
  resolveProxyTarget,
} from "./system-proxy.js";

let state = {
  mode: "off",
  source: "off",
  dispatcher: null,
  target: null,
  noProxy: [],
  reason: "off",
  notes: [],
  system: null,
  systemReadError: null,
};

/**
 * Whether a host is exempt from the proxy.
 *
 * Entries may be a bare host, a domain suffix (`corp.example.com`), the
 * wildcard form (`*.corp.example.com`), or Windows' `<local>` token — every
 * single-label name without a dot, the intranet short-name convention. Ports
 * are not part of an entry: this project only ever talks to 443, and matching
 * one port while missing another would be a worse failure than matching the
 * host as a whole.
 */
export function isExcluded(url, noProxy) {
  if (!Array.isArray(noProxy) || noProxy.length === 0) return false;
  let hostname;
  try {
    hostname = new URL(String(url)).hostname.toLowerCase();
  } catch {
    return false;
  }
  for (const raw of noProxy) {
    const entry = String(raw ?? "").trim().toLowerCase();
    if (!entry) continue;
    if (entry === "<local>") {
      if (!hostname.includes(".")) return true;
      continue;
    }
    const bare = entry.replace(/^[*.]+/, "");
    if (!bare) continue;
    if (hostname === bare || hostname.endsWith(`.${bare}`)) return true;
  }
  return false;
}

function basicToken(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

/**
 * The message of a failed build, with any userinfo removed.
 *
 * A URL parse error can quote the string it rejected, and that string can be a
 * proxy URL the user pasted into the address field — password included. Every
 * message that leaves this module goes through here first.
 */
function redactBuildError(error) {
  return redactProxyUrl(error?.message || String(error));
}

/**
 * Builds a dispatcher for one target.
 *
 * Credentials go through `options` for SOCKS5 (undici's SOCKS5 handshake rejects
 * a percent-encoded userinfo string) and through the `proxy-authorization`
 * header for HTTP/HTTPS proxies, so no password ever appears in a URL.
 */
export function buildDispatcher(target) {
  if (!target || !target.host) return null;
  const { scheme, host, port, username = "", password = "" } = target;
  const authenticated = Boolean(username || password);
  if (scheme === "socks5") {
    return new Socks5ProxyAgent(`socks5://${host}:${port}`, authenticated ? { username, password } : {});
  }
  const uri = `${scheme === "https" ? "https" : "http"}://${host}:${port}`;
  return new ProxyAgent(authenticated ? { uri, token: basicToken(username, password) } : { uri });
}

function closeQuietly(dispatcher) {
  if (!dispatcher || typeof dispatcher.close !== "function") return;
  Promise.resolve(dispatcher.close()).catch(() => {});
}

/**
 * Reads whatever the mode needs, then derives the resolved target.
 *
 * Shared by the live runtime and the "test connection" endpoint so both judge a
 * configuration by exactly the same rules.
 */
export async function resolveForConfig(proxy, { systemRead } = {}) {
  const mode = proxy?.mode ?? "off";
  const read = mode === "system" ? systemRead ?? (await readWindowsSystemProxy()) : null;
  const resolved = resolveProxyTarget(proxy, read);
  return { resolved, systemRead: read };
}

/**
 * Applies a configuration to the running process.
 *
 * Returns the new state. On a build failure the previous dispatcher and its
 * exception list are kept untouched, and only the reason is updated.
 */
export async function applyProxyConfig(config, { systemRead } = {}) {
  const proxy = config?.proxy ?? {};
  let resolved;
  let read;
  try {
    ({ resolved, systemRead: read } = await resolveForConfig(proxy, { systemRead }));
  } catch (error) {
    // A registry read that threw rather than reported is still a failure to
    // explain, not a reason to go direct.
    state = {
      ...state,
      mode: proxy?.mode ?? "off",
      reason: "read-failed",
      notes: [error?.message || String(error)],
    };
    return describeActive();
  }

  // Redacted at the boundary: the registry value is passed through
  // `describeSystemProxy` before it is ever kept, so a credential embedded in
  // `ProxyServer` cannot reach the settings API.
  const system = read
    ? { ...describeSystemProxy(read.snapshot), available: read.available, error: read.error }
    : null;

  if (!resolved.target) {
    const previous = state.dispatcher;
    closeQuietly(previous);
    state = {
      mode: resolved.source,
      source: resolved.source,
      dispatcher: null,
      target: null,
      noProxy: resolved.noProxy,
      reason: resolved.reason,
      notes: resolved.notes,
      system,
      systemReadError: read?.available === false ? read.error : null,
    };
    return describeActive();
  }

  let dispatcher;
  try {
    dispatcher = buildDispatcher(resolved.target);
  } catch (error) {
    state = {
      ...state,
      mode: resolved.source,
      reason: "build-failed",
      notes: [redactBuildError(error)],
      system,
    };
    return describeActive();
  }

  const previous = state.dispatcher;
  state = {
    mode: resolved.source,
    source: resolved.source,
    dispatcher,
    target: resolved.target,
    noProxy: resolved.noProxy,
    reason: null,
    notes: resolved.notes,
    system,
    systemReadError: read?.available === false ? read.error : null,
  };
  if (previous && previous !== dispatcher) closeQuietly(previous);
  return describeActive();
}

/** The dispatcher in use, or null when requests go direct. */
export function getDispatcher() {
  return state.dispatcher ?? null;
}

/**
 * The dispatcher for one URL: the configured proxy, or null when the host is
 * exempt. A null dispatcher means "use undici's default", which is direct.
 */
export function getDispatcherFor(url) {
  if (!state.dispatcher) return null;
  if (isExcluded(url, state.noProxy)) return null;
  return state.dispatcher;
}

/**
 * A secret-free snapshot for the settings API.
 *
 * `hasCredentials` is a boolean on purpose: the panel must be able to say
 * "已设置账号" without the username or password ever leaving the daemon.
 */
export function describeActive() {
  const target = state.target;
  return {
    mode: state.mode,
    scheme: target?.scheme ?? "http",
    host: target?.host ?? "",
    port: target?.port ?? 0,
    hasCredentials: Boolean(target?.username || target?.password),
    noProxy: state.noProxy.join(","),
    source: state.source,
    active: Boolean(state.dispatcher),
    reason: state.reason ?? null,
    reasonText: state.reason ? PROXY_REASON_TEXT[state.reason] ?? null : null,
    notes: state.notes ?? [],
    system: state.system ?? null,
    systemReadError: state.systemReadError ?? null,
  };
}

/** Builds a candidate dispatcher without touching the live one. For tests/probes. */
export async function buildCandidateDispatcher(proxy, { systemRead } = {}) {
  const { resolved, systemRead: read } = await resolveForConfig(proxy, { systemRead });
  let dispatcher = null;
  let error = null;
  if (resolved.target) {
    try {
      dispatcher = buildDispatcher(resolved.target);
    } catch (buildError) {
      error = redactBuildError(buildError);
    }
  }
  return { resolved, systemRead: read, dispatcher, error };
}

/** Test seam: restores the initial direct-connection state. */
export function resetProxyRuntime() {
  closeQuietly(state.dispatcher);
  state = {
    mode: "off",
    source: "off",
    dispatcher: null,
    target: null,
    noProxy: [],
    reason: "off",
    notes: [],
    system: null,
    systemReadError: null,
  };
}