/**
 * Loads the product icon that the tray host shows.
 *
 * Source mode reads `assets/icon.ico` from disk. A single-executable build
 * embeds the same file as a SEA asset instead, because a bundled executable has
 * no neighbouring files to read from — the same reason `inject.js` is embedded.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { APP_ROOT } from "./app-paths.js";
import { detectSeaApi } from "./inject-source.js";

export const APP_ICON_ASSET_KEY = "icon.ico";
export const APP_ICON_SOURCE_PATH = path.join(APP_ROOT, "assets", "icon.ico");

export async function loadAppIcon({
  fallbackPath = APP_ICON_SOURCE_PATH,
  assetKey = APP_ICON_ASSET_KEY,
  seaApi,
} = {}) {
  const sea = seaApi ?? (await detectSeaApi());
  if (sea.inSea) {
    if (!sea.getAsset) {
      throw new Error("This build is a single executable but exposes no SEA assets");
    }
    try {
      return Buffer.from(sea.getAsset(assetKey));
    } catch (error) {
      throw new Error(`The embedded application icon "${assetKey}" is missing: ${error.message}`);
    }
  }
  return await fs.readFile(fallbackPath);
}