/**
 * Resolves where the application lives, in both supported shapes:
 *
 * - source mode: the repository root, derived from this module's own URL;
 * - bundled/portable mode: injected by the build through the
 *   `__APP_BUNDLE_ROOT__` define, which the CJS bundle maps to `__dirname`
 *   (inside a single executable that is the executable's own folder).
 *
 * `import.meta` is only reachable in source mode. The bundle replaces it with
 * an empty object, so `moduleRelativeRoot` must never run in a bundled build.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const injectedRoot =
  typeof __APP_BUNDLE_ROOT__ === "string" && __APP_BUNDLE_ROOT__.trim()
    ? __APP_BUNDLE_ROOT__.trim()
    : null;

export const IS_BUNDLED = injectedRoot !== null;

function moduleRelativeRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function resolveAppRoot() {
  const fromEnv = process.env.TRAEMETA_ENHANCER_APP_ROOT;
  if (typeof fromEnv === "string" && fromEnv.trim()) return path.resolve(fromEnv.trim());
  if (injectedRoot) return path.resolve(injectedRoot);
  return moduleRelativeRoot();
}

export const APP_ROOT = resolveAppRoot();
export const SRC_DIR = path.join(APP_ROOT, "src");
export const UI_INJECT_PATH = path.join(SRC_DIR, "ui", "inject.js");
export const DAEMON_ENTRY_PATH = path.join(SRC_DIR, "daemon.js");
export const LAUNCHER_ENTRY_PATH = path.join(SRC_DIR, "launcher.js");
export const WATCHDOG_ENTRY_PATH = path.join(APP_ROOT, "scripts", "watchdog.js");
export const SERVICE_ENTRY_PATH = path.join(APP_ROOT, "scripts", "service.js");
export const TRAY_SCRIPT_PATH = path.join(APP_ROOT, "scripts", "tray.ps1");
