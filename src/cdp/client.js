import { setTimeout as delay } from "node:timers/promises";

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function fetchJson(url, { timeoutMs = 3000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The merged TRAE client renders the Code workbench and the Agent views in
 * separate targets, all served from `vscode-file://` so a URL-based match alone
 * treats every one of them as injectable. `/json/list` is also not ordered, so
 * picking the first match is unstable.
 *
 * The panel is injected into both the Code workbench and the Agent page
 * (`solo/solo-lite.html`), but never into the Agent's floating windows
 * (`floatingChat.html`, `floatingButton`): those hover *over* Code, and the panel
 * must stay clear of them.
 */
function isFloatingAgentWindow(target) {
  const url = String(target?.url || "").toLowerCase();
  return url.includes("floatingchat") || url.includes("floatingbutton");
}

function targetPriority(target) {
  const url = String(target?.url || "").toLowerCase();
  return url.includes("workbench") ? 2 : 1;
}

export function isInjectableTarget(target) {
  if (!target || target.type !== "page" || !target.webSocketDebuggerUrl) return false;
  const url = String(target.url || "").toLowerCase();
  const title = String(target.title || "").toLowerCase();
  if (url.startsWith("devtools://")) return false;
  if (isFloatingAgentWindow(target)) return false;
  return (
    url.includes("workbench") ||
    url.includes("vscode-file") ||
    title.includes("trae") ||
    title.includes("solo")
  );
}

/** Every target the panel should be injected into. TRAE can have more than one
 * Code window, and each is its own target that needs its own panel. */
export function injectableTargets(targets) {
  if (!Array.isArray(targets)) return [];
  return targets.filter(isInjectableTarget);
}

/** The single best target, used by the diagnostic script. A workbench window
 * always wins over any other TRAE surface. */
export function selectInjectableTarget(targets) {
  const injectable = injectableTargets(targets);
  if (!injectable.length) return null;
  return injectable.reduce(
    (best, candidate) => (targetPriority(candidate) > targetPriority(best) ? candidate : best),
    injectable[0],
  );
}

/**
 * One renderer target and its own CDP socket. TRAE exposes every Code window as
 * a separate target, so injection and event delivery are per-connection.
 */
class Connection {
  constructor(target) {
    this.id = target.id;
    this.target = target;
    this.socket = null;
    this.connected = false;
    this.pending = new Map();
    this.nextId = 1;
  }
}

export class CdpClient {
  constructor({ port, getInjectScript, onStateChange = () => {} }) {
    this.port = port;
    this.getInjectScript = getInjectScript;
    this.onStateChange = onStateChange;
    this.stopped = true;
    this.loopPromise = null;
    this.connections = new Map();
    this.aggregateConnected = false;
  }

  get isConnected() {
    for (const connection of this.connections.values()) {
      if (connection.connected) return true;
    }
    return false;
  }

  start() {
    if (this.loopPromise) return;
    this.stopped = false;
    this.loopPromise = this.runLoop().finally(() => {
      this.loopPromise = null;
      this.closeAll();
      this.updateAggregateState(false);
    });
  }

  async stop() {
    this.stopped = true;
    this.closeAll();
    await this.loopPromise?.catch(() => {});
  }

  async listTargets() {
    return await fetchJson(`http://127.0.0.1:${this.port}/json/list`);
  }

  async findTarget() {
    const targets = await this.listTargets();
    return selectInjectableTarget(targets);
  }

  /**
   * Keeps one connection per injectable target. New Code windows are picked up
   * on later scans, and a window that closes drops its connection here.
   */
  async runLoop() {
    while (!this.stopped) {
      try {
        const targets = await this.listTargets();
        const wanted = injectableTargets(targets);
        const wantedIds = new Set(wanted.map((target) => target.id));
        for (const id of [...this.connections.keys()]) {
          if (!wantedIds.has(id)) this.dropConnection(id);
        }
        for (const target of wanted) {
          if (this.connections.has(target.id)) continue;
          try {
            await this.openConnection(target);
          } catch {
            // Retry on the next scan; TRAE may still be mid-navigation.
          }
        }
      } catch {
        // The CDP endpoint is unavailable; try again shortly.
      }
      await delay(1000);
    }
  }

  async openConnection(target) {
    const connection = new Connection(target);
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    connection.socket = socket;

    await withTimeout(
      new Promise((resolve, reject) => {
        const handleOpen = () => {
          socket.removeEventListener("error", handleError);
          resolve();
        };
        const handleError = () => {
          socket.removeEventListener("open", handleOpen);
          reject(new Error("Failed to connect to the TRAE CDP socket"));
        };
        socket.addEventListener("open", handleOpen, { once: true });
        socket.addEventListener("error", handleError, { once: true });
      }),
      5000,
      "Timed out while connecting to the TRAE CDP socket",
    );

    socket.addEventListener("message", (event) => this.handleMessage(connection, event));
    socket.addEventListener("close", () => this.dropConnection(connection.id));
    socket.addEventListener("error", () => this.dropConnection(connection.id));

    connection.connected = true;
    this.connections.set(connection.id, connection);
    this.updateAggregateState(true);

    await this.send(connection, "Runtime.enable");
    await this.send(connection, "Page.enable");
    await this.injectInto(connection).catch(() => {});
  }

  dropConnection(id) {
    const connection = this.connections.get(id);
    if (!connection) return;
    connection.connected = false;
    this.rejectPending(connection, new Error("TRAE CDP connection closed"));
    try {
      connection.socket?.close();
    } catch {
      // Node may already have closed the socket.
    }
    this.connections.delete(id);
    this.updateAggregateState(this.isConnected);
  }

  closeAll() {
    for (const id of [...this.connections.keys()]) {
      const connection = this.connections.get(id);
      connection.connected = false;
      this.rejectPending(connection, new Error("TRAE CDP connection reset"));
      try {
        connection.socket?.close();
      } catch {
        // Node may already have closed the socket.
      }
      this.connections.delete(id);
    }
  }

  /**
   * Ad-hoc single-target connection. Only the diagnostic script uses it, which
   * attaches to one window and disconnects when done.
   */
  async connect(webSocketDebuggerUrl) {
    await this.openConnection({ id: webSocketDebuggerUrl, webSocketDebuggerUrl });
  }

  async closeSocket() {
    this.closeAll();
  }

  /** Fires only on aggregate transitions, so closing one of several windows does
   * not look like "CDP went away" and re-trigger the client-load check-in. */
  updateAggregateState(connected) {
    if (connected === this.aggregateConnected) return;
    this.aggregateConnected = connected;
    this.onStateChange(connected);
  }

  rejectPending(connection, error) {
    for (const { reject } of connection.pending.values()) reject(error);
    connection.pending.clear();
  }

  handleMessage(connection, event) {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }

    if (message.id) {
      const pending = connection.pending.get(message.id);
      if (!pending) return;
      connection.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "CDP command failed"));
      else pending.resolve(message.result);
      return;
    }

    if (message.method === "Page.loadEventFired") {
      this.injectInto(connection).catch(() => {});
    }
  }

  send(connection, method, params = {}, timeoutMs = 5000) {
    if (!connection?.socket || !connection.connected) {
      return Promise.reject(new Error("TRAE CDP is not connected"));
    }
    const id = connection.nextId++;
    const command = JSON.stringify({ id, method, params });
    return withTimeout(
      new Promise((resolve, reject) => {
        connection.pending.set(id, { resolve, reject });
        try {
          connection.socket.send(command);
        } catch (error) {
          connection.pending.delete(id);
          reject(error);
        }
      }),
      timeoutMs,
      `CDP command timed out: ${method}`,
    ).finally(() => connection.pending.delete(id));
  }

  async evaluateOn(connection, expression, { awaitPromise = true, timeoutMs = 5000 } = {}) {
    const result = await this.send(
      connection,
      "Runtime.evaluate",
      {
        expression,
        awaitPromise,
        returnByValue: true,
        userGesture: false,
      },
      timeoutMs,
    );
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text ||
          "Renderer evaluation failed",
      );
    }
    return result.result?.value;
  }

  /** The window a one-shot read runs against: a Code workbench whenever one is
   * open, so identity reads do not land on the Agent page. */
  primaryConnection() {
    const connected = [...this.connections.values()].filter((connection) => connection.connected);
    if (!connected.length) return null;
    return connected.reduce(
      (best, candidate) =>
        targetPriority(candidate.target) > targetPriority(best.target) ? candidate : best,
      connected[0],
    );
  }

  /** Runs an expression against the primary window, for one-shot reads. */
  async evaluate(expression, options = {}) {
    const connection = this.primaryConnection();
    if (!connection) throw new Error("TRAE CDP is not connected");
    return await this.evaluateOn(connection, expression, options);
  }

  /** Runs an expression against every connected window, for event delivery. */
  async broadcast(expression, options = {}) {
    const targets = [...this.connections.values()].filter((connection) => connection.connected);
    if (!targets.length) return false;
    const results = await Promise.allSettled(
      targets.map((connection) => this.evaluateOn(connection, expression, options)),
    );
    return results.some((result) => result.status === "fulfilled");
  }

  async injectInto(connection) {
    if (!connection.connected) return false;
    const script = await this.getInjectScript();
    await this.evaluateOn(connection, script, { awaitPromise: false, timeoutMs: 10000 });
    return true;
  }

  async inject() {
    const targets = [...this.connections.values()].filter((connection) => connection.connected);
    if (!targets.length) return false;
    const script = await this.getInjectScript();
    const results = await Promise.allSettled(
      targets.map((connection) =>
        this.evaluateOn(connection, script, { awaitPromise: false, timeoutMs: 10000 }),
      ),
    );
    return results.some((result) => result.status === "fulfilled");
  }

  async getLiveIdentity() {
    const connection = this.primaryConnection();
    if (!connection) return null;
    const expression = `
      (async function () {
        try {
          var bridge = globalThis.vscode && globalThis.vscode.ipcRenderer;
          if (!bridge || typeof bridge.invoke !== "function") return null;
          var raw = await bridge.invoke("vscode:sandbox::main-invoke-getUserInfo");
          var info = raw && raw.result ? raw.result : (raw && raw.data ? raw.data : raw);
          if (!info || typeof info !== "object") return null;
          var account = info.account && typeof info.account === "object" ? info.account : {};
          function pick() {
            for (var i = 0; i < arguments.length; i++) {
              var value = arguments[i];
              if (value !== undefined && value !== null && String(value).trim()) {
                return String(value).trim();
              }
            }
            return null;
          }
          return {
            userId: pick(info.userId, info.user_id, info.uid, account.userId, account.user_id, account.id),
            email: pick(info.email, account.email, account.nonPlainTextEmail),
            phone: pick(info.phone, info.mobile, info.phoneNumber, account.phone, account.mobile, account.nonPlainTextMobile),
            nickname: pick(info.nickname, info.name, info.displayName, account.nickname, account.username, account.name, account.ScreenName)
          };
        } catch (_) {
          return null;
        }
      })()
    `;
    try {
      const identity = await this.evaluateOn(connection, expression, {
        awaitPromise: true,
        timeoutMs: 4000,
      });
      return identity && typeof identity === "object" ? identity : null;
    } catch {
      return null;
    }
  }
}
