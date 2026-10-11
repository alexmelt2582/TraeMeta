import crypto from "node:crypto";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { pickNumber, pickString, requestJson, safeRemoteError } from "./http.js";
import { readJsonFile } from "./json-file.js";
import { encryptIcubesValue } from "./trae-crypto.js";
import { buildDeviceInfo, collectLoginContext } from "./trae-product.js";
import { deviceIdentityRecord, readDeviceIdentity } from "./device-identity.js";
import { normalizeEmail, traeStorageKeys } from "./trae-storage.js";

const CALLBACK_PATH = "/authorize";
const AUTHORIZATION_PATH = "/authorization";
const EXCHANGE_PATH = "/trae/api/v3/oauth/ExchangeToken";
const USER_INFO_PATH = "/cloudide/api/v3/trae/GetUserInfo";
const GUIDANCE_PATH = "/cloudide/api/v3/trae/GetLoginGuidance";
const DEFAULT_LOGIN_HOST = "https://www.trae.cn";
const ACCOUNT_API_ORIGINS = [
  "https://api.trae.cn",
  "https://api.trae.com.cn",
  "https://www.trae.cn",
];
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;
const RETENTION_MS = 10 * 60 * 1000;
const execFileAsync = promisify(execFile);

function normalize(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeLoginHost(value) {
  const raw = normalize(value) || DEFAULT_LOGIN_HOST;
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, "")}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function callbackPage({ tone, title, message, redirect = "" }) {
  const color = tone === "success" ? "#22a06b" : tone === "error" ? "#ef4444" : "#4d7cfe";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Trae Meta</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      background: #111318;
      color: #f2f4f8;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(480px, 100%);
      padding: 30px;
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 14px;
      background: #1b1e25;
      box-shadow: 0 24px 70px rgba(0,0,0,.38);
    }
    .badge {
      display: inline-flex;
      padding: 6px 10px;
      border-radius: 999px;
      color: ${color};
      background: color-mix(in srgb, ${color} 14%, transparent);
      font-size: 12px;
      font-weight: 700;
    }
    h1 { margin: 18px 0 10px; font-size: 24px; letter-spacing: 0; }
    p { margin: 0; color: #a8afbd; font-size: 14px; line-height: 1.7; }
    footer { margin-top: 22px; color: #747c8c; font-size: 12px; }
  </style>
</head>
<body>
  <main>
    <div class="badge">${escapeHtml(title)}</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    <footer>Trae Meta 本地回调服务</footer>
  </main>
  ${redirect}
</body>
</html>`;
}

function sendHtml(response, status, html) {
  const body = Buffer.from(html, "utf8");
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  response.end(body);
}

function generatePkcePair() {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function appendQuery(parts, key, value, encode = true) {
  const text = value === null || value === undefined ? "" : String(value);
  parts.push(`${key}=${encode ? encodeURIComponent(text) : text}`);
}

export function buildVerificationUri(context, callbackUrl, loginTraceId, codeChallenge, loginHost) {
  const url = new URL(normalizeLoginHost(loginHost));
  url.pathname = AUTHORIZATION_PATH;
  url.search = "";
  url.hash = "";

  const parts = [];
  appendQuery(parts, "login_version", "1", false);
  // The merged client is a full IDE, not the old SOLO_Lite workspace: the real
  // client emits auth_from="trae", and a mismatched source is rejected.
  appendQuery(parts, "auth_from", "trae", false);
  appendQuery(parts, "login_channel", "native_ide", false);
  appendQuery(parts, "plugin_version", context.pluginVersion);
  appendQuery(parts, "auth_type", "local", false);
  appendQuery(parts, "client_id", context.clientId, false);
  appendQuery(parts, "redirect", "0", false);
  appendQuery(parts, "login_trace_id", loginTraceId);
  appendQuery(parts, "auth_callback_url", callbackUrl, false);
  appendQuery(parts, "machine_id", context.machineId);
  appendQuery(parts, "device_id", context.deviceId);
  appendQuery(parts, "x_device_id", context.deviceId);
  appendQuery(parts, "x_machine_id", context.machineId);
  appendQuery(parts, "x_device_brand", context.deviceBrand);
  appendQuery(parts, "x_device_type", context.deviceType);
  appendQuery(parts, "x_os_version", context.osVersion);
  appendQuery(parts, "x_env", context.env);
  appendQuery(parts, "x_app_version", context.appVersion);
  appendQuery(parts, "x_app_type", context.appType);
  appendQuery(parts, "code_challenge", codeChallenge);
  appendQuery(parts, "code_challenge_method", "S256", false);
  appendQuery(parts, "hide_saas_login", "true", false);
  url.search = parts.join("&");
  return url.toString();
}

export function extractAuthCode(params) {
  for (const key of ["authCode", "auth_code", "AuthCode", "authorization_code", "code"]) {
    const value = normalize(params.get(key));
    if (value) return value;
  }
  const raw = normalize(params.get("authCodeInfo"));
  if (!raw) return null;
  let info;
  try {
    info = JSON.parse(raw);
  } catch {
    throw new Error("Trae authCodeInfo is not valid JSON");
  }
  const code = pickString(info, [
    ["AuthCode"],
    ["authCode"],
    ["auth_code"],
    ["code"],
    ["Result", "AuthCode"],
  ]);
  const expireAt = pickNumber(info, [
    ["ExpireAt"],
    ["expireAt"],
    ["expiresAt"],
    ["Result", "ExpireAt"],
  ]);
  if (expireAt && expireAt <= Date.now()) throw new Error("Trae authorization code has expired");
  return code;
}

function decodeJwtPayload(token) {
  try {
    const payload = String(token).split(".")[1];
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function normalizeExpiry(value) {
  if (!value) return null;
  const milliseconds = value > 10_000_000_000 ? value : value * 1000;
  return new Date(milliseconds).toISOString();
}

function buildIdentity(userInfo, callbackInfo, accessToken) {
  const jwt = decodeJwtPayload(accessToken);
  const roots = [userInfo, callbackInfo, jwt].filter(Boolean);
  const pick = (paths) => {
    for (const root of roots) {
      const value = pickString(root, paths);
      if (value) return value;
    }
    return null;
  };
  return {
    userId: pick([
      ["Result", "UserID"],
      ["Result", "userId"],
      ["Result", "UID"],
      ["result", "userId"],
      ["data", "id"],
      ["data", "userId"],
      ["userId"],
      ["UserID"],
      ["uid"],
    ]),
    email: normalizeEmail(
      pick([
        ["Result", "NonPlainTextEmail"],
        ["Result", "Email"],
        ["Result", "email"],
        ["NonPlainTextEmail"],
        ["data", "email"],
        ["email"],
      ]),
    ),
    nickname: pick([
      ["Result", "ScreenName"],
      ["Result", "Nickname"],
      ["Result", "nickname"],
      ["Result", "Name"],
      ["data", "nickname"],
      ["nickname"],
      ["name"],
    ]),
    phone: pick([
      ["Result", "NonPlainTextMobile"],
      ["Result", "Mobile"],
      ["Result", "phone"],
      ["data", "phone"],
      ["phone"],
      ["mobile"],
    ]),
  };
}

async function requestLoginGuidance(loginTraceId, accountApi) {
  const origins = [...new Set([accountApi, ...ACCOUNT_API_ORIGINS].filter(Boolean))];
  let lastError = null;
  for (const origin of origins) {
    try {
      const response = await requestJson(`${origin}${GUIDANCE_PATH}`, {
        body: { loginTraceID: loginTraceId, login_trace_id: loginTraceId },
        headers: { "user-agent": "Trae Meta/0.1" },
      });
      if (!response.ok) {
        lastError = safeRemoteError(response);
        continue;
      }
      const host = pickString(response.json, [
        ["Result", "LoginHost"],
        ["Result", "loginHost"],
        ["Result", "LoginURL"],
        ["result", "loginHost"],
        ["LoginHost"],
        ["loginHost"],
      ]);
      if (host) return normalizeLoginHost(host);
      lastError = "LoginGuidance response did not include LoginHost";
    } catch (error) {
      lastError = error.message;
    }
  }
  if (lastError) {
    // CN has a stable public fallback; do not block login on guidance availability.
  }
  return DEFAULT_LOGIN_HOST;
}

async function exchangeAuthCode(context, authCode, verifier, userTag, loginHost) {
  // Reuse the account's fixed key pair from the login context instead of minting
  // a fresh device key on every exchange.
  const keyPair = context.keyPair;
  if (!keyPair?.privateKeyPEM || !keyPair?.publicKeyPEM) {
    throw new Error("TRAE login context is missing a device key pair");
  }
  const deviceInfo = buildDeviceInfo(context, keyPair.publicKeyPEM);
  const origins = [...new Set([loginHost, context.accountApi, ...ACCOUNT_API_ORIGINS].filter(Boolean))];
  let lastError = null;

  for (const origin of origins) {
    const requestUrl = new URL(EXCHANGE_PATH, origin).toString();
    try {
      const response = await requestJson(requestUrl, {
        body: {
          ClientID: context.clientId,
          AuthCode: authCode,
          CodeVerifier: verifier,
          DeviceInfo: deviceInfo,
          IDEVersion: context.appVersion,
        },
        headers: { "x-cloudide-token": "" },
      });
      if (!response.ok) {
        lastError = safeRemoteError(response);
        continue;
      }
      const accessToken = pickString(response.json, [
        ["Result", "AccessToken"],
        ["Result", "accessToken"],
        ["Result", "Token"],
        ["result", "accessToken"],
        ["accessToken"],
        ["access_token"],
        ["token"],
      ]);
      if (!accessToken) {
        lastError = "ExchangeToken response did not include an access token";
        continue;
      }
      return {
        origin,
        response: response.json,
        accessToken,
        refreshToken: pickString(response.json, [
          ["Result", "RefreshToken"],
          ["Result", "refreshToken"],
          ["result", "refreshToken"],
          ["refreshToken"],
          ["refresh_token"],
        ]),
        tokenType: pickString(response.json, [
          ["Result", "TokenType"],
          ["result", "tokenType"],
          ["tokenType"],
          ["token_type"],
        ]),
        expiresAt: pickNumber(response.json, [
          ["Result", "TokenExpireAt"],
          ["Result", "expiresAt"],
          ["result", "expiresAt"],
          ["expiresAt"],
          ["expires_at"],
        ]),
        refreshExpiresAt: pickNumber(response.json, [
          ["Result", "RefreshExpireAt"],
          ["result", "refreshExpireAt"],
          ["refreshExpireAt"],
        ]),
        deviceInfo,
        privateKey: keyPair.privateKeyPEM,
        publicKey: keyPair.publicKeyPEM,
      };
    } catch (error) {
      lastError = error.message;
    }
  }
  throw new Error(`TRAE authorization exchange failed: ${lastError || "unknown error"}`);
}

async function requestUserInfo(origin, accessToken) {
  const candidates = [...new Set([origin, ...ACCOUNT_API_ORIGINS].filter(Boolean))];
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const response = await requestJson(new URL(USER_INFO_PATH, candidate).toString(), {
        body: {},
        headers: { "x-cloudide-token": accessToken },
      });
      if (response.ok) return response.json;
      lastError = safeRemoteError(response);
    } catch (error) {
      lastError = error.message;
    }
  }
  throw new Error(lastError || "GetUserInfo failed");
}

function buildStorageRoot(context, exchange, userInfo, callback) {
  const identity = buildIdentity(userInfo, callback.userInfo, exchange.accessToken);
  if (!identity.userId) throw new Error("TRAE login did not return a user id");

  const loginRegion = callback.loginRegion || "cn";
  const accessToken = exchange.accessToken;
  const auth = {
    accessToken,
    token: accessToken,
    refreshToken: exchange.refreshToken || callback.refreshToken || null,
    tokenType: exchange.tokenType || "Bearer",
    expiredAt: normalizeExpiry(exchange.expiresAt),
    expiresAt: exchange.expiresAt,
    refreshExpiredAt: normalizeExpiry(exchange.refreshExpiresAt),
    tokenReleaseAt: new Date().toISOString(),
    host: exchange.origin,
    loginHost: callback.loginHost,
    loginRegion,
    loginTraceID: callback.loginTraceId,
    platformId: "trae_code_cn",
    platformName: "Trae CN",
    authClientId: context.clientId,
    authDomain: context.authDomain,
    apiHost: exchange.origin,
    email: identity.email || null,
    userId: identity.userId,
    callbackQuery: callback.rawQuery,
    exchangeResponse: exchange.response,
    deviceInfo: exchange.deviceInfo,
    deviceKeyPair: {
      privateKeyPEM: exchange.privateKey,
      publicKeyPEM: exchange.publicKey,
    },
    userTag: callback.userTag || null,
    storeRegion: "CN",
    AIRegion: "CN",
    userRegion: {
      region: "cn",
      _aiRegion: "CN",
    },
    account: {
      userId: identity.userId,
      username: identity.nickname || identity.userId,
      email: identity.email || "",
      userTag: callback.userTag || "",
    },
  };

  const userTagMap = identity.userId && callback.userTag ? { [identity.userId]: callback.userTag } : {};
  const serverData = {
    loginHost: callback.loginHost,
    loginRegion,
    loginTraceID: callback.loginTraceId,
    platform: {
      platformId: "trae_code_cn",
      platformName: "Trae CN",
      authClientId: context.clientId,
      authDomain: context.authDomain,
    },
  };

  return {
    identity,
    storageRoot: {
      deviceIdentity: deviceIdentityRecord(context),
      [traeStorageKeys.AUTH_PREFIX + "icube.cloudide"]: encryptIcubesValue(auth),
      [`${traeStorageKeys.DEVICE_PREFIX}${context.deviceId}`]: encryptIcubesValue({
        privateKeyPEM: exchange.privateKey,
        publicKeyPEM: exchange.publicKey,
      }),
      [traeStorageKeys.USERTAG_KEY]: encryptIcubesValue(userTagMap),
      [traeStorageKeys.SERVER_PREFIX + "icube.cloudide"]: JSON.stringify(serverData),
      [traeStorageKeys.ENTITLEMENT_PREFIX + "icube.cloudide"]: JSON.stringify({}),
    },
  };
}

export async function openExternal(url) {
  try {
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-Command", "Start-Process -FilePath $env:TRAEMETA_ENHANCER_OPEN_URL"],
      {
        timeout: 10000,
        windowsHide: true,
        env: { ...process.env, TRAEMETA_ENHANCER_OPEN_URL: url },
      },
    );
    return "powershell";
  } catch {
    try {
      await execFileAsync(
        "cmd.exe",
        ["/d", "/s", "/c", 'start "" "%TRAEMETA_ENHANCER_OPEN_URL%"'],
        {
          timeout: 10000,
          windowsHide: true,
          env: { ...process.env, TRAEMETA_ENHANCER_OPEN_URL: url },
        },
      );
      return "cmd";
    } catch {
      throw new Error("无法调用系统默认浏览器，请点击“重新打开”重试。");
    }
  }
}

export class TraeOAuthManager {
  constructor({
    accountStore,
    storagePath,
    exePath,
    openBrowser = true,
    onAccountSaved = null,
    logger = console,
  }) {
    this.accountStore = accountStore;
    this.storagePath = storagePath;
    this.exePath = exePath;
    this.openBrowser = openBrowser;
    this.onAccountSaved = typeof onAccountSaved === "function" ? onAccountSaved : null;
    this.logger = logger;
    this.sessions = new Map();
  }

  async start() {
    for (const existing of this.sessions.values()) {
      if (existing.status === "pending" || existing.status === "exchanging") {
        existing.status = "cancelled";
        this.closeSessionServer(existing);
      }
    }
    const storageRoot = await readJsonFile(this.storagePath, { required: false });
    // Reuse the currently-active account's fixed device identity when we manage
    // it, so a re-login keeps the same deviceId/machineId/key pair. A brand-new
    // or unmanaged account mints a fresh identity inside collectLoginContext.
    let reusableDeviceIdentity = null;
    try {
      const active = await this.accountStore.resolveActiveAccount(storageRoot);
      if (active && active.state === "matched" && active.id) {
        reusableDeviceIdentity = readDeviceIdentity(await this.accountStore.readSnapshot(active.id));
      }
    } catch {
      reusableDeviceIdentity = null;
    }
    const context = await collectLoginContext({
      exePath: this.exePath,
      storageRoot,
      deviceIdentity: reusableDeviceIdentity,
    });
    const loginId = crypto.randomUUID();
    const loginTraceId = crypto.randomUUID();
    const pkce = generatePkcePair();
    const loginHost = await requestLoginGuidance(loginTraceId, context.accountApi);
    const callbackServer = http.createServer();
    await new Promise((resolve, reject) => {
      callbackServer.once("error", reject);
      callbackServer.listen(0, "127.0.0.1", resolve);
    });
    const callbackPort = callbackServer.address().port;
    const callbackUrl = `http://127.0.0.1:${callbackPort}${CALLBACK_PATH}`;
    const verificationUri = buildVerificationUri(
      context,
      callbackUrl,
      loginTraceId,
      pkce.challenge,
      loginHost,
    );

    const session = {
      loginId,
      loginTraceId,
      context,
      loginHost,
      callbackUrl,
      verificationUri,
      codeVerifier: pkce.verifier,
      status: "pending",
      error: null,
      account: null,
      expiresAt: Date.now() + SESSION_TIMEOUT_MS,
      callbackServer,
      timeout: null,
      finishing: false,
    };
    this.sessions.set(loginId, session);

    callbackServer.on("request", (request, response) => {
      this.handleCallback(session, request, response).catch((error) => {
        sendHtml(
          response,
          500,
          callbackPage({
            tone: "error",
            title: "授权失败",
            message: error.message,
          }),
        );
      });
    });
    session.timeout = setTimeout(() => {
      if (session.status === "pending" || session.status === "exchanging") {
        session.status = "error";
        session.error = "登录授权已超时";
        this.closeSessionServer(session);
      }
    }, SESSION_TIMEOUT_MS);

    let browserOpened = false;
    let browserOpenMethod = null;
    let browserError = null;
    if (this.openBrowser) {
      try {
        browserOpenMethod = await openExternal(verificationUri);
        browserOpened = true;
      } catch (error) {
        browserError = error.message;
        this.logger.error(`[oauth] browser open failed: ${browserError}`);
      }
    }
    this.logger.log(`[oauth] started loginId=${loginId}`);

    return {
      loginId,
      verificationUri,
      expiresAt: session.expiresAt,
      callbackUrl,
      browserOpened,
      browserOpenMethod,
      browserError,
    };
  }

  status(loginId) {
    const session = this.sessions.get(loginId);
    if (!session) return { status: "missing" };
    return {
      status: session.status,
      error: session.error,
      account: session.account,
      expiresAt: session.expiresAt,
    };
  }

  isActive() {
    return [...this.sessions.values()].some(
      (session) =>
        session.status === "pending" ||
        session.status === "exchanging" ||
        session.status === "syncing",
    );
  }

  cancel(loginId) {
    const session = this.sessions.get(loginId);
    if (!session) return false;
    session.status = "cancelled";
    session.error = null;
    this.closeSessionServer(session);
    return true;
  }

  async reopen(loginId) {
    const session = this.sessions.get(loginId);
    if (!session || session.status !== "pending") return false;
    const method = await openExternal(session.verificationUri);
    return { opened: true, method };
  }

  async handleCallback(session, request, response) {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method !== "GET" || requestUrl.pathname !== CALLBACK_PATH) {
      sendHtml(response, 404, callbackPage({ tone: "error", title: "未找到回调", message: "404" }));
      return;
    }
    if (!requestUrl.search && session.status === "pending") {
      const redirect = `<script>
        if (window.location.hash.length > 1) {
          window.location.replace(window.location.origin + window.location.pathname + "?" + window.location.hash.slice(1));
        }
      </script>`;
      sendHtml(
        response,
        200,
        callbackPage({
          tone: "pending",
          title: "正在完成授权",
          message: "浏览器正在把授权结果传回本机。",
          redirect,
        }),
      );
      return;
    }

    const params = requestUrl.searchParams;
    const error = params.get("error") || params.get("error_code");
    if (error) {
      const description = params.get("error_description") || params.get("message") || "";
      session.status = "error";
      session.error = description ? `${error}: ${description}` : error;
      sendHtml(
        response,
        400,
        callbackPage({ tone: "error", title: "授权失败", message: session.error }),
      );
      this.closeSessionServer(session);
      return;
    }

    let authCode;
    try {
      authCode = extractAuthCode(params);
    } catch (errorValue) {
      session.status = "error";
      session.error = errorValue.message;
      sendHtml(
        response,
        400,
        callbackPage({ tone: "error", title: "授权失败", message: session.error }),
      );
      this.closeSessionServer(session);
      return;
    }
    const refreshToken = normalize(params.get("refreshToken") || params.get("refresh_token"));
    if (!authCode && !refreshToken) {
      sendHtml(
        response,
        200,
        callbackPage({
          tone: "pending",
          title: "等待授权结果",
          message: "未检测到授权码，请继续完成浏览器中的登录流程。",
        }),
      );
      return;
    }

    let callbackUserInfo = null;
    const rawUserInfo = params.get("userInfo");
    if (rawUserInfo) {
      try {
        callbackUserInfo = JSON.parse(rawUserInfo);
      } catch {
        callbackUserInfo = null;
      }
    }
    const callback = {
      authCode,
      refreshToken,
      loginHost: normalize(params.get("loginHost") || params.get("host")) || session.loginHost,
      loginRegion: normalize(params.get("loginRegion") || params.get("region")),
      loginTraceId:
        normalize(params.get("loginTraceID") || params.get("login_trace_id")) || session.loginTraceId,
      userTag: normalize(params.get("userTag") || params.get("user_tag")),
      userInfo: callbackUserInfo,
      rawQuery: Object.fromEntries(params.entries()),
    };

    sendHtml(
      response,
      200,
      callbackPage({
        tone: "success",
        title: "授权成功",
        message: "登录信息已传回 Trae Meta，可以关闭此页面。",
      }),
    );
    this.closeSessionServer(session);
    this.finishSession(session, callback).catch(() => {});
  }

  closeSessionServer(session) {
    if (session.timeout) {
      clearTimeout(session.timeout);
      session.timeout = null;
    }
    if (session.callbackServer?.listening) {
      session.callbackServer.close();
    }
  }

  async notifyAccountSaved(account, metadata = {}) {
    if (!this.onAccountSaved) return { ok: true, skipped: "no-hook" };
    try {
      await this.onAccountSaved(account, metadata);
      return { ok: true };
    } catch (error) {
      const message = error.message || String(error);
      this.logger.error(`[oauth] post-login sync failed: ${message}`);
      return { ok: false, error: message };
    }
  }

  async finishSession(session, callback) {
    if (session.finishing || session.status !== "pending") return;
    session.finishing = true;
    session.status = "exchanging";

    try {
      const exchange = await exchangeAuthCode(
        session.context,
        callback.authCode,
        session.codeVerifier,
        callback.userTag,
        callback.loginHost,
      );
      let userInfo = null;
      try {
        userInfo = await requestUserInfo(exchange.origin, exchange.accessToken);
      } catch {
        userInfo = null;
      }
      const { storageRoot, identity } = buildStorageRoot(
        session.context,
        exchange,
        userInfo,
        callback,
      );
      const saved = await this.accountStore.backupCurrent(storageRoot, {
        liveIdentity: identity,
      });
      session.account = saved.account;
      session.status = "syncing";
      const sync = await this.notifyAccountSaved(saved.account, {
        source: "oauth",
        createdSnapshot: saved.createdSnapshot,
      });
      if (!sync.ok && !sync.skipped) session.syncError = sync.error;
      session.status = "complete";
      this.logger.log(`[oauth] completed loginId=${session.loginId}`);
    } catch (error) {
      session.status = "error";
      session.error = error.message || String(error);
      this.logger.error(`[oauth] failed loginId=${session.loginId}: ${session.error}`);
    } finally {
      session.finishing = false;
      setTimeout(() => this.sessions.delete(session.loginId), RETENTION_MS).unref?.();
    }
  }
}
