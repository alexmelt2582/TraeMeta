/**
 * Resolved runtime locations shared by the watchdog, the service CLI, and the
 * build outputs. Keeping them in one module prevents the supervisor and the CLI
 * from disagreeing about where the pid file or the log lives.
 */
import path from "node:path";

import { APP_ROOT } from "./app-paths.js";
import { DEFAULT_DATA_DIR, DEFAULT_UI_PORT, LOOPBACK_HOST, parsePort } from "../constants.js";

export const HOST = LOOPBACK_HOST;
export const UI_PORT = parsePort(process.env.TRAEMETA_ENHANCER_UI_PORT, DEFAULT_UI_PORT);
export const DATA_DIR = process.env.TRAEMETA_ENHANCER_DATA_DIR || DEFAULT_DATA_DIR;
export const LOG_DIR = path.join(APP_ROOT, "logs");
export const WATCHDOG_LOG_PATH = path.join(LOG_DIR, "watchdog.log");
export const DAEMON_LOG_PATH = path.join(LOG_DIR, "daemon.log");
export const SERVICE_LOG_PATH = path.join(LOG_DIR, "service.log");
export const LAUNCHER_LOG_PATH = path.join(LOG_DIR, "launcher.log");
export const WATCHDOG_PID_PATH = path.join(DATA_DIR, "watchdog.pid");
export const TRAY_PID_PATH = path.join(DATA_DIR, "tray.pid");
export const DIST_DIR = path.join(APP_ROOT, "dist");
export const APP_ROOT_DIR = APP_ROOT;
