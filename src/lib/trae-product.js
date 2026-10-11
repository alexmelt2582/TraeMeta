import fs from "node:fs/promises";
import path from "node:path";

import { parseIcubesValue } from "./trae-crypto.js";
import { isDeviceIdentity, mintDeviceIdentity } from "./device-identity.js";
import { normalizeEmail } from "./trae-storage.js";

const DEFAULT_CLIENT_ID = "ono9krqynydwx5";
const DEFAULT_APP_VERSION = "3.5.54";

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

async function readJson(filePath, required = false) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (!required && error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readProductInfo(exePath) {
  if (!exePath) return {};
  const productPath = path.join(path.dirname(exePath), "resources", "app", "product.json");
  const root = await readJson(productPath);
  if (!root) return {};
  const appType = firstString(root.quality, "stable").toLowerCase();
  const authConfig = root.iCubeApp?.authConfig?.TRAE || {};
  return {
    clientId: firstString(authConfig[appType], authConfig.stable, ...Object.values(authConfig)),
    pluginVersion: firstString(root.tronBuildVersion, root.buildVersion, root.productVersion),
    appVersion: firstString(root.appVersion, root.productVersion, root.version),
    appType,
    // The merged client serves its account API from `bootConfig.iCube.normal`;
    // `bootConfig.account.trae.normal` is the older SOLO-era host and stays only
    // as a fallback for a product.json that predates the merge.
    accountApi: firstString(
      root.bootConfig?.iCube?.normal,
      root.bootConfig?.iCube?.NORMAL,
      root.bootConfig?.account?.trae?.normal,
      root.bootConfig?.account?.trae?.NORMAL,
      "https://api.trae.cn",
    ),
    authDomain: "www.trae.cn",
  };
}

function getStorageString(storageRoot, key) {
  const value = storageRoot?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseAuthIdentity(storageRoot) {
  const raw = storageRoot?.["iCubeAuthInfo://icube.cloudide"];
  if (typeof raw !== "string") return {};
  try {
    const auth = parseIcubesValue(raw);
    return {
      userId: firstString(auth?.userId, auth?.user_id, auth?.uid),
      email: normalizeEmail(firstString(auth?.email, auth?.account?.email)),
      nickname: firstString(auth?.nickname, auth?.account?.username, auth?.account?.name),
    };
  } catch {
    return {};
  }
}

export async function collectLoginContext({ exePath, storageRoot, deviceIdentity = null }) {
  const product = await readProductInfo(exePath);
  const authIdentity = parseAuthIdentity(storageRoot);
  // Reuse the account's fixed identity when one is provided, otherwise mint a
  // fresh one now so the whole login (URL + exchange) advertises one identity.
  const identity = isDeviceIdentity(deviceIdentity) ? deviceIdentity : mintDeviceIdentity();
  const appVersion = firstString(product.appVersion, product.pluginVersion, DEFAULT_APP_VERSION);

  return {
    clientId: product.clientId || DEFAULT_CLIENT_ID,
    pluginVersion: firstString(product.pluginVersion, getStorageString(storageRoot, "iCubeLastVersion"), "local"),
    appVersion,
    appType: product.appType || "stable",
    accountApi: product.accountApi || "https://api.trae.cn",
    authDomain: product.authDomain || "www.trae.cn",
    machineId: identity.machineId,
    deviceId: identity.deviceId,
    deviceName: identity.deviceName,
    deviceBrand: identity.deviceBrand,
    deviceType: identity.deviceType,
    osVersion: identity.osVersion,
    keyPair: {
      privateKeyPEM: identity.privateKeyPEM,
      publicKeyPEM: identity.publicKeyPEM,
    },
    env: getStorageString(storageRoot, "ai_assistant.request.env") || "",
    identity: {
      userId: firstString(authIdentity.userId),
      email: firstString(authIdentity.email),
      nickname: firstString(authIdentity.nickname),
    },
  };
}

export function buildDeviceInfo(context, publicKeyPem) {
  return {
    DeviceID: context.deviceId,
    MachineID: context.machineId,
    PlatformCode: "IDE_PC",
    DeviceType: "PC",
    DeviceName: context.deviceName,
    DeviceModel: context.deviceBrand,
    ClientVersion: context.appVersion,
    DevicePublicKey: publicKeyPem,
    DeviceBrand: context.deviceBrand,
    DeviceCPU: "",
    OSInfo: context.deviceType,
    OSVersion: context.osVersion,
  };
}
