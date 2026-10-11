/**
 * Guards the settings tab against selector drift.
 *
 * The panel is a single string of injected code with no build step and no DOM in
 * tests, so a mistyped class name breaks the tab silently at run time on a user
 * machine. Reading the source and matching every queried selector against the
 * rendered markup catches that before it ships.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SOURCE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "ui",
  "inject.js",
);
const source = fs.readFileSync(SOURCE_PATH, "utf8");

function paneTemplate(variable) {
  const match = source.match(new RegExp(`${variable}\\.innerHTML = \`([\\s\\S]*?)\`;`));
  assert.ok(match, `${variable}.innerHTML was not found`);
  return match[1];
}

function classTokens(markup) {
  const tokens = new Set();
  for (const match of markup.matchAll(/class="([^"]+)"/g)) {
    for (const token of match[1].split(/\s+/)) {
      if (token) tokens.add(token);
    }
  }
  return tokens;
}

function queriedSelectors(variable) {
  const selectors = [];
  for (const match of source.matchAll(
    new RegExp(`${variable}\\.querySelector(?:All)?\\("([^"]+)"\\)`, "g"),
  )) {
    selectors.push(match[1]);
  }
  return selectors;
}

test("the settings tab exists next to the account and about tabs", () => {
  const tabs = paneTemplate("tabs");
  assert.ok(tabs.includes('data-tab="account"'));
  assert.ok(tabs.includes('data-tab="settings"'), "the settings tab button is missing");
  assert.ok(tabs.includes('data-tab="about"'), "the about tab button is missing");
  assert.ok(tabs.includes("<span>关于</span>"), "the about tab label is missing");
  assert.ok(source.includes('settingsPane.dataset.pane = "settings"'));
});

test("every settings selector matches a class in the settings markup", () => {
  const tokens = classTokens(paneTemplate("settingsPane"));
  const selectors = queriedSelectors("settingsPane");
  assert.ok(selectors.length >= 8, `expected several selectors, saw ${selectors.length}`);
  for (const selector of selectors) {
    const name = selector.replace(/^\./, "");
    assert.equal(
      tokens.has(name),
      true,
      `settingsPane.querySelector("${selector}") has no matching element`,
    );
  }
});

test("the maintenance panel owns the restart button the settings code wires up", () => {
  const markup = paneTemplate("settingsPane");
  const occurrences = markup.split('class="te-secondary te-daemon-restart"').length - 1;
  assert.equal(occurrences, 1, "expected one restart button in maintenance");
});

test("the pane is registered in the content area", () => {
  assert.ok(
    source.includes("content.append(accountPane, settingsPane, aboutPane)"),
    "the settings pane is not appended to the content area",
  );
});

test("every about selector matches a class in the about markup", () => {
  const tokens = classTokens(paneTemplate("aboutPane"));
  const selectors = queriedSelectors("aboutPane");
  assert.ok(selectors.length >= 8, `expected several selectors, saw ${selectors.length}`);
  for (const selector of selectors) {
    const name = selector.replace(/^\./, "");
    assert.equal(
      tokens.has(name),
      true,
      `aboutPane.querySelector("${selector}") has no matching element`,
    );
  }
});

/**
 * Returns the body of a top-level function in the injected source.
 *
 * The two-space closing brace is what ends a function declared inside `setup()`;
 * the nested blocks inside it are indented further.
 */
function functionBody(signature) {
  const match = source.match(new RegExp(`${signature}\\s*\\{([\\s\\S]*?)\\n  \\}`));
  assert.ok(match, `${signature} was not found`);
  return match[1];
}

test("the check-in section takes its interval list from the daemon", () => {
  const markup = paneTemplate("settingsPane");
  assert.ok(markup.includes("自动签到"), "the check-in section is missing");
  // Shipped empty on purpose: the allowed values belong to the daemon, and a second
  // hard-coded list here is exactly how the two would drift apart.
  assert.ok(
    markup.includes('<select class="te-select te-checkin-interval"></select>'),
    "the interval select must not hard-code its options",
  );
  assert.ok(functionBody("function renderCheckin\\(checkin\\)").includes("checkin.options"));
});

test("turning automatic check-in off disables its fields instead of hiding them", () => {
  const body = functionBody("function applyCheckinVisibility\\(auto\\)");
  assert.ok(body.includes("settingsUi.checkinInterval.disabled = !auto"));
  assert.ok(body.includes("settingsUi.checkinClientLoad.disabled = !auto"));
  // Disabled, not hidden: the saved interval has to stay readable while it is off.
  assert.ok(!body.includes("hidden"), "the fields must not be hidden while disabled");
});

test("saving the check-in settings applies without a restart banner", () => {
  const body = functionBody("async function saveCheckinConfig\\(\\)");
  assert.ok(body.includes('"/api/settings/checkin"'));
  assert.ok(
    !body.includes("RestartBanner"),
    "the daemon rebuilds its schedule in place, so a restart notice would be wrong",
  );
});

test("the about pane's check-in line follows the saved settings", () => {
  const markup = paneTemplate("aboutPane");
  assert.ok(markup.includes("te-feature-checkin"), "the about entry has no hook to update");
  assert.ok(
    !markup.includes("每天自动检查"),
    "the static wording must not promise a schedule the settings can change",
  );
  const body = functionBody("function applyAboutCheckinText\\(checkin\\)");
  assert.ok(body.includes("已关闭"), "the disabled wording is missing");
  assert.ok(body.includes("分钟检查"), "the enabled wording must name the real interval");
});

test("the empty state separates a logged-out TRAE from a failed adoption", () => {
  const body = functionBody(
    "function renderAccounts\\(accounts, currentAccountId, currentAccountState\\)",
  );
  assert.ok(body.includes("暂无账号备份"));
  assert.ok(body.includes("TRAE 尚未登录"), "the logged-out state is not rendered");
  assert.ok(body.includes("adoptionError"), "the failure reason is never rendered");
  assert.ok(body.includes("te-adopt-retry"), "there is no way to retry after a failure");
});

test("opening the panel adopts only a signed-in account that is not managed yet", () => {
  const body = functionBody("function openPanel\\(\\)");
  assert.ok(body.includes("data?.accounts?.length === 0"));
  assert.ok(body.includes('data.currentAccountState === "not-managed"'));
  assert.ok(!body.includes("!data.currentAccountId"));
});

test("release notes are built as nodes, never parsed as HTML", () => {
  const notes = functionBody("function renderUpdateNotes\\(container, markdown\\)");
  assert.ok(notes.includes("textContent"), "the notes are not rendered as text");
  assert.ok(
    !notes.includes("innerHTML"),
    "remote Markdown must never be assigned as HTML",
  );
  const inline = functionBody("function appendUpdateInline\\(node, text\\)");
  assert.ok(inline.includes("createElement"));
  assert.ok(!inline.includes("innerHTML"));
  // Links stay text: an <a> inside the workbench page would navigate the IDE away.
  assert.ok(!inline.includes("createElement(\"a\")"));
});

test("a failed update check is not reported as being up to date", () => {
  const body = functionBody("function renderAppUpdate\\(update, \\{ fresh = false \\} = \\{\\}\\)");
  assert.ok(body.includes("检查失败"), "a failed check has no wording of its own");
  assert.ok(body.includes("update.error"), "the failure reason is never rendered");
  // The dot must follow the payload, not the mere fact that a check happened.
  assert.ok(body.includes("updateTabDot.hidden = !hasUpdate"));
});

test("only a freshly fetched payload may restore a live upgrade stage", () => {
  const body = functionBody("function renderAppUpdate\\(update, \\{ fresh = false \\} = \\{\\}\\)");
  // The panel repaints this card from the payload already in hand — after a push,
  // after closing the progress box. Restoring a stage there is how a download that
  // had already failed came back and sat at the last percentage it reached.
  assert.ok(
    body.includes("if (fresh) {"),
    "the restore path must be gated on a payload that just came off the wire",
  );
  assert.ok(body.includes("appUpdateStage = update.install?.stage"));
  // The button's label is the daemon's stage, not the box's: a dismissed failure is
  // still the last known outcome, so the next click is a retry, not a first try.
  assert.ok(
    body.includes('appUpdateStage === "failed"'),
    "the retry label must survive the box being dismissed",
  );
});

test("the about card reads the daemon's cached result instead of GitHub", () => {
  const body = functionBody("async function loadAppUpdate\\(\\)");
  assert.ok(body.includes('"/api/update"'));
  assert.ok(!body.includes("api.github.com"), "the panel must not call GitHub directly");
  // A stale or unreachable daemon keeps the last card rather than clearing it.
  assert.ok(body.includes("catch"));
});

test("checking for updates is a deliberate force, and silent when it is not asked for", () => {
  const body = functionBody("async function checkAppUpdate\\(\\{ silent = false \\} = \\{\\}\\)");
  assert.ok(body.includes('"/api/update/check"'));
  assert.ok(body.includes("force: true"));
  assert.ok(body.includes("if (!silent)"), "a background check must not toast");
});

test("reloading the panel re-injects it instead of restarting TRAE", () => {
  const body = functionBody("async function reloadPanel\\(\\)");
  assert.ok(body.includes('"/api/inject"'));
  assert.ok(!body.includes("kill"), "no process may be terminated to reload the panel");
});

test("a pushed update notification lights the tab dot", () => {
  assert.ok(source.includes('const UPDATE_AVAILABLE_EVENT = "traemeta:update-available"'));
  const body = functionBody("function handleUpdateAvailable\\(\\)");
  assert.ok(body.includes("updateTabDot.hidden = false"));
  assert.ok(
    source.includes("window.addEventListener(UPDATE_AVAILABLE_EVENT, handleUpdateAvailable)"),
    "the pushed event is never subscribed",
  );
  assert.ok(
    source.includes("window.removeEventListener(UPDATE_AVAILABLE_EVENT, handleUpdateAvailable)"),
    "the pushed event survives re-injection and would fire on a dead panel",
  );
});

test("the update switch saves without reaching the network by itself", () => {
  const body = functionBody("async function saveAppUpdateConfig\\(\\)");
  assert.ok(body.includes('"/api/settings/app-update"'));
  assert.ok(body.includes("autoCheck"));
  // The one check it may trigger is the panel's own deliberate request.
  assert.ok(body.includes('checkAppUpdate({ silent: true })'));
});

test("the delete dialog no longer asks for a typed confirmation", () => {
  const markup = paneTemplate("deleteMask");
  assert.ok(!markup.includes("te-delete-confirm"), "the typed confirmation field is still there");
  assert.ok(markup.includes("te-delete-submit"));
  const open = functionBody("function openDeleteDialog\\(account\\)");
  assert.ok(
    open.includes('.disabled = false'),
    "the confirm button must be usable the moment the dialog opens",
  );
  assert.ok(
    !functionBody("async function confirmDeleteAccount\\(\\)").includes("te-delete-confirm"),
  );
});

test("the renew button rewrites the expiry instead of promising a success", () => {
  const cards = functionBody(
    "function renderAccounts\\(accounts, currentAccountId, currentAccountState\\)",
  );
  assert.ok(cards.includes("te-acc-renew"), "the renew button is not rendered");
  const body = functionBody("async function renewAccount\\(button, accountId\\)");
  assert.ok(body.includes('"/api/accounts/renew"'));
  assert.ok(body.includes("if (result.renewed)"), "the success path is not gated on the result");
  assert.ok(
    body.includes("未取得新的到期时间"),
    "an unchanged expiry must be reported as unconfirmed",
  );
  // The result carries the expiry but the user never sees a token kind: only the
  // date that decides whether the account still works.
  const messages = body.match(/showToast\([\s\S]*?\);/g) ?? [];
  assert.ok(messages.length > 0, "the renew button says nothing at all");
  for (const message of messages) {
    // Interpolations name real fields (`accessExpiresAt`); only the visible text matters.
    const visible = message.replace(/\$\{[^}]*\}/g, "").replace(/showToast|\$\{|\}/g, "");
    assert.ok(!/access|refresh/i.test(visible), `token kind leaked: ${visible}`);
  }
});
