import assert from "node:assert/strict";
import test from "node:test";

import { injectableTargets, isInjectableTarget, selectInjectableTarget } from "../src/cdp/client.js";

/**
 * These reproduce the real `/json/list` shapes of the merged Trae CN client: the
 * Code workbench, the Agent page, and the Agent's floating chat and button. All
 * are served from `vscode-file://`, which is exactly what used to make the
 * floating windows look injectable.
 */
const WORKBENCH = {
  id: "wb",
  type: "page",
  title: "index.vue - 无标题 (工作区) - TRAE CN",
  url: "vscode-file://vscode-app/d:/ProgramFiles/Trae%20CN/resources/app/out/vs/code/electron-browser/workbench/workbench.html",
  webSocketDebuggerUrl: "ws://127.0.0.1:9337/devtools/page/wb",
};
const AGENT_PAGE = {
  id: "agent",
  type: "page",
  title: "Agent",
  url: "vscode-file://vscode-app/d:/ProgramFiles/Trae%20CN/resources/app/out/vs/code/electron-browser/solo/solo-lite.html",
  webSocketDebuggerUrl: "ws://127.0.0.1:9337/devtools/page/agent",
};
const AGENT_CHAT = {
  id: "chat",
  type: "page",
  title: "Floating",
  url: "vscode-file://vscode-app/d:/ProgramFiles/Trae%20CN/resources/app/out/vs/code/electron-browser/floatingChat/floatingChat.html",
  webSocketDebuggerUrl: "ws://127.0.0.1:9337/devtools/page/chat",
};
const FLOATING_BUTTON = {
  id: "btn",
  type: "page",
  title: "floatingButton.html",
  url: "file:///D:/ProgramFiles/Trae%20CN/resources/app/out/vs/platform/iCubeFloatingChat/electron-main/media/floatingButton.html",
  webSocketDebuggerUrl: "ws://127.0.0.1:9337/devtools/page/btn",
};
const WORKER = {
  id: "w",
  type: "worker",
  title: "",
  url: "",
  webSocketDebuggerUrl: "ws://127.0.0.1:9337/devtools/page/w",
};

test("the Code workbench and the Agent page are injectable; the floating windows are not", () => {
  assert.equal(isInjectableTarget(WORKBENCH), true);
  assert.equal(isInjectableTarget(AGENT_PAGE), true);
  assert.equal(isInjectableTarget(AGENT_CHAT), false);
  assert.equal(isInjectableTarget(FLOATING_BUTTON), false);
});

test("a floating window listed first does not steal the injection", () => {
  // The Agent chat is created first in this list; it used to be picked as the
  // first match and pull the panel onto the floating surface.
  const picked = selectInjectableTarget([AGENT_CHAT, WORKBENCH, FLOATING_BUTTON, WORKER]);
  assert.equal(picked, WORKBENCH);
});

test("the workbench is preferred when a single target is selected", () => {
  assert.equal(selectInjectableTarget([AGENT_PAGE, WORKBENCH]), WORKBENCH);
  assert.equal(selectInjectableTarget([WORKBENCH, AGENT_PAGE]), WORKBENCH);
  // With no Code window open, the Agent page is the one worth injecting.
  assert.equal(selectInjectableTarget([AGENT_CHAT, AGENT_PAGE]), AGENT_PAGE);
});

test("every Code window and the Agent page get their own injection", () => {
  // Two Code windows are two workbench targets; both are injected alongside the
  // Agent page. The floating windows get nothing.
  const secondWindow = { ...WORKBENCH, id: "wb2" };
  const selected = injectableTargets([
    AGENT_CHAT,
    WORKBENCH,
    secondWindow,
    AGENT_PAGE,
    FLOATING_BUTTON,
    WORKER,
  ]);
  assert.deepEqual(
    selected.map((target) => target.id),
    ["wb", "wb2", "agent"],
  );
});

test("nothing is injected when only the floating windows exist", () => {
  assert.equal(selectInjectableTarget([AGENT_CHAT, FLOATING_BUTTON, WORKER]), null);
  assert.deepEqual(injectableTargets([AGENT_CHAT, FLOATING_BUTTON, WORKER]), []);
  assert.equal(selectInjectableTarget([]), null);
  assert.equal(selectInjectableTarget(null), null);
});

test("devtools and non-page targets are never injectable", () => {
  assert.equal(
    isInjectableTarget({ type: "page", url: "devtools://devtools/bundled/x.html", webSocketDebuggerUrl: "ws://x" }),
    false,
  );
  assert.equal(isInjectableTarget(WORKER), false);
  assert.equal(isInjectableTarget({ type: "page", url: WORKBENCH.url }), false);
});
