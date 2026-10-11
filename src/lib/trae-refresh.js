import crypto from "node:crypto";

import { pickNumber, pickString, requestJson, safeRemoteError } from "./http.js";
import { readDeviceIdentity } from "./device-identity.js";
import { shouldRotateCredentials } from "./trae-keepalive.js";
import { encryptIcubesValue, parseIcubesValue } from "./trae-crypto.js";
import {
  fetchTraeAccountInsights,
  TraeInsightsAuthError,
} from "./trae-insights.js";
import { normalizeEmail, traeStorageKeys } from "./trae-storage.js";

const CLIENT_ID = "ono9krqynydwx5";
const EXCHANGE_PATH = "/trae/api/v3/oauth/ExchangeToken";
const LEGACY_EXCHANGE_PATH = "/cloudide/api/v3/trae/oauth/ExchangeToken";
const USER_INFO_PATH = "/cloudide/api/v3/trae/GetUserInfo";

function normalize(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeIsoTimestamp(value, fallback) {
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 10_000_000_000 ? value : value * 1000;
    return new Date(milliseconds).toISOString();
  }
  return fallback;
}

function findAuthKey(snapshot) {
  return Object.keys(snapshot.keys).find(
    (key) =>
      key.startsWith(traeStorageKeys.AUTH_PREFIX) &&
      key !== traeStorageKeys.USERTAG_KEY &&
      !key.startsWith(traeStorageKeys.DEVICE_PREFIX),
  );
}

/** Reads the decoded auth record of a snapshot without mutating it. */
export function readAuthFromSnapshot(snapshot) {
  const authKey = findAuthKey(snapshot);
  return authKey ? parseIcubesValue(snapshot.keys[authKey]) : null;
}

/**
 * Rotates credentials only when the saved expiry says they need it.
 *
 * Switching accounts used to exchange unconditionally, which invalidated every
 * other device holding the same refresh-token chain. Reusing a credential with
 * days left is safe and is the whole point of the expiry policy; a 401 later in
 * the consuming path still triggers one explicit rotation.
 */
export async function refreshAuthSnapshotIfNeeded(snapshot, { now = Date.now() } = {}) {
  const auth = readAuthFromSnapshot(snapshot);
  if (!shouldRotateCredentials(auth, { now })) {
    return {
      snapshot,
      auth,
      profile: null,
      refreshedToken: false,
    };
  }
  const refreshed = await refreshAuthSnapshot(snapshot);
  return {
    ...refreshed,
    refreshedToken: true,
  };
}

function resolveHost(auth) {
  const raw = normalize(auth.loginHost) || normalize(auth.host) || "https://api.trae.cn";
  return /^https?:\/\//i.test(raw) ? raw.replace(/\/$/, "") : `https://${raw}`;
}

function resolveDeviceKeyPair(snapshot, auth) {
  const direct = auth.deviceKeyPair;
  if (normalize(direct?.privateKeyPEM) && normalize(direct?.publicKeyPEM)) {
    return {
      privateKeyPEM: direct.privateKeyPEM,
      publicKeyPEM: direct.publicKeyPEM,
    };
  }
  const deviceKey = Object.keys(snapshot.keys).find((key) =>
    key.startsWith(traeStorageKeys.DEVICE_PREFIX),
  );
  if (!deviceKey) return null;
  const decoded = parseIcubesValue(snapshot.keys[deviceKey]);
  if (!normalize(decoded?.privateKeyPEM) || !normalize(decoded?.publicKeyPEM)) return null;
  return {
    privateKeyPEM: decoded.privateKeyPEM,
    publicKeyPEM: decoded.publicKeyPEM,
  };
}

function buildDeviceProof(refreshToken, privateKeyPEM, clientId) {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString("hex");
  const message = [
    "POST",
    EXCHANGE_PATH,
    clientId,
    refreshToken,
    String(timestamp),
    nonce,
  ].join("\n");
  const signature = crypto.sign("sha256", Buffer.from(message), privateKeyPEM);
  return {
    Signature: signature.toString("base64"),
    Timestamp: timestamp,
    Nonce: nonce,
  };
}

function updateAuthFromExchange(auth, response, host, clientId) {
  const result = response?.Result || response?.result || response?.data || response;
  const accessToken = pickString(result, [
    ["Token"],
    ["accessToken"],
    ["access_token"],
    ["token"],
  ]);
  if (!accessToken) throw new Error("ExchangeToken response did not include an access token");

  const refreshToken = pickString(result, [
    ["RefreshToken"],
    ["refreshToken"],
    ["refresh_token"],
  ]);
  const expiresAt = pickNumber(result, [
    ["TokenExpireAt"],
    ["expiresAt"],
    ["expiredAt"],
    ["expires_at"],
  ]);
  const refreshExpiresAt = pickNumber(result, [
    ["RefreshExpireAt"],
    ["refreshExpiredAt"],
    ["refreshExpiresAt"],
  ]);
  const now = new Date().toISOString();

  auth.accessToken = accessToken;
  auth.token = accessToken;
  if (refreshToken) auth.refreshToken = refreshToken;
  auth.host = host;
  auth.loginHost = host;
  auth.apiHost = host;
  auth.authClientId = clientId;
  if (expiresAt) {
    auth.expiredAt = normalizeIsoTimestamp(expiresAt, now);
    auth.expiresAt = expiresAt;
  }
  if (refreshExpiresAt) {
    auth.refreshExpiredAt = normalizeIsoTimestamp(refreshExpiresAt, auth.expiredAt);
  }
  auth.exchangeResponse = {
    ...response,
    host,
    loginHost: host,
  };
  return auth;
}

async function requestExchange(clientId, host, accessToken, refreshToken, deviceInfo, deviceProof) {
  const url = `${host}${EXCHANGE_PATH}`;
  const commonHeaders = {
    "user-agent": "Trae/1.0.0 antigravity-cockpit-tools",
    authorization: `Bearer ${accessToken}`,
    "x-cloudide-token": accessToken,
  };

  const official = await requestJson(url, {
    body: {
      ClientID: clientId,
      ClientSecret: "",
      RefreshToken: refreshToken,
      DeviceInfo: deviceInfo,
      DeviceProof: deviceProof,
      IDEVersion: deviceInfo.ClientVersion,
    },
    headers: commonHeaders,
  });
  if (official.ok) {
    const token = pickString(official.json, [
      ["Result", "Token"],
      ["Result", "accessToken"],
      ["Token"],
      ["accessToken"],
    ]);
    if (token) return official.json;
  }

  const fallback = await requestJson(`${host}${LEGACY_EXCHANGE_PATH}`, {
    body: {
      ClientID: clientId,
      RefreshToken: refreshToken,
      ClientSecret: "-",
      UserID: "",
      refreshToken,
      refresh_token: refreshToken,
      token: accessToken,
    },
    headers: commonHeaders,
  });
  if (!fallback.ok) {
    const officialError = official.ok ? "response missing access token" : safeRemoteError(official);
    throw new Error(
      `ExchangeToken failed: official=${officialError}; legacy=${safeRemoteError(fallback)}`,
    );
  }
  return fallback.json;
}

async function requestProfile(host, accessToken) {
  const response = await requestJson(`${host}${USER_INFO_PATH}`, {
    body: {},
    headers: {
      authorization: `Bearer ${accessToken}`,
      "x-cloudide-token": accessToken,
    },
  });
  if (!response.ok) throw new Error(safeRemoteError(response));
  return response.json;
}

export async function refreshAuthSnapshot(snapshot) {
  const normalized = structuredClone(snapshot);
  const authKey = findAuthKey(normalized);
  if (!authKey) throw new Error("Snapshot does not contain a user auth key");

  const auth = parseIcubesValue(normalized.keys[authKey]);
  const refreshToken = normalize(auth.refreshToken);
  const accessToken = normalize(auth.accessToken) || normalize(auth.token);
  const keyPair = resolveDeviceKeyPair(normalized, auth);
  if (!refreshToken) throw new Error("Trae refresh token is missing");
  if (!accessToken) throw new Error("Trae access token is missing");
  if (!keyPair) throw new Error("Trae device key pair is missing");

  const host = resolveHost(auth);
  const clientId = normalize(auth.authClientId) || CLIENT_ID;
  // Rebuild the device info from the account's fixed identity when available so
  // refresh advertises the same fingerprint as login; fall back to the deviceInfo
  // captured at first login otherwise.
  const identity = readDeviceIdentity(normalized);
  const deviceInfo = {
    DeviceID: identity?.deviceId ?? auth.deviceInfo?.DeviceID,
    MachineID: identity?.machineId ?? auth.deviceInfo?.MachineID,
    PlatformCode: auth.deviceInfo?.PlatformCode ?? "IDE_PC",
    DeviceType: auth.deviceInfo?.DeviceType ?? identity?.deviceType ?? "PC",
    DeviceName: identity?.deviceName ?? auth.deviceInfo?.DeviceName,
    DeviceModel: identity?.deviceBrand ?? auth.deviceInfo?.DeviceModel,
    ClientVersion: auth.deviceInfo?.ClientVersion,
    DevicePublicKey: keyPair.publicKeyPEM,
    DeviceBrand: identity?.deviceBrand ?? auth.deviceInfo?.DeviceBrand,
    DeviceCPU: auth.deviceInfo?.DeviceCPU ?? "",
    OSInfo: identity?.deviceType ?? auth.deviceInfo?.OSInfo,
    OSVersion: identity?.osVersion ?? auth.deviceInfo?.OSVersion,
  };
  const deviceProof = buildDeviceProof(refreshToken, keyPair.privateKeyPEM, clientId);
  const response = await requestExchange(
    clientId,
    host,
    accessToken,
    refreshToken,
    deviceInfo,
    deviceProof,
  );
  updateAuthFromExchange(auth, response, host, clientId);

  let profile = null;
  try {
    profile = await requestProfile(host, auth.accessToken);
  } catch {
    profile = null;
  }
  const profileRoot = profile?.Result || profile;
  if (profileRoot && auth.account && typeof auth.account === "object") {
    const profileUserId = pickString(profileRoot, [
      ["UserID"],
      ["userId"],
      ["user_id"],
      ["uid"],
    ]);
    const profileEmail = normalizeEmail(
      pickString(profileRoot, [
        ["NonPlainTextEmail"],
        ["Email"],
        ["email"],
      ]),
    );
    const profileName = pickString(profileRoot, [
      ["ScreenName"],
      ["Nickname"],
      ["nickname"],
      ["Name"],
      ["name"],
    ]);
    if (profileUserId) auth.account.userId = profileUserId;
    if (profileEmail) auth.account.email = profileEmail;
    if (profileName) auth.account.username = profileName;
  }

  normalized.keys[authKey] = encryptIcubesValue(auth);
  return {
    snapshot: normalized,
    auth,
    profile,
  };
}

export async function refreshAccountKeepalive(snapshot, { now = Date.now() } = {}) {
  let { snapshot: current, auth, profile, refreshedToken } =
    await refreshAuthSnapshotIfNeeded(snapshot, { now });

  let insights = null;
  let insightsError = null;
  try {
    insights = await fetchTraeAccountInsights(current);
  } catch (error) {
    if (error instanceof TraeInsightsAuthError && !refreshedToken) {
      const rotated = await refreshAuthSnapshot(current);
      current = rotated.snapshot;
      auth = rotated.auth;
      profile = rotated.profile;
      refreshedToken = true;
      try {
        insights = await fetchTraeAccountInsights(current);
      } catch (retryError) {
        insightsError = retryError.message || String(retryError);
      }
    } else {
      insightsError = error.message || String(error);
    }
  }

  return {
    snapshot: current,
    auth,
    profile,
    insights,
    insightsError,
    refreshedToken,
  };
}

export async function refreshAccountInsights(snapshot) {
  try {
    return {
      snapshot,
      insights: await fetchTraeAccountInsights(snapshot),
      refreshedToken: false,
    };
  } catch (error) {
    if (!(error instanceof TraeInsightsAuthError)) throw error;
  }

  const refreshed = await refreshAuthSnapshot(snapshot);
  return {
    snapshot: refreshed.snapshot,
    insights: await fetchTraeAccountInsights(refreshed.snapshot),
    refreshedToken: true,
  };
}
