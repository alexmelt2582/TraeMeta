import { encryptIcubesValue, parseIcubesValue } from "./trae-crypto.js";
import { isDeviceIdentity } from "./device-identity.js";

const AUTH_PREFIX = "iCubeAuthInfo://";
const SERVER_PREFIX = "iCubeServerData://";
const ENTITLEMENT_PREFIX = "iCubeEntitlementInfo://";
const DEVICE_PREFIX = "iCubeAuthInfo://icube-dc:";
const USERTAG_KEY = "iCubeAuthInfo://usertag";

const IDENTITY_KEYS = new Set([
  "userid",
  "user_id",
  "uid",
  "accountid",
  "account_id",
]);
const EMAIL_KEYS = new Set(["email", "nonplaintextemail", "mail"]);
const PHONE_KEYS = new Set(["phone", "mobile", "phonenumber", "nonplaintextmobile"]);
const NAME_KEYS = new Set(["nickname", "displayname", "username", "screenname"]);
const INVALID_EMAIL_VALUES = new Set([
  "unknown",
  "null",
  "undefined",
  "n/a",
  "na",
  "none",
  "-",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value) {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export function normalizeEmail(value) {
  const text = normalizeText(value)?.toLowerCase();
  if (!text || INVALID_EMAIL_VALUES.has(text) || !text.includes("@")) return null;
  return text;
}

function normalizeKey(value) {
  return String(value || "").replace(/[-_\s]/g, "").toLowerCase();
}

function parseJsonString(value) {
  if (typeof value !== "string") return value;
  const text = value.trim();
  try {
    return parseIcubesValue(text);
  } catch {
    return value;
  }
}

function containsNormalizedKey(value, expectedKey, depth = 0) {
  if (depth > 10 || value === null || value === undefined) return false;
  const parsed = parseJsonString(value);
  if (parsed !== value) return containsNormalizedKey(parsed, expectedKey, depth + 1);
  if (Array.isArray(value)) {
    return value.some((item) => containsNormalizedKey(item, expectedKey, depth + 1));
  }
  if (!isObject(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    if (normalizeKey(key) === expectedKey) return true;
    if (containsNormalizedKey(child, expectedKey, depth + 1)) return true;
  }
  return false;
}

function isDeviceKey(key) {
  return key.startsWith(DEVICE_PREFIX);
}

function isUserAuthKey(key) {
  return key.startsWith(AUTH_PREFIX) && !isDeviceKey(key) && key !== USERTAG_KEY;
}

function isManagedAuthKey(key) {
  return (
    isUserAuthKey(key) ||
    isDeviceKey(key) ||
    key === USERTAG_KEY ||
    key.startsWith(SERVER_PREFIX) ||
    key.startsWith(ENTITLEMENT_PREFIX)
  );
}

export function extractAuthSnapshot(storageRoot, { capturedAt = Date.now() } = {}) {
  if (!isObject(storageRoot)) {
    throw new Error("TRAE storage.json must contain a JSON object");
  }

  const keys = {};
  for (const [key, value] of Object.entries(storageRoot)) {
    if (isManagedAuthKey(key)) {
      keys[key] = value;
    }
  }

  const snapshot = {
    schemaVersion: 1,
    platform: "trae_code_cn",
    capturedAt,
    keys,
  };
  if (isDeviceIdentity(storageRoot.deviceIdentity)) {
    snapshot.deviceIdentity = storageRoot.deviceIdentity;
  }
  validateAuthSnapshot(snapshot);
  return snapshot;
}

export function mergeAuthSnapshot(storageRoot, snapshot) {
  if (!isObject(storageRoot)) {
    throw new Error("TRAE storage.json must contain a JSON object");
  }
  validateAuthSnapshot(snapshot);
  const merged = structuredClone(storageRoot);
  for (const key of Object.keys(merged)) {
    if (isManagedAuthKey(key)) delete merged[key];
  }
  Object.assign(merged, structuredClone(snapshot.keys));
  return merged;
}

export function clearManagedAuthKeys(storageRoot) {
  if (!isObject(storageRoot)) {
    throw new Error("TRAE storage.json must contain a JSON object");
  }
  const cleared = structuredClone(storageRoot);
  for (const key of Object.keys(cleared)) {
    if (isManagedAuthKey(key)) delete cleared[key];
  }
  return cleared;
}

function sanitizeEmailFields(value, depth = 0) {
  if (depth > 10 || value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeEmailFields(item, depth + 1));
  }
  if (!isObject(value)) return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (EMAIL_KEYS.has(normalizeKey(key)) && typeof child === "string") {
      result[key] = normalizeEmail(child);
    } else {
      result[key] = sanitizeEmailFields(child, depth + 1);
    }
  }
  return result;
}

export function sanitizeAuthSnapshotEmails(snapshot) {
  validateAuthSnapshot(snapshot);
  const sanitized = structuredClone(snapshot);
  const authKey = Object.keys(sanitized.keys).find(isUserAuthKey);
  if (authKey) {
    try {
      const auth = parseIcubesValue(sanitized.keys[authKey]);
      if (isObject(auth)) {
        let changed = false;
        const rawAuthEmail = normalizeText(auth.email);
        const authEmail = normalizeEmail(rawAuthEmail);
        if (rawAuthEmail && rawAuthEmail !== authEmail) {
          auth.email = authEmail || "";
          changed = true;
        }
        if (isObject(auth.account)) {
          const rawAccountEmail = normalizeText(auth.account.email);
          const accountEmail = normalizeEmail(rawAccountEmail);
          if (rawAccountEmail && rawAccountEmail !== accountEmail) {
            auth.account.email = accountEmail || "";
            changed = true;
          }
        }
        if (changed) sanitized.keys[authKey] = encryptIcubesValue(auth);
      }
    } catch {
      // Leave opaque or legacy values unchanged when they cannot be decoded.
    }
  }

  for (const key of Object.keys(sanitized.keys)) {
    if (!key.startsWith(SERVER_PREFIX) && !key.startsWith(ENTITLEMENT_PREFIX)) continue;
    const raw = sanitized.keys[key];
    if (typeof raw !== "string" || !/^[\s]*[\[{]/.test(raw)) continue;
    try {
      const next = JSON.stringify(sanitizeEmailFields(JSON.parse(raw)));
      if (next !== raw) sanitized.keys[key] = next;
    } catch {
      // Leave non-JSON managed values unchanged.
    }
  }
  return sanitized;
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

export function normalizeAuthSnapshotForInjection(snapshot) {
  validateAuthSnapshot(snapshot);
  const normalized = structuredClone(snapshot);
  const authKey = Object.keys(normalized.keys).find(isUserAuthKey);
  if (!authKey) throw new Error("TRAE snapshot is missing the user authentication key");

  const auth = parseIcubesValue(normalized.keys[authKey]);
  if (!isObject(auth)) throw new Error("TRAE user authentication payload is invalid");

  const account = isObject(auth.account) ? auth.account : {};
  const userId = normalizeText(auth.userId) || normalizeText(account.userId);
  const email = normalizeEmail(auth.email) || normalizeEmail(account.email) || "";
  const nickname = normalizeText(account.username) || email || userId || "TRAE account";
  const userTag = normalizeText(auth.userTag) || normalizeText(account.userTag) || "row";
  const now = new Date().toISOString();

  account.username = nickname;
  account.iss ??= "";
  account.iat ??= 0;
  account.organization ??= "";
  account.work_country ??= "";
  account.email = email;
  account.avatar_url ??= "";
  account.description ??= "";
  account.scope = normalizeText(account.scope) || "marscode";
  account.loginScope = normalizeText(account.loginScope) || "trae";
  account.storeCountryCode ??= "CN";
  account.storeCountrySrc ??= "";
  account.storeRegion = normalizeText(account.storeRegion) || "CN";
  account.userTag = userTag;
  if (userId) account.userId ??= userId;

  auth.token ??= auth.accessToken;
  auth.accessToken ??= auth.token;
  if (userId) auth.userId ??= userId;
  auth.host ??= "https://api.trae.cn";
  auth.loginHost ??= auth.host;
  auth.apiHost ??= auth.host;
  auth.authClientId ??= "ono9krqynydwx5";
  auth.authDomain ??= "www.trae.cn";
  auth.platformId ??= "trae_code_cn";
  auth.platformName ??= "Trae CN";
  auth.storeRegion = normalizeText(auth.storeRegion) || "CN";
  auth.AIRegion = normalizeText(auth.AIRegion) || "CN";
  auth.userTag = userTag;
  auth.expiredAt = normalizeIsoTimestamp(auth.expiredAt, now);
  auth.refreshExpiredAt = normalizeIsoTimestamp(auth.refreshExpiredAt, auth.expiredAt);
  auth.tokenReleaseAt = normalizeIsoTimestamp(auth.tokenReleaseAt, now);
  auth.userRegion = {
    ...(isObject(auth.userRegion) ? auth.userRegion : {}),
    region: normalizeText(auth.userRegion?.region) || "CN",
    _aiRegion: normalizeText(auth.userRegion?._aiRegion) || "CN",
  };
  auth.account = account;
  auth.email = email;

  normalized.keys[authKey] = encryptIcubesValue(auth);
  return normalized;
}

export function validateAuthSnapshot(snapshot) {
  if (!isObject(snapshot) || snapshot.schemaVersion !== 1 || !isObject(snapshot.keys)) {
    throw new Error("Invalid TRAE authentication snapshot");
  }

  const keys = Object.keys(snapshot.keys);
  const hasUserAuth = keys.some(isUserAuthKey);
  const hasDevice = keys.some(isDeviceKey);
  const hasServer = keys.some((key) => key.startsWith(SERVER_PREFIX));
  const hasStandaloneEntitlement = keys.some((key) => key.startsWith(ENTITLEMENT_PREFIX));
  const hasEmbeddedEntitlement = keys
    .filter((key) => key.startsWith(SERVER_PREFIX))
    .some((key) => containsNormalizedKey(snapshot.keys[key], "entitlementinfo"));
  const hasUsertag = Object.hasOwn(snapshot.keys, USERTAG_KEY);

  const missing = [];
  if (!hasUserAuth) missing.push("user authentication");
  if (!hasDevice) missing.push("device key");
  if (!hasServer) missing.push("server data");
  if (!hasStandaloneEntitlement && !hasEmbeddedEntitlement) {
    missing.push("entitlement data");
  }
  if (!hasUsertag) missing.push("usertag");
  if (missing.length) {
    throw new Error(`Incomplete TRAE authentication state: missing ${missing.join(", ")}`);
  }

  if (Object.hasOwn(snapshot, "deviceIdentity") && !isDeviceIdentity(snapshot.deviceIdentity)) {
    throw new Error("TRAE authentication snapshot has an invalid device identity");
  }

  return true;
}

function collectIdentityCandidates(root) {
  const candidates = [];

  function visit(value, pathParts, depth) {
    if (depth > 10 || value === null || value === undefined) return;
    const parsed = parseJsonString(value);
    if (parsed !== value) {
      visit(parsed, pathParts, depth + 1);
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...pathParts, String(index)], depth + 1));
      return;
    }
    if (!isObject(value)) return;

    for (const [key, child] of Object.entries(value)) {
      const nextPath = [...pathParts, key];
      const normalized = normalizeKey(key);
      if (IDENTITY_KEYS.has(normalized)) {
        const text = normalizeText(child);
        if (text && /^\d{6,24}$/.test(text)) {
          candidates.push({ kind: "userId", value: text, path: nextPath.join(".") });
        }
      } else if (EMAIL_KEYS.has(normalized)) {
        const email = normalizeEmail(child);
        if (email) {
          candidates.push({ kind: "email", value: email, path: nextPath.join(".") });
        }
      } else if (PHONE_KEYS.has(normalized)) {
        const text = normalizeText(child);
        if (text) candidates.push({ kind: "phone", value: text, path: nextPath.join(".") });
      } else if (NAME_KEYS.has(normalized)) {
        const text = normalizeText(child);
        if (text) candidates.push({ kind: "nickname", value: text, path: nextPath.join(".") });
      }
      visit(child, nextPath, depth + 1);
    }
  }

  visit(root, [], 0);
  return candidates;
}

function pickIdentityCandidate(candidates, kind, pathHint) {
  const matching = candidates.filter((candidate) => candidate.kind === kind);
  if (!matching.length) return null;
  if (pathHint) {
    const hinted = matching.find((candidate) => candidate.path.toLowerCase().includes(pathHint));
    if (hinted) return hinted.value;
  }
  return matching[0].value;
}

export function extractIdentityFromSnapshot(snapshot) {
  const authKey = Object.keys(snapshot.keys).find(isUserAuthKey);
  let auth = null;
  if (authKey) {
    try {
      auth = parseIcubesValue(snapshot.keys[authKey]);
    } catch {
      auth = null;
    }
  }

  const roots = Object.entries(snapshot.keys)
    .filter(
      ([key]) =>
        key.startsWith(SERVER_PREFIX) ||
        key.startsWith(ENTITLEMENT_PREFIX) ||
        isUserAuthKey(key),
    )
    .map(([, value]) => value);

  const candidates = roots.flatMap(collectIdentityCandidates);
  const account = isObject(auth?.account) ? auth.account : {};
  const authUserId = normalizeText(auth?.userId) || normalizeText(account.userId);
  const authEmail = normalizeEmail(auth?.email) || normalizeEmail(account.email);
  const authNickname =
    normalizeText(account.username) ||
    normalizeText(account.nickname) ||
    normalizeText(auth?.nickname);
  const userId =
    authUserId ||
    pickIdentityCandidate(candidates, "userId", "entitlementbaseinfo") ||
    pickIdentityCandidate(candidates, "userId", "account") ||
    pickIdentityCandidate(candidates, "userId");

  return {
    userId,
    email: authEmail || pickIdentityCandidate(candidates, "email"),
    phone: pickIdentityCandidate(candidates, "phone"),
    nickname: authNickname || pickIdentityCandidate(candidates, "nickname"),
  };
}

export function mergeIdentity(primary, fallback) {
  const result = {};
  for (const key of ["userId", "email", "phone", "nickname"]) {
    result[key] =
      key === "email"
        ? normalizeEmail(primary?.[key]) || normalizeEmail(fallback?.[key]) || null
        : normalizeText(primary?.[key]) || normalizeText(fallback?.[key]) || null;
  }
  return result;
}

export function maskAccountValue(value, { visible = 4 } = {}) {
  const text = normalizeText(value);
  if (!text) return "";
  if (text.includes("@")) {
    const [name, domain] = text.split("@");
    const prefix = name.slice(0, Math.min(2, name.length));
    return `${prefix}***@${domain}`;
  }
  if (text.length <= visible) return "*".repeat(text.length);
  return `${"*".repeat(Math.max(4, text.length - visible))}${text.slice(-visible)}`;
}

export const traeStorageKeys = Object.freeze({
  AUTH_PREFIX,
  SERVER_PREFIX,
  ENTITLEMENT_PREFIX,
  DEVICE_PREFIX,
  USERTAG_KEY,
});
