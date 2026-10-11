/**
 * Menu description for the tray host.
 *
 * The PowerShell host is ASCII-only, so every display string lives here and is
 * handed over through a UTF-8 JSON file instead of being embedded in the script.
 */
export const TRAY_TITLE = "Trae Meta";
export const TRAY_BALLOON_TEXT = "后台服务已就绪";

export const TRAY_MENU_ITEMS = [
  { label: "启动 TRAE 与面板", command: "start", window: "normal" },
  { label: "启动后台服务", command: "daemon", window: "hidden" },
  { label: "重新启动后台服务", command: "restart", window: "hidden" },
  { label: "停止后台服务", command: "stop", window: "hidden" },
  { label: "查看状态", command: "status", window: "normal" },
  { label: "查看日志", command: "logs", window: "normal" },
  { label: "退出托盘", command: "exit", window: "hidden" },
];

export const TRAY_WINDOW_MODES = new Set(["hidden", "normal"]);

export function buildTrayConfig({
  nodePath,
  serviceArgs,
  iconPath = null,
  workingDirectory,
  title = TRAY_TITLE,
  balloonText = TRAY_BALLOON_TEXT,
  primaryCommand = "start",
  items = TRAY_MENU_ITEMS,
}) {
  for (const [key, value] of Object.entries({ nodePath, workingDirectory })) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`tray config requires a non-empty ${key}`);
    }
  }
  if (!Array.isArray(serviceArgs) || serviceArgs.length === 0) {
    throw new Error("tray config requires at least one service argument");
  }
  if (serviceArgs.some((argument) => typeof argument !== "string" || !argument.trim())) {
    throw new Error("every service argument must be a non-empty string");
  }
  for (const item of items) {
    if (typeof item.label !== "string" || !item.label.trim()) {
      throw new Error("every tray menu item needs a label");
    }
    if (typeof item.command !== "string" || !item.command.trim()) {
      throw new Error(`tray menu item "${item.label}" needs a command`);
    }
    if (!TRAY_WINDOW_MODES.has(item.window)) {
      throw new Error(`tray menu item "${item.label}" has an unknown window mode`);
    }
  }
  return {
    title,
    balloonText,
    nodePath,
    serviceArgs: [...serviceArgs],
    iconPath,
    workingDirectory,
    primaryCommand,
    items: items.map((item) => ({ ...item })),
  };
}
