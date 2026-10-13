import path from "node:path";

import { APP_ROOT } from "./lib/app-paths.js";

export const APP_NAME = "Trae Meta";
export const APP_VERSION = "2.0.3";
export const PROJECT_ROOT = APP_ROOT;

/**
 * Where this project publishes its releases.
 *
 * Written as a constant rather than read from `package.json` or `git remote`:
 * the shipped build is a Node single-executable application with no repository
 * next to it and no git metadata to consult at run time.
 */
export const GITHUB_REPO = "alexmelt2582/TraeMeta";

export const DEFAULT_CDP_PORT = 9337;
export const DEFAULT_UI_PORT = 47837;
export const LOOPBACK_HOST = "127.0.0.1";

export const DEFAULT_TRAE_EXE =
  process.env.TRAEMETA_ENHANCER_TRAE_EXE ||
  path.join(
    process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local"),
    "Programs",
    "Trae CN",
    "Trae CN.exe",
  );

export const DEFAULT_TRAE_USER_DATA_DIR =
  process.env.TRAEMETA_ENHANCER_USER_DATA_DIR ||
  path.join(
    process.env.APPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Roaming"),
    "Trae CN",
  );

export const DEFAULT_STORAGE_PATH = path.join(
  DEFAULT_TRAE_USER_DATA_DIR,
  "User",
  "globalStorage",
  "storage.json",
);

export const DEFAULT_DATA_DIR =
  process.env.TRAEMETA_ENHANCER_DATA_DIR || path.join(PROJECT_ROOT, "data");

export function parsePort(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
}
