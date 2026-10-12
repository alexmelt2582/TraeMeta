(() => {
  "use strict";

  const ROOT_ID = "traemeta-root";
  const STYLE_ID = "traemeta-style";
  const API_BASE = "__API_BASE__";
  const API_TOKEN = "__API_TOKEN__";
  const APP_VERSION = "__APP_VERSION__";
  // Dispatched by the daemon through CDP after any account state change. The
  // panel is a pure view, so this is how a background sweep reaches an already
  // open panel without a polling loop on this side.
  const ACCOUNTS_UPDATED_EVENT = "traemeta:accounts-updated";
  // Dispatched by the daemon when its scheduled check finds a newer release, so
  // the About tab can show the dot without the panel ever polling GitHub (the
  // workbench CSP would block that request anyway).
  const UPDATE_AVAILABLE_EVENT = "traemeta:update-available";
  // Dispatched by the daemon while an in-app upgrade is downloading or verifying.
  // The upgrade request stays open for the whole download, so without this the
  // panel could only show one frozen line until it finished.
  const UPDATE_PROGRESS_EVENT = "traemeta:update-progress";
  // Dispatched by the daemon on behalf of another process that has something to
  // tell the user, such as the launcher failing to bring TRAE to the front. It is
  // one-shot: the panel may well be closed when it arrives, so the handler opens
  // it before showing the toast.
  const NOTICE_EVENT = "traemeta:notice";

  window.__traeMetaCleanup?.();
  document.getElementById(ROOT_ID)?.remove();
  document.getElementById(STYLE_ID)?.remove();

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${ROOT_ID} {
      --te-panel: color-mix(in srgb, var(--vscode-editor-background, #ffffff) 94%, transparent);
      --te-panel-solid: var(--vscode-editor-background, #ffffff);
      --te-surface: var(--vscode-sideBar-background, var(--vscode-editorWidget-background, #f6f6f6));
      --te-surface-hover: var(--vscode-list-hoverBackground, rgba(127,127,127,.12));
      --te-border: var(--vscode-widget-border, var(--vscode-panel-border, rgba(127,127,127,.24)));
      --te-text: var(--vscode-foreground, #1f1f1f);
      --te-muted: var(--vscode-descriptionForeground, #777777);
      --te-accent: var(--vscode-button-background, #2f6fd6);
      --te-accent-fg: var(--vscode-button-foreground, #ffffff);
      position: fixed;
      right: 18px;
      bottom: 18px;
      z-index: 2147483646;
      color: var(--te-text);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      font-size: 12px;
      line-height: 1.4;
    }

    #${ROOT_ID} *,
    #${ROOT_ID} *::before,
    #${ROOT_ID} *::after { box-sizing: border-box; }

    #${ROOT_ID} [hidden] { display: none !important; }

    #${ROOT_ID} .te-fab {
      width: 42px;
      height: 42px;
      margin-left: auto;
      display: grid;
      place-items: center;
      border: 1px solid var(--te-border);
      border-radius: 12px;
      color: var(--te-text);
      background: var(--te-panel);
      box-shadow: 0 8px 26px rgba(0,0,0,.22);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      cursor: pointer;
      transition: background .15s, box-shadow .15s, transform .15s;
    }

    #${ROOT_ID} .te-fab:hover {
      background: var(--te-surface-hover);
      box-shadow: 0 10px 30px rgba(0,0,0,.28);
      transform: translateY(-1px);
    }

    #${ROOT_ID} .te-panel {
      position: absolute;
      right: 0;
      bottom: 50px;
      /* Wide enough that a settings row reads as label + control on one line and
         the account meta row stops wrapping. */
      width: min(540px, calc(100vw - 24px));
      height: min(700px, calc(100vh - 84px));
      display: none;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid var(--te-border);
      border-radius: 14px;
      background: var(--te-panel);
      box-shadow: 0 20px 60px rgba(0,0,0,.34);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
    }

    #${ROOT_ID} .te-panel.open { display: flex; }

    #${ROOT_ID} .te-header {
      min-height: 52px;
      padding: 0 12px 0 15px;
      display: flex;
      align-items: center;
      gap: 10px;
      border-bottom: 1px solid var(--te-border);
      flex: 0 0 auto;
      /* The header doubles as the drag handle for the whole widget. Buttons
         inside it keep their own pointer cursor. */
      cursor: grab;
      user-select: none;
    }

    #${ROOT_ID} .te-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 14px;
      font-weight: 650;
    }

    #${ROOT_ID} .te-subtitle {
      margin-left: auto;
      color: var(--te-muted);
      font-size: 11px;
      white-space: nowrap;
    }

    #${ROOT_ID} .te-icon-btn {
      width: 30px;
      height: 30px;
      display: inline-grid;
      place-items: center;
      flex: 0 0 30px;
      border: 0;
      border-radius: 8px;
      color: var(--te-muted);
      background: transparent;
      cursor: pointer;
    }

    #${ROOT_ID} .te-icon-btn:hover {
      color: var(--te-text);
      background: var(--te-surface-hover);
    }

    #${ROOT_ID} .te-body {
      min-height: 0;
      overflow: auto;
      padding: 12px;
    }

    #${ROOT_ID} .te-tabs {
      display: flex;
      gap: 6px;
      padding: 9px 12px 0;
      border-bottom: 1px solid var(--te-border);
      flex: 0 0 auto;
    }

    #${ROOT_ID} .te-tab {
      min-width: 88px;
      height: 34px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 0 12px;
      border: 0;
      border-radius: 9px 9px 0 0;
      color: var(--te-muted);
      background: transparent;
      font: inherit;
      font-weight: 650;
      cursor: pointer;
    }

    #${ROOT_ID} .te-tab:hover {
      color: var(--te-text);
      background: var(--te-surface-hover);
    }

    #${ROOT_ID} .te-tab.active {
      color: var(--te-accent-fg);
      background: var(--te-accent);
    }

    /* A release found by a background check has to be visible from the account
       tab, so the dot lives on the tab rather than inside the About pane. */
    #${ROOT_ID} .te-tab { position: relative; }
    #${ROOT_ID} .te-tab-dot {
      position: absolute;
      top: 5px;
      right: 7px;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #ef4444;
      box-shadow: 0 0 0 2px var(--te-panel-solid);
    }

    #${ROOT_ID} .te-content {
      min-height: 0;
      overflow: hidden;
      flex: 1 1 auto;
    }

    #${ROOT_ID} .te-pane {
      display: none;
      height: 100%;
      min-height: 0;
    }

    #${ROOT_ID} .te-pane.active {
      display: flex;
      flex-direction: column;
    }

    #${ROOT_ID} .te-pane[data-pane="about"] {
      overflow: auto;
      padding: 14px;
    }

    #${ROOT_ID} .te-pane[data-pane="settings"] {
      overflow: auto;
      padding: 12px;
    }

    #${ROOT_ID} .te-settings {
      display: grid;
      gap: 12px;
    }

    /* The one card primitive: settings panels and about sections both use it, so a
       new block never needs a border-and-radius of its own. */
    #${ROOT_ID} .te-section {
      padding: 14px;
      border: 1px solid var(--te-border);
      border-radius: 12px;
      background: var(--te-surface);
    }

    #${ROOT_ID} .te-section-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: -.005em;
    }

    #${ROOT_ID} .te-section-hint {
      margin-top: 7px;
      color: var(--te-muted);
      font-size: 10.5px;
      line-height: 1.6;
    }

    /* A settings row puts the control at its right end, so the select is sized to
       its content instead of stretching the full width of a stacked field. */
    #${ROOT_ID} .te-select {
      height: 30px;
      padding: 0 6px 0 8px;
      border: 1px solid var(--te-border);
      border-radius: 8px;
      outline: 0;
      color: var(--te-text);
      background: var(--te-panel-solid);
      font: inherit;
      font-size: 11px;
      cursor: pointer;
    }

    #${ROOT_ID} .te-select:hover:not(:disabled) {
      border-color: color-mix(in srgb, var(--te-accent) 45%, var(--te-border));
    }

    #${ROOT_ID} .te-select:focus-visible {
      border-color: var(--te-accent);
      box-shadow: 0 0 0 1px var(--te-accent);
    }

    /* The fields a master switch governs stay readable but must look inert. */
    #${ROOT_ID} .te-select:disabled {
      opacity: .5;
      cursor: not-allowed;
    }

    #${ROOT_ID} .te-status-list {
      display: grid;
      gap: 5px;
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid color-mix(in srgb, var(--te-border) 62%, transparent);
      color: var(--te-muted);
      font-size: 10.5px;
      line-height: 1.5;
    }

    /* An empty list must not leave its separator hanging under the controls. */
    #${ROOT_ID} .te-status-list:empty { display: none; }

    /* Label column: the values line up down the card instead of stepping right
       with every label length. */
    #${ROOT_ID} .te-status-line {
      display: grid;
      grid-template-columns: 68px minmax(0, 1fr);
      gap: 8px;
    }

    #${ROOT_ID} .te-status-line > b {
      color: var(--te-muted);
      font-weight: 600;
    }

    #${ROOT_ID} .te-status-line > span {
      min-width: 0;
      color: var(--te-text);
      word-break: break-word;
    }

    /* One pill shape everywhere, so a state change never resizes the row. */
    #${ROOT_ID} .te-badge {
      height: 20px;
      display: inline-flex;
      align-items: center;
      flex: 0 0 auto;
      padding: 0 8px;
      border: 1px solid var(--te-border);
      border-radius: 999px;
      color: var(--te-muted);
      background: color-mix(in srgb, var(--te-muted) 10%, transparent);
      font-size: 10px;
      font-weight: 650;
      white-space: nowrap;
    }

    #${ROOT_ID} .te-badge.ok {
      color: #16a34a;
      border-color: color-mix(in srgb, #16a34a 34%, transparent);
      background: color-mix(in srgb, #16a34a 12%, transparent);
    }

    #${ROOT_ID} .te-badge.warn {
      color: #d97706;
      border-color: color-mix(in srgb, #d97706 34%, transparent);
      background: color-mix(in srgb, #d97706 12%, transparent);
    }

    #${ROOT_ID} .te-section-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }

    #${ROOT_ID} .te-restart-banner {
      display: none;
      align-items: center;
      gap: 8px;
      margin-top: 10px;
      padding: 8px 10px;
      border: 1px solid var(--te-accent);
      border-radius: 9px;
      background: color-mix(in srgb, var(--te-accent) 12%, transparent);
      font-size: 11px;
    }

    #${ROOT_ID} .te-restart-banner.show { display: flex; }
    #${ROOT_ID} .te-restart-banner button { margin-left: auto; flex: 0 0 auto; }

    /* A card already uses the surface colour, so a secondary button inside one
       needs the solid panel colour to stay readable. */
    #${ROOT_ID} .te-pane[data-pane="settings"] .te-secondary,
    #${ROOT_ID} .te-pane[data-pane="about"] .te-secondary {
      background: var(--te-panel-solid);
    }

    #${ROOT_ID} .te-about {
      display: grid;
      gap: 12px;
      align-content: start;
    }

    /* Identity block. The version is stated here and nowhere else, so the update
       card below can report status without repeating the number. */
    #${ROOT_ID} .te-about-hero {
      display: grid;
      grid-template-columns: 46px minmax(0, 1fr);
      gap: 13px;
      align-items: center;
      padding: 14px;
      border: 1px solid var(--te-border);
      border-radius: 12px;
      background:
        radial-gradient(130% 150% at 0% 0%, color-mix(in srgb, var(--te-accent) 15%, transparent) 0%, transparent 64%),
        var(--te-surface);
    }

    #${ROOT_ID} .te-about-icon {
      width: 46px;
      height: 46px;
      display: grid;
      place-items: center;
      border-radius: 13px;
      color: var(--te-accent-fg);
      background: linear-gradient(160deg, color-mix(in srgb, var(--te-accent) 78%, #ffffff) 0%, var(--te-accent) 100%);
      box-shadow: 0 6px 16px color-mix(in srgb, var(--te-accent) 30%, transparent);
    }

    #${ROOT_ID} .te-about-name {
      font-size: 14.5px;
      font-weight: 700;
      letter-spacing: -.01em;
    }

    #${ROOT_ID} .te-about-summary {
      margin-top: 3px;
      color: var(--te-muted);
      font-size: 10.5px;
      line-height: 1.55;
    }

    #${ROOT_ID} .te-about-version {
      display: inline-flex;
      margin-top: 7px;
      padding: 2px 8px;
      border-radius: 999px;
      color: var(--te-accent);
      background: color-mix(in srgb, var(--te-accent) 12%, transparent);
      font-size: 10px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }

    /* Steps: hairline rows inside one card, not a bordered card per row. */
    #${ROOT_ID} .te-feature-list { display: grid; margin-top: 4px; }

    #${ROOT_ID} .te-feature {
      display: grid;
      grid-template-columns: 22px minmax(0, 1fr);
      gap: 10px;
      align-items: start;
      padding: 10px 0;
    }

    #${ROOT_ID} .te-feature + .te-feature {
      border-top: 1px solid color-mix(in srgb, var(--te-border) 62%, transparent);
    }

    #${ROOT_ID} .te-feature-icon {
      width: 22px;
      height: 22px;
      display: grid;
      place-items: center;
      border-radius: 999px;
      color: var(--te-accent);
      background: color-mix(in srgb, var(--te-accent) 12%, transparent);
      font-size: 10px;
      font-weight: 750;
      font-variant-numeric: tabular-nums;
    }

    #${ROOT_ID} .te-feature-title {
      display: block;
      font-size: 11.5px;
      font-weight: 650;
    }

    #${ROOT_ID} .te-feature-desc {
      display: block;
      margin-top: 3px;
      color: var(--te-muted);
      font-size: 10.5px;
      line-height: 1.55;
    }

    #${ROOT_ID} .te-toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--te-border);
      background: color-mix(in srgb, var(--te-surface) 58%, transparent);
      flex: 0 0 auto;
    }

    #${ROOT_ID} .te-toolbar-summary {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 9px;
      color: var(--te-muted);
      font-size: 11px;
      white-space: nowrap;
    }

    #${ROOT_ID} .te-toolbar-stat strong {
      margin-left: 3px;
      color: var(--te-text);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }

    #${ROOT_ID} .te-toolbar-actions {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    #${ROOT_ID} .te-primary,
    #${ROOT_ID} .te-secondary {
      height: 32px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      border-radius: 9px;
      padding: 0 11px;
      border: 1px solid transparent;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
    }

    #${ROOT_ID} .te-primary {
      color: var(--te-accent-fg);
      background: var(--te-accent);
    }

    #${ROOT_ID} .te-secondary {
      color: var(--te-text);
      border-color: var(--te-border);
      background: var(--te-surface);
    }

    #${ROOT_ID} .te-account-io {
      width: 32px;
      padding: 0;
      flex: 0 0 32px;
    }

    #${ROOT_ID} .te-primary:hover,
    #${ROOT_ID} .te-secondary:hover { filter: brightness(1.06); }

    #${ROOT_ID} button:disabled {
      opacity: .52;
      cursor: not-allowed;
      transform: none !important;
    }

    #${ROOT_ID} .te-list {
      min-height: 0;
      display: grid;
      gap: 8px;
      overflow: auto;
      padding: 10px 12px;
      flex: 1 1 auto;
      align-content: start;
    }

    #${ROOT_ID} .te-card {
      display: block;
      padding: 12px;
      border: 1px solid var(--te-border);
      border-radius: 10px;
      background: var(--te-surface);
    }

    #${ROOT_ID} .te-card.current {
      border-color: color-mix(in srgb, #22a06b 42%, var(--te-border));
      box-shadow: inset 3px 0 0 #22a06b;
    }

    #${ROOT_ID} .te-account-row {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    #${ROOT_ID} .te-account-main {
      min-width: 0;
      flex: 1 1 auto;
    }

    #${ROOT_ID} .te-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
      font-weight: 650;
    }

    #${ROOT_ID} .te-account-ops {
      display: flex;
      align-items: center;
      gap: 5px;
      flex: 0 0 auto;
    }

    #${ROOT_ID} .te-meta-row {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 13px;
      min-width: 0;
      margin-top: 8px;
      color: var(--te-muted);
      font-size: 10.5px;
    }

    #${ROOT_ID} .te-meta-item {
      min-width: 0;
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }

    #${ROOT_ID} .te-meta-label {
      color: var(--te-muted);
      flex: 0 0 auto;
    }

    #${ROOT_ID} .te-meta-value {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--te-text);
      font-weight: 600;
    }

    #${ROOT_ID} .te-checkin-state.checked {
      color: #22a06b;
    }

    #${ROOT_ID} .te-keepalive-state.checked {
      color: #22a06b;
    }

    #${ROOT_ID} .te-checkin-state.error {
      color: #ef4444;
    }

    #${ROOT_ID} .te-keepalive-state.error {
      color: #ef4444;
    }

    #${ROOT_ID} .te-keepalive-state.warning {
      color: #f59e0b;
    }

    #${ROOT_ID} .te-transfer-note {
      margin: 0 0 12px;
      padding: 10px 12px;
      border: 1px solid var(--te-border);
      border-left: 3px solid var(--te-accent);
      border-radius: 6px;
      background: var(--te-surface);
      color: var(--te-muted);
      font-size: 12px;
      line-height: 1.6;
    }

    #${ROOT_ID} .te-checkin-state.pending {
      color: var(--te-muted);
    }

    #${ROOT_ID} .te-keepalive-state.pending {
      color: var(--te-muted);
    }

    #${ROOT_ID} .te-credit-block {
      display: flex;
      align-items: baseline;
      gap: 6px;
      margin-top: 9px;
      padding-top: 9px;
      border-top: 1px solid color-mix(in srgb, var(--te-border) 80%, transparent);
    }

    #${ROOT_ID} .te-credit-label {
      color: var(--te-muted);
      font-size: 10px;
    }

    #${ROOT_ID} .te-credit-value {
      color: var(--te-accent);
      font-size: 15px;
      font-weight: 750;
      font-variant-numeric: tabular-nums;
    }

    #${ROOT_ID} .te-credit-detail {
      min-width: 0;
      margin-left: auto;
      overflow: hidden;
      color: var(--te-muted);
      font-size: 10px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    #${ROOT_ID} .te-current {
      padding: 3px 7px;
      border-radius: 999px;
      color: #22a06b;
      background: color-mix(in srgb, #22a06b 13%, transparent);
      font-size: 10px;
      font-weight: 700;
      white-space: nowrap;
    }

    #${ROOT_ID} .te-acc-credits {
      position: relative;
    }

    #${ROOT_ID} .te-cred-dot {
      position: absolute;
      top: 4px;
      right: 4px;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #ef4444;
      box-shadow: 0 0 0 2px var(--te-panel-solid);
    }

    /* Anchored to the icon but parented to the root, so a long list can never be
       clipped by the scrolling account area. */
    #${ROOT_ID} .te-cred-pop {
      position: fixed;
      z-index: 2147483646;
      width: 262px;
      max-height: 330px;
      overflow: auto;
      padding: 10px 11px;
      border: 1px solid var(--te-border);
      border-radius: 10px;
      background: var(--te-panel-solid);
      color: var(--te-text);
      box-shadow: 0 14px 34px rgba(0, 0, 0, .3);
      font-size: 11px;
      line-height: 1.5;
    }

    #${ROOT_ID} .te-cred-pop-head {
      margin-bottom: 6px;
      font-size: 11.5px;
      font-weight: 650;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    #${ROOT_ID} .te-cred-pop-head span {
      color: var(--te-muted);
      font-weight: 500;
    }

    #${ROOT_ID} .te-cred-pop-block {
      margin-top: 7px;
    }

    #${ROOT_ID} .te-cred-pop-block.urgent {
      padding: 7px 8px 5px;
      border: 1px solid color-mix(in srgb, #f59e0b 45%, transparent);
      border-radius: 7px;
      background: color-mix(in srgb, #f59e0b 9%, transparent);
    }

    #${ROOT_ID} .te-cred-pop-title {
      color: var(--te-muted);
      font-size: 9.5px;
      font-weight: 700;
      letter-spacing: .05em;
    }

    #${ROOT_ID} .te-cred-pop-note {
      margin-top: 2px;
      color: #f59e0b;
      font-size: 10px;
    }

    #${ROOT_ID} .te-cred-pop-row {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding: 2px 0;
    }

    #${ROOT_ID} .te-cred-pop-source {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    #${ROOT_ID} .te-cred-pop-amount {
      flex: 0 0 auto;
      font-weight: 650;
      font-variant-numeric: tabular-nums;
    }

    #${ROOT_ID} .te-cred-pop-when {
      flex: 0 0 auto;
      color: var(--te-muted);
      font-variant-numeric: tabular-nums;
    }

    #${ROOT_ID} .te-cred-pop-block.urgent .te-cred-pop-when {
      color: #f59e0b;
      font-weight: 650;
    }

    #${ROOT_ID} .te-cred-pop-empty {
      padding: 6px 0 2px;
      color: var(--te-muted);
    }

    #${ROOT_ID} .te-empty {
      padding: 30px 18px;
      text-align: center;
      color: var(--te-muted);
      border: 1px dashed var(--te-border);
      border-radius: 10px;
    }

    /* Sits on its own line under the failure message instead of running on. */
    #${ROOT_ID} .te-empty .te-adopt-retry {
      display: block;
      margin: 12px auto 0;
    }

    #${ROOT_ID} .te-footer {
      min-height: 34px;
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 0 12px;
      border-top: 1px solid var(--te-border);
      color: var(--te-muted);
      font-size: 10px;
      flex: 0 0 auto;
    }

    #${ROOT_ID} .te-dot {
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: #ef4444;
    }

    #${ROOT_ID} .te-dot.online { background: #22a06b; }

    #${ROOT_ID} .te-toast {
      position: absolute;
      right: 8px;
      bottom: 42px;
      max-width: calc(100% - 16px);
      padding: 8px 10px;
      border: 1px solid var(--te-border);
      border-radius: 9px;
      color: var(--te-text);
      background: var(--te-panel-solid);
      box-shadow: 0 8px 24px rgba(0,0,0,.24);
      opacity: 0;
      pointer-events: none;
      transform: translateY(5px);
      transition: opacity .16s, transform .16s;
    }

    #${ROOT_ID} .te-toast.show {
      opacity: 1;
      transform: translateY(0);
    }

    #${ROOT_ID} .te-modal-mask {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: none;
      place-items: center;
      padding: 16px;
      background: rgba(0,0,0,.38);
      backdrop-filter: blur(3px);
      -webkit-backdrop-filter: blur(3px);
    }

    #${ROOT_ID} .te-modal-mask.open { display: grid; }

    #${ROOT_ID} .te-modal {
      width: min(360px, calc(100vw - 32px));
      padding: 18px;
      border: 1px solid var(--te-border);
      border-radius: 12px;
      color: var(--te-text);
      background: var(--te-panel-solid);
      box-shadow: 0 22px 70px rgba(0,0,0,.38);
    }

    #${ROOT_ID} .te-modal-title {
      font-size: 15px;
      font-weight: 700;
    }

    #${ROOT_ID} .te-modal-status {
      min-height: 42px;
      margin-top: 10px;
      color: var(--te-muted);
      font-size: 12px;
      line-height: 1.6;
    }

    #${ROOT_ID} .te-transfer-select-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 14px;
      color: var(--te-muted);
      font-size: 11px;
    }

    #${ROOT_ID} .te-transfer-toggle {
      border: 0;
      color: var(--te-accent);
      background: transparent;
      font: inherit;
      cursor: pointer;
    }

    #${ROOT_ID} .te-transfer-options {
      max-height: 168px;
      display: grid;
      gap: 6px;
      margin-top: 8px;
      overflow: auto;
    }

    #${ROOT_ID} .te-transfer-option {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 8px 9px;
      border: 1px solid var(--te-border);
      border-radius: 9px;
      background: var(--te-surface);
      cursor: pointer;
    }

    #${ROOT_ID} .te-transfer-option.selected {
      border-color: var(--te-accent);
    }

    #${ROOT_ID} .te-transfer-option input {
      width: 15px;
      height: 15px;
      flex: 0 0 15px;
      accent-color: var(--te-accent);
    }

    #${ROOT_ID} .te-transfer-option-copy { min-width: 0; }

    #${ROOT_ID} .te-transfer-option-name {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
      font-weight: 650;
    }

    #${ROOT_ID} .te-transfer-option-meta {
      display: block;
      margin-top: 2px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--te-muted);
      font-size: 10px;
    }

    #${ROOT_ID} .te-field {
      display: grid;
      gap: 6px;
      margin-top: 12px;
      color: var(--te-muted);
      font-size: 11px;
    }

    #${ROOT_ID} .te-field input {
      width: 100%;
      height: 34px;
      padding: 0 10px;
      border: 1px solid var(--te-border);
      border-radius: 8px;
      outline: 0;
      color: var(--te-text);
      background: var(--te-surface);
      font: inherit;
    }

    #${ROOT_ID} .te-field input:focus {
      border-color: var(--te-accent);
      box-shadow: 0 0 0 1px var(--te-accent);
    }

    #${ROOT_ID} .te-transfer-file {
      margin-top: 12px;
      padding: 9px 10px;
      overflow: hidden;
      border: 1px solid var(--te-border);
      border-radius: 8px;
      background: var(--te-surface);
      font-size: 11px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    #${ROOT_ID} .te-modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 16px;
    }

    /* The upgrade progress bar. The track is the border colour so it stays legible
       on both the light and the dark workbench without naming any colour twice. */
    #${ROOT_ID} .te-install-bar {
      height: 6px;
      margin-top: 12px;
      border-radius: 999px;
      overflow: hidden;
      background: color-mix(in srgb, var(--te-border) 70%, transparent);
    }

    #${ROOT_ID} .te-install-bar-fill {
      width: 0;
      height: 100%;
      border-radius: inherit;
      background: var(--te-accent);
      transition: width .2s cubic-bezier(.16,1,.3,1);
    }

    #${ROOT_ID} .te-install-bar[hidden] {
      display: none;
    }

    #${ROOT_ID} .te-spinner {
      width: 13px;
      height: 13px;
      border: 2px solid currentColor;
      border-right-color: transparent;
      border-radius: 50%;
      animation: te-spin .7s linear infinite;
    }

    @keyframes te-spin { to { transform: rotate(360deg); } }

    @media (max-width: 640px) {
      #${ROOT_ID} { right: 12px; bottom: 12px; }
      #${ROOT_ID} .te-panel { bottom: 50px; }
    }

    /* Settings keep the existing panel skin, but use an internal index so the
       controls are no longer one long stack. */
    #${ROOT_ID} .te-pane[data-pane="settings"] {
      overflow: hidden;
      padding: 0;
    }

    /* Settings: the categories are a segmented strip above the content.
       The old 108px left rail ate a third of the panel and squeezed every
       control into a column too narrow to read. */
    #${ROOT_ID} .te-settings-shell {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
    }

    #${ROOT_ID} .te-settings-nav {
      display: flex;
      gap: 4px;
      padding: 9px 12px;
      border-bottom: 1px solid var(--te-border);
      background: color-mix(in srgb, var(--te-surface) 55%, transparent);
      flex: 0 0 auto;
    }

    #${ROOT_ID} .te-settings-nav-item {
      height: 30px;
      padding: 0 12px;
      border: 1px solid transparent;
      border-radius: 8px;
      color: var(--te-muted);
      background: transparent;
      font: inherit;
      font-size: 11.5px;
      font-weight: 650;
      white-space: nowrap;
      cursor: pointer;
    }

    #${ROOT_ID} .te-settings-nav-item:hover {
      color: var(--te-text);
      background: var(--te-surface-hover);
    }

    #${ROOT_ID} .te-settings-nav-item.active {
      border-color: var(--te-border);
      color: var(--te-text);
      background: var(--te-panel-solid);
      box-shadow: 0 1px 2px rgba(0,0,0,.1);
    }

    #${ROOT_ID} .te-settings-panels {
      min-width: 0;
      min-height: 0;
      overflow: auto;
      padding: 14px;
      flex: 1 1 auto;
    }

    #${ROOT_ID} .te-settings-panel { display: none; }
    #${ROOT_ID} .te-settings-panel.active { display: grid; gap: 12px; align-content: start; }

    /* Card head: one title level per card, so settings never render an <h2>
       directly above another <h2> that means something different. */
    #${ROOT_ID} .te-card-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }

    #${ROOT_ID} .te-card-title {
      margin: 0;
      font-size: 12.5px;
      font-weight: 700;
      letter-spacing: -.005em;
    }

    #${ROOT_ID} .te-card-sub {
      margin: 3px 0 0;
      color: var(--te-muted);
      font-size: 10.5px;
      line-height: 1.55;
    }

    /* One setting per row: name and explanation on the left, control on the
       right. Hairlines replace the nested boxes the old stack used. */
    #${ROOT_ID} .te-set-rows { display: grid; margin-top: 2px; }

    #${ROOT_ID} .te-set-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 11px 0;
      cursor: pointer;
    }

    #${ROOT_ID} .te-set-row + .te-set-row {
      border-top: 1px solid color-mix(in srgb, var(--te-border) 62%, transparent);
    }

    /* The prose row above draws its hairline on the row below, so the first row
       still visible after a mode hides its siblings must drop it again —
       otherwise a stray line floats above the single remaining field. */
    #${ROOT_ID} .te-set-row.te-row-first { border-top: 0; }

    #${ROOT_ID} .te-set-text { min-width: 0; display: grid; gap: 2px; }
    #${ROOT_ID} .te-set-name { color: var(--te-text); font-size: 11.5px; font-weight: 600; }

    #${ROOT_ID} .te-set-hint {
      color: var(--te-muted);
      font-size: 10px;
      line-height: 1.5;
    }

    #${ROOT_ID} .te-set-row .te-select {
      min-width: 116px;
      max-width: 172px;
      flex: 0 0 auto;
    }

    /* ---- Proxy (settings › 网络) ----------------------------------------- */

    /* Three exclusive modes as whole-card targets: the description stays
       attached to the option it explains, instead of sitting in a paragraph the
       reader has to map back onto a radio. */
    #${ROOT_ID} .te-net-modes { display: grid; gap: 8px; margin-top: 12px; }

    #${ROOT_ID} .te-net-mode {
      display: grid;
      grid-template-columns: 16px minmax(0, 1fr);
      gap: 10px;
      align-items: start;
      padding: 10px 11px;
      border: 1px solid var(--te-border);
      border-radius: 10px;
      background: var(--te-panel-solid);
      cursor: pointer;
    }

    #${ROOT_ID} .te-net-mode:hover {
      border-color: color-mix(in srgb, var(--te-accent) 45%, var(--te-border));
    }

    #${ROOT_ID} .te-net-mode.selected {
      border-color: var(--te-accent);
      background: color-mix(in srgb, var(--te-accent) 10%, var(--te-panel-solid));
    }

    #${ROOT_ID} .te-net-mode input {
      margin: 2px 0 0;
      accent-color: var(--te-accent);
      cursor: pointer;
    }

    #${ROOT_ID} .te-net-mode-body { display: grid; gap: 2px; min-width: 0; }
    #${ROOT_ID} .te-net-mode-name { font-size: 11.5px; font-weight: 650; }
    #${ROOT_ID} .te-net-mode-desc { color: var(--te-muted); font-size: 10px; line-height: 1.5; }

    #${ROOT_ID} .te-net-fields { margin-top: 2px; }

    /* A settings-row control, sized to a value rather than to the full width, so
       it reads on one line the way the select rows already do. */
    #${ROOT_ID} .te-input {
      flex: 0 0 auto;
      width: 180px;
      height: 30px;
      padding: 0 9px;
      border: 1px solid var(--te-border);
      border-radius: 8px;
      outline: 0;
      color: var(--te-text);
      background: var(--te-panel-solid);
      font: inherit;
      font-size: 11px;
    }

    #${ROOT_ID} .te-input:hover {
      border-color: color-mix(in srgb, var(--te-accent) 45%, var(--te-border));
    }

    #${ROOT_ID} .te-input:focus-visible {
      border-color: var(--te-accent);
      box-shadow: 0 0 0 1px var(--te-accent);
    }

    #${ROOT_ID} .te-input::placeholder {
      color: color-mix(in srgb, var(--te-muted) 82%, transparent);
    }

    #${ROOT_ID} .te-net-port { width: 86px; }

    /* The plaintext-credential warning and the SOCKS5 note. Shop talk lives
       here, never in the mode descriptions above. */
    #${ROOT_ID} .te-net-note {
      margin: 10px 0 0;
      padding: 9px 10px;
      border: 1px solid color-mix(in srgb, #d97706 34%, transparent);
      border-radius: 9px;
      background: color-mix(in srgb, #d97706 10%, transparent);
      color: var(--te-text);
      font-size: 10px;
      line-height: 1.55;
    }

    #${ROOT_ID} .te-net-note.info {
      border-color: color-mix(in srgb, var(--te-accent) 34%, transparent);
      background: color-mix(in srgb, var(--te-accent) 9%, transparent);
    }

    #${ROOT_ID} .te-net-clear {
      padding: 0;
      border: 0;
      color: var(--te-accent);
      background: none;
      font: inherit;
      font-weight: 650;
      text-decoration: underline;
      cursor: pointer;
    }

    /* One sentence of verdict, colour-coded to its severity. */
    #${ROOT_ID} .te-net-verdict {
      display: none;
      margin-top: 12px;
      padding: 9px 11px;
      border: 1px solid var(--te-border);
      border-left-width: 3px;
      border-radius: 9px;
      background: var(--te-panel-solid);
      font-size: 10.5px;
      line-height: 1.6;
    }

    #${ROOT_ID} .te-net-verdict.show { display: block; }
    #${ROOT_ID} .te-net-verdict.ok { border-left-color: #16a34a; }
    #${ROOT_ID} .te-net-verdict.hint { border-left-color: #d97706; }
    #${ROOT_ID} .te-net-verdict.error { border-left-color: #ef4444; }

    /* Advanced detail stays folded: the four primary controls above are the
       whole of what a first-time user has to deal with. */
    #${ROOT_ID} .te-net-advanced {
      margin-top: 12px;
      padding: 11px 12px;
      border: 1px solid color-mix(in srgb, var(--te-border) 70%, transparent);
      border-radius: 9px;
      background: color-mix(in srgb, var(--te-surface) 60%, transparent);
    }

    #${ROOT_ID} .te-net-advanced summary {
      color: var(--te-text);
      font-size: 11px;
      font-weight: 650;
      cursor: pointer;
    }

    #${ROOT_ID} .te-net-advanced summary::marker { color: var(--te-accent); }
    #${ROOT_ID} .te-net-advanced .te-status-list { margin-top: 8px; padding-top: 0; border-top: 0; }

    #${ROOT_ID} .te-danger {
      min-height: 32px;
      padding: 0 11px;
      border: 1px solid #ef4444;
      border-radius: 8px;
      color: #ffffff;
      background: #ef4444;
      font: inherit;
      font-weight: 650;
      cursor: pointer;
    }

    #${ROOT_ID} .te-danger:disabled { opacity: .5; }
    #${ROOT_ID} .te-acc-delete:hover { color: #ef4444; }
    #${ROOT_ID} .te-acc-renew:hover { color: var(--te-accent); }
    #${ROOT_ID} .te-acc-credits:hover { color: var(--te-accent); }

    /* Update card. The version itself lives in the hero above, so this card only
       reports status and what to do about it. */
    #${ROOT_ID} .te-update-card { display: grid; gap: 12px; }
    #${ROOT_ID} .te-update-state {
      margin: 0;
      color: var(--te-muted);
      font-size: 10.5px;
      line-height: 1.6;
    }
    #${ROOT_ID} .te-update-notes {
      display: grid;
      gap: 8px;
      max-height: 208px;
      overflow: auto;
      padding: 11px 12px;
      border: 1px solid color-mix(in srgb, var(--te-border) 70%, transparent);
      border-radius: 9px;
      background: var(--te-panel-solid);
    }
    #${ROOT_ID} .te-update-notes h4 { margin: 4px 0 0; font-size: 11px; }
    #${ROOT_ID} .te-update-notes h4:first-child { margin-top: 0; }
    #${ROOT_ID} .te-update-notes p,
    #${ROOT_ID} .te-update-notes li {
      margin: 0;
      color: var(--te-muted);
      font-size: 10.5px;
      line-height: 1.6;
    }
    #${ROOT_ID} .te-update-notes ul { margin: 0; padding-left: 17px; display: grid; gap: 4px; }
    #${ROOT_ID} .te-update-notes code {
      padding: 1px 4px;
      border-radius: 4px;
      background: var(--te-surface-hover);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 10.5px;
    }
    #${ROOT_ID} .te-update-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    #${ROOT_ID} .te-update-steps {
      margin: 0;
      padding-left: 16px;
      display: grid;
      gap: 4px;
      color: var(--te-muted);
      font-size: 10.5px;
      line-height: 1.6;
    }

    /* The one collapsible block on the About tab. */
    #${ROOT_ID} .te-about-details {
      padding: 12px 14px;
      border: 1px solid var(--te-border);
      border-radius: 12px;
      background: color-mix(in srgb, var(--te-surface) 60%, transparent);
    }
    #${ROOT_ID} .te-about-details summary {
      color: var(--te-text);
      font-size: 11.5px;
      font-weight: 650;
      cursor: pointer;
    }
    #${ROOT_ID} .te-about-details summary::marker { color: var(--te-accent); }
    #${ROOT_ID} .te-about-details p {
      margin: 8px 0 0;
      color: var(--te-muted);
      font-size: 10.5px;
      line-height: 1.6;
    }

    /* Keyboard users need to see where they are: the panel floats over the IDE,
       so the focus ring has to come from the panel itself. */
    #${ROOT_ID} button:focus-visible,
    #${ROOT_ID} summary:focus-visible {
      outline: 2px solid var(--te-accent);
      outline-offset: 1px;
    }

    /* One shared motion budget: hover and state changes only, never a bounce. */
    #${ROOT_ID} button,
    #${ROOT_ID} select,
    #${ROOT_ID} summary,
    #${ROOT_ID} .te-set-row {
      transition: background-color .15s cubic-bezier(.16, 1, .3, 1),
                  border-color .15s cubic-bezier(.16, 1, .3, 1),
                  color .15s cubic-bezier(.16, 1, .3, 1);
    }

    @media (prefers-reduced-motion: reduce) {
      #${ROOT_ID} *,
      #${ROOT_ID} *::before,
      #${ROOT_ID} *::after {
        transition-duration: .01ms !important;
        animation-duration: .01ms !important;
      }
    }

    @media (max-width: 420px) {
      #${ROOT_ID} .te-settings-nav { padding: 8px; }
      #${ROOT_ID} .te-settings-nav-item { padding: 0 9px; font-size: 11px; }
      #${ROOT_ID} .te-set-row { gap: 10px; }
      #${ROOT_ID} .te-set-row .te-select { min-width: 96px; max-width: 132px; }
    }
  `;
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.id = ROOT_ID;

  const panel = document.createElement("section");
  panel.className = "te-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "增强助手");

  const header = document.createElement("div");
  header.className = "te-header";
  header.innerHTML = `
    <div class="te-title">增强助手</div>
    <div class="te-subtitle">账号</div>
    <button class="te-icon-btn te-close" type="button" title="关闭" aria-label="关闭">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="M18 6 6 18M6 6l12 12"/>
      </svg>
    </button>
  `;

  const tabs = document.createElement("div");
  tabs.className = "te-tabs";
  tabs.innerHTML = `
    <button class="te-tab active" type="button" data-tab="account">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
        <circle cx="12" cy="7" r="4"/>
      </svg>
      <span>账号</span>
    </button>
    <button class="te-tab" type="button" data-tab="settings">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.1A1.7 1.7 0 0 0 15.1 4.7a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.1a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1.02z"/>
      </svg>
      <span>设置</span>
    </button>
    <button class="te-tab" type="button" data-tab="about">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <path d="M12 16v-4M12 8h.01"/>
      </svg>
      <span>关于</span>
      <span class="te-tab-dot" hidden></span>
    </button>
  `;

  const content = document.createElement("div");
  content.className = "te-content";

  const accountPane = document.createElement("div");
  accountPane.className = "te-pane active";
  accountPane.dataset.pane = "account";

  const toolbar = document.createElement("div");
  toolbar.className = "te-toolbar";
  toolbar.innerHTML = `
    <div class="te-toolbar-summary">
      <span class="te-toolbar-stat">账号数 <strong class="te-account-count">0</strong></span>
      <span class="te-toolbar-stat">总余额 <strong class="te-total-credit">--</strong></span>
    </div>
    <div class="te-toolbar-actions">
      <button class="te-primary te-login-new" type="button">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="10" cy="8" r="4"/>
          <path d="M2 21a8 8 0 0 1 16 0M19 8v6M16 11h6"/>
        </svg>
        <span>登录</span>
      </button>
      <button class="te-secondary te-account-io te-export-accounts" type="button" title="导出账号" aria-label="导出账号">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3v12M7 10l5 5 5-5"/>
          <path d="M5 21h14"/>
        </svg>
      </button>
      <button class="te-secondary te-account-io te-import-accounts" type="button" title="导入账号" aria-label="导入账号">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 17V5M7 10l5-5 5 5"/>
          <path d="M5 21h14"/>
        </svg>
      </button>
      <button class="te-secondary te-account-io te-run-checkin" type="button" title="立即签到" aria-label="立即签到">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="5" width="18" height="16" rx="2"/>
          <path d="M16 3v4M8 3v4M3 11h18"/>
          <path d="m9 16 2 2 4-4"/>
        </svg>
      </button>
      <button class="te-secondary te-account-io te-refresh" type="button" title="刷新" aria-label="刷新">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/>
        </svg>
      </button>
    </div>
  `;

  const list = document.createElement("div");
  list.className = "te-list";

  accountPane.append(toolbar, list);

  const aboutPane = document.createElement("div");
  aboutPane.className = "te-pane";
  aboutPane.dataset.pane = "about";
  aboutPane.innerHTML = `
    <div class="te-about">
      <header class="te-about-hero">
        <span class="te-about-icon">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="4" y="7" width="16" height="12" rx="3"/>
            <path d="M9 12h.01M15 12h.01M9 16h6M12 7V4M9 4h6"/>
          </svg>
        </span>
        <div>
          <div class="te-about-name">TRAE 增强助手</div>
          <p class="te-about-summary">账号信息只保存在这台电脑。切换、备份、签到都在本地完成，不会上传到别处。</p>
          <span class="te-about-version">v${APP_VERSION}</span>
        </div>
      </header>
      <section class="te-section te-update-card">
        <div class="te-card-head">
          <div>
            <div class="te-card-title">助手更新</div>
            <p class="te-card-sub">发现新版本时，这个页签会亮起小红点，更新内容显示在下面。</p>
          </div>
          <span class="te-badge te-update-badge">未检查</span>
        </div>
        <p class="te-update-state"></p>
        <div class="te-update-notes" hidden></div>
        <ol class="te-update-steps" hidden>
          <li>点「立即升级」：助手会下载并校验新版，然后自动安装，全程不用离开 TRAE。</li>
          <li>安装时助手服务要重启，面板会短暂消失，装好后自动回来。</li>
          <li>万一没回来，重新打开一次桌面快捷方式即可。</li>
        </ol>
        <div class="te-update-actions">
          <button class="te-primary te-update-open" type="button" hidden>立即升级</button>
          <button class="te-secondary te-update-check" type="button">检查更新</button>
          <button class="te-secondary te-update-reload" type="button" hidden>重载界面</button>
        </div>
      </section>
      <section class="te-section">
        <div class="te-section-title">三步上手</div>
        <div class="te-feature-list">
          <article class="te-feature">
            <span class="te-feature-icon">1</span>
            <div>
              <span class="te-feature-title">添加账号</span>
              <span class="te-feature-desc">点「登录」，在浏览器完成授权后，账号会自动出现在列表里，当前正在用的账号不会被打断。</span>
            </div>
          </article>
          <article class="te-feature">
            <span class="te-feature-icon">2</span>
            <div>
              <span class="te-feature-title">切换账号</span>
              <span class="te-feature-desc">点账号卡片右侧的切换按钮。TRAE 会短时间重启，原来的账号会自动备份，失败也会恢复。</span>
            </div>
          </article>
          <article class="te-feature">
            <span class="te-feature-icon">3</span>
            <div>
              <span class="te-feature-title">换电脑</span>
              <span class="te-feature-desc">用导出、导入迁移账号。导出文件由你设置的密码加密，请把密码单独保存好。</span>
            </div>
          </article>
        </div>
      </section>
      <section class="te-section">
        <div class="te-section-title">自动维护</div>
        <p class="te-section-hint te-feature-checkin">每天自动核对签到状态，并在需要时更新账号信息。</p>
        <p class="te-section-hint">只在登录信息临近到期时才更新，避免频繁操作影响其他设备。</p>
      </section>
      <section class="te-section">
        <div class="te-section-title">还能做什么</div>
        <div class="te-feature-list">
          <article class="te-feature">
            <span class="te-feature-icon">+</span>
            <div>
              <span class="te-feature-title">积分到期提醒</span>
              <span class="te-feature-desc">积分快到期时在账号列表标个红点，点积分图标看明细。</span>
            </div>
          </article>
          <article class="te-feature">
            <span class="te-feature-icon">+</span>
            <div>
              <span class="te-feature-title">关闭 TRAE 自动更新</span>
              <span class="te-feature-desc">在「设置 → 更新」里禁止 TRAE 自己升级，避免升级打断正在进行的会话；重启 TRAE 后生效。</span>
            </div>
          </article>
          <article class="te-feature">
            <span class="te-feature-icon">+</span>
            <div>
              <span class="te-feature-title">网络代理</span>
              <span class="te-feature-desc">需要经过代理才能连上 TRAE 服务器时，在「设置 → 网络」里配置，保存后立即生效。</span>
            </div>
          </article>
        </div>
      </section>
      <details class="te-about-details">
        <summary>数据安全</summary>
        <p>导出后的账号是一份搬迁副本，不是共享账号。原设备继续使用或更新登录信息后，另一台设备上的副本可能失效，需要重新登录。</p>
      </details>
    </div>
  `;

  const updateTabDot = tabs.querySelector(".te-tab-dot");
  const updateUi = {
    badge: aboutPane.querySelector(".te-update-badge"),
    state: aboutPane.querySelector(".te-update-state"),
    notes: aboutPane.querySelector(".te-update-notes"),
    steps: aboutPane.querySelector(".te-update-steps"),
    open: aboutPane.querySelector(".te-update-open"),
    check: aboutPane.querySelector(".te-update-check"),
    reload: aboutPane.querySelector(".te-update-reload"),
  };

  const settingsPane = document.createElement("div");
  settingsPane.className = "te-pane";
  settingsPane.dataset.pane = "settings";
  settingsPane.innerHTML = `
    <div class="te-settings-shell">
      <nav class="te-settings-nav" aria-label="设置分类">
        <button class="te-settings-nav-item active" type="button" data-settings-section="checkin">签到</button>
        <button class="te-settings-nav-item" type="button" data-settings-section="update">更新</button>
        <button class="te-settings-nav-item" type="button" data-settings-section="network">网络</button>
        <button class="te-settings-nav-item" type="button" data-settings-section="maintenance">维护</button>
      </nav>
      <div class="te-settings-panels">
        <section class="te-settings-panel active" data-settings-panel="checkin">
          <div class="te-section">
            <div class="te-card-head">
              <div>
                <div class="te-card-title">自动签到</div>
                <p class="te-card-sub">只给今天还没签到的账号补领，不会切换当前账号。</p>
              </div>
              <span class="te-badge te-checkin-badge">未读取</span>
            </div>
            <div class="te-set-rows">
              <label class="te-set-row">
                <span class="te-set-text">
                  <span class="te-set-name">自动签到</span>
                  <span class="te-set-hint">关闭后仍可手动领取，打开面板时也会核对一次</span>
                </span>
                <select class="te-select te-checkin-auto"><option value="on">开启</option><option value="off">关闭</option></select>
              </label>
              <label class="te-set-row">
                <span class="te-set-text">
                  <span class="te-set-name">检查间隔</span>
                  <span class="te-set-hint">每隔多久扫一次，发现还没领的账号就补上</span>
                </span>
                <select class="te-select te-checkin-interval"></select>
              </label>
              <label class="te-set-row">
                <span class="te-set-text">
                  <span class="te-set-name">积分到期提醒</span>
                  <span class="te-set-hint">快到期时在账号列表标个红点，点积分图标看明细</span>
                </span>
                <select class="te-select te-checkin-reminder"></select>
              </label>
              <label class="te-set-row">
                <span class="te-set-text">
                  <span class="te-set-name">页面加载时补签</span>
                  <span class="te-set-hint">TRAE 重启后立刻检查一次，不用等间隔</span>
                </span>
                <select class="te-select te-checkin-clientload"><option value="on">开启</option><option value="off">关闭</option></select>
              </label>
            </div>
            <div class="te-status-list te-checkin-status"></div>
            <div class="te-section-actions"><button class="te-primary te-checkin-save" type="button">保存设置</button></div>
          </div>
        </section>
        <section class="te-settings-panel" data-settings-panel="update">
          <div class="te-section">
            <div class="te-card-head">
              <div>
                <div class="te-card-title">TRAE 自动更新</div>
                <p class="te-card-sub">关闭后 TRAE 不会自己升级，手动检查更新照常可用。</p>
              </div>
              <span class="te-badge te-trae-badge">未读取</span>
            </div>
            <div class="te-set-rows">
              <label class="te-set-row">
                <span class="te-set-text">
                  <span class="te-set-name">更新方式</span>
                  <span class="te-set-hint">推荐禁止，避免升级打断正在进行的会话；改的是 TRAE 自己的设置文件</span>
                </span>
                <select class="te-select te-trae-mode"><option value="suppress">禁止自动更新</option><option value="allow">允许自动更新</option></select>
              </label>
            </div>
            <div class="te-status-list te-trae-status"></div>
            <div class="te-section-actions"><button class="te-primary te-trae-save" type="button">保存设置</button></div>
            <div class="te-restart-banner te-trae-restart"><span>已保存，重启 TRAE 后生效。</span></div>
          </div>
          <div class="te-section">
            <div class="te-card-head">
              <div>
                <div class="te-card-title">助手更新</div>
                <p class="te-card-sub">发现新版本后「关于」页会亮起小红点。只读取公开的发布信息，不涉及账号数据。</p>
              </div>
              <span class="te-badge te-app-update-badge">未读取</span>
            </div>
            <div class="te-set-rows">
              <label class="te-set-row">
                <span class="te-set-text">
                  <span class="te-set-name">自动检查</span>
                  <span class="te-set-hint">关闭后仍可用「立即检查」手动查一次</span>
                </span>
                <select class="te-select te-app-update-auto"><option value="on">开启</option><option value="off">关闭</option></select>
              </label>
            </div>
            <div class="te-status-list te-app-update-status"></div>
            <div class="te-section-actions">
              <button class="te-primary te-app-update-save" type="button">保存设置</button>
              <button class="te-secondary te-app-update-check" type="button">立即检查</button>
            </div>
          </div>
        </section>
        <section class="te-settings-panel" data-settings-panel="network">
          <div class="te-section">
            <div class="te-card-head">
              <div>
                <div class="te-card-title">网络代理</div>
                <p class="te-card-sub">需要经过代理才能连上 TRAE 服务器时，在这里设置。保存后立即生效，不用重启。</p>
              </div>
              <span class="te-badge te-net-badge">未读取</span>
            </div>
            <div class="te-net-modes" role="radiogroup" aria-label="代理模式">
              <label class="te-net-mode selected">
                <input type="radio" name="te-net-mode" value="off" checked>
                <span class="te-net-mode-body">
                  <span class="te-net-mode-name">不使用代理</span>
                  <span class="te-net-mode-desc">直接连网，不经过代理。普通网络用这个。</span>
                </span>
              </label>
              <label class="te-net-mode">
                <input type="radio" name="te-net-mode" value="system">
                <span class="te-net-mode-body">
                  <span class="te-net-mode-name">使用系统代理</span>
                  <span class="te-net-mode-desc">跟随 Windows 里已配置的代理，公司内网通常选这个。</span>
                </span>
              </label>
              <label class="te-net-mode">
                <input type="radio" name="te-net-mode" value="custom">
                <span class="te-net-mode-body">
                  <span class="te-net-mode-name">使用自定义代理</span>
                  <span class="te-net-mode-desc">自己填写代理地址，适用于系统只配了自动脚本(PAC)或需要固定代理的情况。</span>
                </span>
              </label>
            </div>

            <div class="te-net-fields">
              <div class="te-set-rows">
                <label class="te-set-row te-net-custom-only">
                  <span class="te-set-text">
                    <span class="te-set-name">类型</span>
                    <span class="te-set-hint">不确定就选 HTTP，Clash 等工具的混合端口通常是 HTTP</span>
                  </span>
                  <select class="te-select te-net-scheme">
                    <option value="http">HTTP</option>
                    <option value="https">HTTPS</option>
                    <option value="socks5">SOCKS5</option>
                  </select>
                </label>
                <label class="te-set-row te-net-custom-only">
                  <span class="te-set-text">
                    <span class="te-set-name">地址</span>
                    <span class="te-set-hint">可直接粘贴完整代理链接，会自动拆分</span>
                  </span>
                  <input class="te-input te-net-host" type="text" placeholder="127.0.0.1" autocomplete="off" spellcheck="false">
                </label>
                <label class="te-set-row te-net-custom-only">
                  <span class="te-set-text">
                    <span class="te-set-name">端口</span>
                    <span class="te-set-hint">代理工具里显示的端口号</span>
                  </span>
                  <input class="te-input te-net-port" type="text" inputmode="numeric" placeholder="7890" autocomplete="off">
                </label>
                <label class="te-set-row te-net-custom-only">
                  <span class="te-set-text">
                    <span class="te-set-name">账号</span>
                    <span class="te-set-hint">代理不需要认证就留空</span>
                  </span>
                  <input class="te-input te-net-user" type="text" placeholder="可留空" autocomplete="off" spellcheck="false">
                </label>
                <label class="te-set-row te-net-custom-only">
                  <span class="te-set-text">
                    <span class="te-set-name">密码</span>
                    <span class="te-set-hint">只填账号不填密码也支持</span>
                  </span>
                  <input class="te-input te-net-pass" type="password" placeholder="可留空" autocomplete="new-password">
                </label>
                <label class="te-set-row">
                  <span class="te-set-text">
                    <span class="te-set-name">不走代理的地址</span>
                    <span class="te-set-hint">多个用英文逗号分隔；本机地址始终不走代理</span>
                  </span>
                  <input class="te-input te-net-noproxy" type="text" placeholder="*.corp.example.com" autocomplete="off" spellcheck="false">
                </label>
              </div>
              <p class="te-net-note te-net-socks-hint">需要代理端支持 SOCKS5。如果你用的是 Clash 的 7890 混合端口，选 HTTP 即可。</p>
              <p class="te-net-note te-net-credential-note">
                账号密码以明文保存在本机 data/config.json，请勿在共享电脑上填写。
                <span class="te-net-credential-state"></span>
              </p>
            </div>

            <div class="te-net-verdict te-net-result"></div>

            <div class="te-section-actions">
              <button class="te-primary te-net-save" type="button">保存设置</button>
              <button class="te-secondary te-net-test" type="button">测试连接</button>
            </div>

            <details class="te-net-advanced">
              <summary>高级信息</summary>
              <div class="te-status-list te-net-status"></div>
            </details>
          </div>
        </section>
        <section class="te-settings-panel" data-settings-panel="maintenance">
          <div class="te-section">
            <div class="te-card-head">
              <div>
                <div class="te-card-title">后台服务</div>
                <p class="te-card-sub">面板没有响应时，可以单独重启助手自己的后台服务。账号数据和设置都不受影响。</p>
              </div>
            </div>
            <div class="te-section-actions"><button class="te-secondary te-daemon-restart" type="button">重启后台服务</button></div>
          </div>
        </section>
      </div>
    </div>
  `;

  content.append(accountPane, settingsPane, aboutPane);

  const footer = document.createElement("div");
  footer.className = "te-footer";
  footer.innerHTML = '<span class="te-dot"></span><span class="te-status">连接中</span>';

  const toast = document.createElement("div");
  toast.className = "te-toast";

  // Parented to the root rather than to the panel: the panel scrolls and clips,
  // and a popover anchored to a row inside it would be cut off at the edge.
  const creditPopover = document.createElement("div");
  creditPopover.className = "te-cred-pop";
  creditPopover.hidden = true;

  panel.append(header, tabs, content, footer, toast);

  const oauthMask = document.createElement("div");
  oauthMask.className = "te-modal-mask";
  oauthMask.innerHTML = `
    <div class="te-modal" role="dialog" aria-modal="true" aria-label="登录新账号">
      <div class="te-modal-title te-login-progress-title">登录新账号</div>
      <div class="te-modal-status">正在创建授权会话...</div>
      <div class="te-modal-actions">
        <button class="te-secondary te-oauth-reopen" type="button">重新打开</button>
        <button class="te-primary te-oauth-cancel" type="button">取消</button>
      </div>
    </div>
  `;

  const transferMask = document.createElement("div");
  transferMask.className = "te-modal-mask";
  transferMask.innerHTML = `
    <div class="te-modal" role="dialog" aria-modal="true" aria-label="账号导入导出">
      <div class="te-modal-title te-transfer-title"></div>
      <div class="te-transfer-body"></div>
      <div class="te-modal-status te-transfer-status"></div>
      <div class="te-modal-actions">
        <button class="te-secondary te-transfer-cancel" type="button">取消</button>
        <button class="te-primary te-transfer-confirm" type="button">确定</button>
      </div>
    </div>
  `;

  const deleteMask = document.createElement("div");
  deleteMask.className = "te-modal-mask";
  deleteMask.innerHTML = `
    <div class="te-modal" role="dialog" aria-modal="true" aria-label="删除账号备份">
      <div class="te-modal-title">删除账号备份</div>
      <div class="te-modal-status te-delete-status"></div>
      <div class="te-modal-actions">
        <button class="te-secondary te-delete-cancel" type="button">取消</button>
        <button class="te-danger te-delete-submit" type="button">删除</button>
      </div>
    </div>
  `;

  /**
   * Confirmation for switching accounts.
   *
   * A switch is not a reversible in-place action: it force-closes the TRAE the
   * user is looking at and relaunches it on another account, so anything unsaved
   * is lost. Doing that from a single icon click was too easy to trigger by
   * accident, hence the same confirm-then-act shape the delete flow already uses.
   */
  const switchMask = document.createElement("div");
  switchMask.className = "te-modal-mask";
  switchMask.innerHTML = `
    <div class="te-modal" role="dialog" aria-modal="true" aria-label="切换账号">
      <div class="te-modal-title">切换账号</div>
      <div class="te-modal-status te-switch-status"></div>
      <div class="te-modal-actions">
        <button class="te-secondary te-switch-cancel" type="button">取消</button>
        <button class="te-primary te-switch-submit" type="button">切换</button>
      </div>
    </div>
  `;

  /**
   * The upgrade progress box.
   *
   * It is a modal rather than a line inside the About card because the download
   * takes minutes and the card sits at the bottom of a scrollable page: the user
   * asked for the upgrade and needs to see that it is happening, not to keep an
   * eye on one line of text. The mask also has no dismiss path while an upgrade
   * is running — the one thing that must not happen is the user losing track of
   * an install that is already writing to disk.
   */
  const installMask = document.createElement("div");
  installMask.className = "te-modal-mask";
  installMask.innerHTML = `
    <div class="te-modal" role="dialog" aria-modal="true" aria-label="升级助手">
      <div class="te-modal-title te-install-title"></div>
      <div class="te-modal-status te-install-status"></div>
      <div class="te-install-bar" hidden><div class="te-install-bar-fill"></div></div>
      <div class="te-modal-actions">
        <button class="te-secondary te-install-close" type="button" hidden>关闭</button>
        <button class="te-primary te-install-retry" type="button" hidden>重试</button>
      </div>
    </div>
  `;
  const installUi = {
    title: installMask.querySelector(".te-install-title"),
    status: installMask.querySelector(".te-install-status"),
    bar: installMask.querySelector(".te-install-bar"),
    fill: installMask.querySelector(".te-install-bar-fill"),
    close: installMask.querySelector(".te-install-close"),
    retry: installMask.querySelector(".te-install-retry"),
  };

  const importFileInput = document.createElement("input");
  importFileInput.type = "file";
  importFileInput.accept = ".json,application/json";
  importFileInput.hidden = true;

  const fab = document.createElement("button");
  fab.className = "te-fab";
  fab.type = "button";
  fab.title = "增强助手";
  fab.setAttribute("aria-label", "打开增强助手");
  fab.innerHTML = `
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="4" y="7" width="16" height="12" rx="3"/>
      <path d="M9 12h.01M15 12h.01M9 16h6M12 7V4M9 4h6"/>
    </svg>
  `;

  root.append(
    panel,
    oauthMask,
    transferMask,
    deleteMask,
    switchMask,
    installMask,
    creditPopover,
    importFileInput,
    fab,
  );
  document.body.appendChild(root);

  let toastTimer = null;
  let refreshGeneration = 0;
  let insightsRefreshGeneration = 0;
  let activeTab = "account";
  let accountCount = 0;
  let oauthSession = null;
  let oauthPollTimer = null;
  let transferBusy = false;
  let transferSubmit = null;
  let checkinBusy = false;
  // True while the daemon is reconciling check-in state after the panel was
  // opened. Accounts without a confirmed record show "同步中" instead of the
  // misleading "待签到" during that window.
  let syncingCheckin = false;
  // Why the automatic adoption of the signed-in account failed, if it did. Kept
  // here so the empty state can say it instead of looking like "no accounts yet".
  let adoptionError = null;
  let accountsById = new Map();
  // The last painted account list, kept so a settings change can redraw it
  // without asking the daemon for the same payload again.
  let accountsView = null;
  // How many days ahead of expiry a credit segment starts being flagged. The
  // daemon owns the value; this only holds the last one it reported, and the
  // default matches the daemon's so the first paint is not wrong either.
  let creditReminderDays = 7;
  // The icon whose popover is currently open, or null. Held as the element rather
  // than an id so a repaint that detaches it closes the popover with it.
  let creditPopoverAnchor = null;
  let deleteAccountId = null;
  let deleteAccountName = "";
  let switchAccountId = null;
  let switchAccountName = "";
  let switchBusy = false;

  /**
   * 合并版 Trae CN 的 workbench CSP 禁止 `connect-src http:`，但放行 `ws:`，
   * 面板因此只能通过 WebSocket 访问守护进程。下面的 API 形状与原来的 HTTP 完全
   * 一致，只有最底下的传输层由 fetch 换成了 ws。
   */
  let rpcSocket = null;
  let rpcOpen = null;
  let rpcId = 0;
  const rpcPending = new Map();

  function panicRpc(error) {
    const entries = [...rpcPending.values()];
    rpcPending.clear();
    for (const entry of entries) entry.reject(error);
  }

  function openRpcSocket() {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(`${API_BASE.replace(/^http:/, "ws:")}/panel`);
      } catch (error) {
        rpcSocket = null;
        panicRpc(new Error(`无法连接增强服务 (${API_BASE})`));
        reject(error);
        return;
      }
      ws.onopen = () => {
        rpcSocket = ws;
        resolve(ws);
      };
      ws.onerror = () => {
        rpcSocket = null;
        panicRpc(new Error(`无法连接增强服务 (${API_BASE})`));
        reject(new Error("websocket error"));
      };
      ws.onclose = () => {
        rpcSocket = null;
        panicRpc(new Error("增强服务通道已断开"));
      };
      ws.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        const entry = rpcPending.get(msg.id);
        if (!entry) return;
        rpcPending.delete(msg.id);
        if (msg.ok) {
          entry.resolve(msg.data ?? {});
          return;
        }
        // 优先用响应体里的 error 字段：msg.error 是原始 JSON 文本，直接抛给用户
        // 会变成一长串花括号。
        const error = new Error(msg.data?.error || msg.error || `HTTP ${msg.status}`);
        /**
         * The daemon's own error codes are carried through so a caller can act on
         * what happened instead of on the sentence describing it. `install-in-flight`
         * is the one that matters here: an upgrade already running is progress, not
         * a failure, and matching Chinese text to tell them apart would break the
         * moment either string is reworded.
         */
        if (typeof msg.data?.code === "string") error.code = msg.data.code;
        entry.reject(error);
      };
    });
  }

  function sendRpc(msg) {
    if (rpcSocket && rpcSocket.readyState === 1) {
      rpcSocket.send(JSON.stringify(msg));
      return;
    }
    if (!rpcOpen) {
      rpcOpen = openRpcSocket()
        .catch(() => undefined)
        .finally(() => {
          rpcOpen = null;
        });
    }
    rpcOpen.then((ws) => {
      try {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
      } catch {
        // The socket died between the check and the send.
      }
    });
  }

  /**
   * 刻意不加超时：`/api/accounts/switch` 要等守护进程走完「停 Trae → 清除本机
   * 登录信息 → 重启 Trae → 等 CDP」整个过程，远超过任何合理的固定超时值。连接
   * 真的断了会由 onclose/onerror 统一 reject，这才是正确的失败信号。
   */
  function api(path, options = {}) {
    const body = options.body === undefined ? undefined : String(options.body);
    return new Promise((resolve, reject) => {
      const id = ++rpcId;
      rpcPending.set(id, { resolve, reject });
      sendRpc({
        id,
        path,
        method: String(options.method || "GET").toUpperCase(),
        body,
        token: API_TOKEN,
      });
    });
  }

  function showToast(message, error = false) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.style.color = error ? "#ef4444" : "";
    toast.classList.add("show");
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
  }

  function formatTime(value) {
    if (!value) return "";
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  }

  function formatNumber(value) {
    if (!Number.isFinite(Number(value))) return String(value ?? "--");
    return new Intl.NumberFormat("zh-CN", {
      maximumFractionDigits: 2,
    }).format(Number(value));
  }

  function accountMeta(account) {
    return [
      account.phone || account.maskedPhone,
      account.maskedEmail || account.maskedUserId,
    ].filter(Boolean).join(" · ") || "已保存认证";
  }

  function checkinDateKey() {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }

  function accountCheckinView(account) {
    const checkin = account.checkin;
    const checkedToday =
      checkin?.date === checkinDateKey() && checkin.checkedInToday === true;
    if (checkedToday) {
      return {
        label: "已签到",
        state: "checked",
        title: checkin.reward
          ? `今日签到奖励 ${checkin.reward} 积分`
          : checkin.reason === "scheduled"
            ? "今日已自动签到"
            : "今日已签到",
      };
    }
    if (checkin?.error) {
      return {
        label: "失败",
        state: "error",
        title: checkin.error,
      };
    }
    // The daemon reconciles against the server when the panel opens. Until it
    // answers, "待签到" would be a guess: the account may already be checked in
    // and simply have no local record yet, which is the case reported on the
    // intranet machine.
    if (syncingCheckin) {
      return {
        label: "同步中",
        state: "pending",
        title: "正在向服务端核对今日签到状态",
      };
    }
    return {
      label: "待签到",
      state: "pending",
      title: "今日尚未签到",
    };
  }

  const CREDENTIAL_URGENT_MS = 24 * 60 * 60 * 1000;
  const CREDENTIAL_WARN_MS = 7 * 24 * 60 * 60 * 1000;

  function formatExpiry(value) {
    if (!value) return "";
    const date = new Date(value);
    const pad = (part) => String(part).padStart(2, "0");
    return (
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
      ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
    );
  }

  function accountCredentialView(account) {
    const keepalive = account.keepalive;
    if (keepalive?.status === "error") {
      return {
        label: "同步失败",
        state: "error",
        title: keepalive.error || "账号同步失败",
      };
    }
    const expiresAt = new Date(keepalive?.accessExpiresAt || NaN).getTime();
    if (!Number.isFinite(expiresAt)) {
      // An unknown expiry is a bare dash, with no promise attached: the sweep that
      // writes this field can be skipped, and opening the panel already fills it
      // from the account's own snapshot.
      return { label: "-", state: "pending", title: "" };
    }
    const stamp = formatExpiry(keepalive.accessExpiresAt);
    const remaining = expiresAt - Date.now();
    // Past and imminent expiry are label-plus-colour only. No tooltip promises a
    // refresh: the sweep that renews this can be skipped, so the promise can be
    // false. This mirrors the reference panel, which never attaches one here.
    if (remaining <= 0) {
      return { label: `已过期 ${stamp}`, state: "error", title: "" };
    }
    if (remaining < CREDENTIAL_URGENT_MS) {
      return { label: `即将过期 ${stamp}`, state: "error", title: "" };
    }
    if (remaining < CREDENTIAL_WARN_MS) {
      return { label: stamp, state: "warning", title: "" };
    }
    return { label: stamp, state: "checked", title: "" };
  }

  function accountCreditView(account) {
    const insights = account.insights;
    if (!insights) {
      return { value: "--", detail: "额度未同步", error: false };
    }
    const plan = insights.plan || insights.planKey || "套餐未知";
    const quota = insights.quota || {};
    let value = "--";
    let detail = "";
    if (quota.model === "credits") {
      value = quota.credits?.unlimited
        ? "不限量"
        : formatNumber(quota.credits?.remaining ?? "--");
    } else if (quota.model === "fast_request") {
      value = quota.fastLimit === -1
        ? "不限量"
        : formatNumber(quota.fastAvailable ?? "--");
      detail = "速通";
    } else if (quota.model === "usd" && quota.basicQuota > 0) {
      value = formatNumber(quota.basicUsage ?? 0);
      detail = `/ ${formatNumber(quota.basicQuota)}`;
    } else if (quota.fastPerMonth !== null && quota.fastPerMonth !== undefined) {
      value = formatNumber(quota.fastPerMonth);
      detail = "次/月";
    }
    return {
      plan,
      value,
      detail: detail || (insights.resetAt ? `重置 ${formatTime(insights.resetAt)}` : "剩余额度"),
      error: !!insights.error,
    };
  }

  function accountCreditSegments(account) {
    const segments = account?.insights?.credits?.segments;
    return Array.isArray(segments) ? segments : [];
  }

  /**
   * The credit segments that expire inside the reminder window.
   *
   * Deliberately narrow: something left to use, an expiry in the future, and at
   * most `reminderDays` away. A segment already past its date is stale cached
   * data, not a reminder — flagging it would put a permanent red dot on an
   * account whose numbers simply have not been refreshed. `expiresAt: null` means
   * the segment never expires, so it never counts either.
   */
  function expiringCredits(segments, reminderDays, now = Date.now()) {
    const horizon = now + reminderDays * 86400000;
    return (Array.isArray(segments) ? segments : [])
      .filter((segment) => {
        if (!(Number(segment?.remaining) > 0)) return false;
        const expiresAt = Date.parse(segment?.expiresAt ?? "");
        return Number.isFinite(expiresAt) && expiresAt > now && expiresAt <= horizon;
      })
      .sort((left, right) => Date.parse(left.expiresAt) - Date.parse(right.expiresAt));
  }

  function creditDay(value) {
    const parsed = new Date(value);
    if (!value || Number.isNaN(parsed.getTime())) return "长期有效";
    return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(parsed);
  }

  function creditPopoverWhen(segment, urgent) {
    if (!urgent) return creditDay(segment.expiresAt);
    // Always at least one day: a segment expiring in an hour still rounds up.
    return `还有 ${Math.ceil((Date.parse(segment.expiresAt) - Date.now()) / 86400000)} 天`;
  }

  function creditPopoverBlock(title, segments, { urgent = false, note = "" } = {}) {
    const block = document.createElement("div");
    block.className = urgent ? "te-cred-pop-block urgent" : "te-cred-pop-block";
    const heading = document.createElement("div");
    heading.className = "te-cred-pop-title";
    heading.textContent = title;
    block.appendChild(heading);
    if (note) {
      const hint = document.createElement("div");
      hint.className = "te-cred-pop-note";
      hint.textContent = note;
      block.appendChild(hint);
    }
    if (!segments.length) {
      const empty = document.createElement("div");
      empty.className = "te-cred-pop-empty";
      empty.textContent = "暂无积分明细";
      block.appendChild(empty);
      return block;
    }
    for (const segment of segments) {
      const row = document.createElement("div");
      row.className = "te-cred-pop-row";
      const source = document.createElement("span");
      source.className = "te-cred-pop-source";
      source.textContent = segment.source || "积分";
      source.title = source.textContent;
      const amount = document.createElement("span");
      amount.className = "te-cred-pop-amount";
      amount.textContent = formatNumber(segment.remaining);
      const when = document.createElement("span");
      when.className = "te-cred-pop-when";
      when.textContent = creditPopoverWhen(segment, urgent);
      row.append(source, amount, when);
      block.appendChild(row);
    }
    return block;
  }

  function renderCreditPopover(account) {
    const credits = account?.insights?.credits;
    const segments = accountCreditSegments(account);
    const expiring = expiringCredits(segments, creditReminderDays);
    creditPopover.replaceChildren();
    const head = document.createElement("div");
    head.className = "te-cred-pop-head";
    head.textContent = account?.displayName || "TRAE account";
    const total = document.createElement("span");
    if (!credits) total.textContent = " 额度未同步";
    else if (credits.unlimited) total.textContent = " 不限量";
    else total.textContent = ` 剩余 ${formatNumber(credits.remaining)}`;
    head.appendChild(total);
    creditPopover.appendChild(head);
    if (expiring.length) {
      const urgent = expiring.reduce((sum, segment) => sum + Number(segment.remaining || 0), 0);
      creditPopover.appendChild(
        creditPopoverBlock("即将到期", expiring, {
          urgent: true,
          note: `共 ${formatNumber(urgent)} 分将在 ${creditReminderDays} 天内到期`,
        }),
      );
    }
    creditPopover.appendChild(creditPopoverBlock("全部构成", segments));
  }

  function closeCreditPopover() {
    if (!creditPopoverAnchor) return;
    creditPopoverAnchor.setAttribute("aria-expanded", "false");
    creditPopoverAnchor = null;
    creditPopover.hidden = true;
  }

  /**
   * Places the popover against the icon it belongs to.
   *
   * Measured after it is laid out, because its height depends on how many
   * segments the account has. Right-aligned to the icon and flipped above it when
   * there is no room below, then clamped to the viewport.
   */
  function positionCreditPopover(anchor) {
    const icon = anchor.getBoundingClientRect();
    const pop = creditPopover.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(
      margin,
      Math.min(icon.right - pop.width, window.innerWidth - pop.width - margin),
    );
    let top = icon.bottom + 6;
    if (top + pop.height > window.innerHeight - margin) {
      top = Math.max(margin, icon.top - pop.height - 6);
    }
    creditPopover.style.left = `${Math.round(left)}px`;
    creditPopover.style.top = `${Math.round(top)}px`;
  }

  function toggleCreditPopover(button, account) {
    if (creditPopoverAnchor === button) {
      closeCreditPopover();
      return;
    }
    closeCreditPopover();
    creditPopoverAnchor = button;
    button.setAttribute("aria-expanded", "true");
    renderCreditPopover(account);
    creditPopover.hidden = false;
    positionCreditPopover(button);
  }

  function renderAccounts(accounts, currentAccountId, currentAccountState) {
    list.replaceChildren();
    // Every row this popover was anchored to is about to be detached, so close it
    // rather than leave it floating over a list it no longer describes.
    closeCreditPopover();
    // Kept so a settings change can redraw the list from memory: the reminder
    // threshold only changes how these same rows are flagged.
    accountsView = { accounts, currentAccountId, currentAccountState };
    accountsById = new Map(accounts.map((account) => [account.id, account]));
    if (!accounts.length) {
      const empty = document.createElement("div");
      empty.className = "te-empty";
      if (adoptionError) {
        // Two different situations, two different messages. Until now both of them
        // read "暂无账号备份", which is why a failed first run looked like a
        // feature that had not been built.
        empty.textContent = `自动纳管当前账号失败：${adoptionError}`;
        const retry = document.createElement("button");
        retry.className = "te-secondary te-adopt-retry";
        retry.type = "button";
        retry.textContent = "重新尝试";
        retry.addEventListener("click", () => {
          retryAutoBackup(retry).catch(() => {});
        });
        empty.append(retry);
      } else if (currentAccountState === "unknown") {
        empty.textContent = "TRAE 尚未登录";
      } else {
        empty.textContent = "暂无账号备份";
      }
      list.appendChild(empty);
      return;
    }

    const totalCredits = accounts.reduce((sum, account) => {
      const credits = account.insights?.credits;
      return sum + (Number.isFinite(credits?.remaining) && credits.remaining >= 0
        ? credits.remaining
        : 0);
    }, 0);
    toolbar.querySelector(".te-account-count").textContent = String(accounts.length);
    toolbar.querySelector(".te-total-credit").textContent =
      accounts.some((account) => account.insights?.credits) ? formatNumber(totalCredits) : "--";

    for (const account of accounts) {
      const card = document.createElement("article");
      card.className = `te-card${account.id === currentAccountId ? " current" : ""}`;

      const row = document.createElement("div");
      row.className = "te-account-row";

      const main = document.createElement("div");
      main.className = "te-account-main";
      const name = document.createElement("div");
      name.className = "te-name";
      name.textContent = account.displayName || "TRAE account";
      main.appendChild(name);

      const ops = document.createElement("div");
      ops.className = "te-account-ops";

      // Sits left of everything else in the row, including on the active account:
      // its credits expire the same way and the popover is read-only anyway.
      const creditsButton = document.createElement("button");
      creditsButton.className = "te-icon-btn te-acc-credits";
      creditsButton.type = "button";
      creditsButton.title = "积分构成";
      creditsButton.dataset.accountId = account.id;
      creditsButton.setAttribute(
        "aria-label",
        `查看 ${account.displayName || "该账号"} 的积分构成`,
      );
      creditsButton.setAttribute("aria-expanded", "false");
      creditsButton.innerHTML = `
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21.2 15.9A10 10 0 1 1 8.3 2.8"/>
          <path d="M22 12A10 10 0 0 0 12 2v10z"/>
        </svg>
      `;
      if (expiringCredits(accountCreditSegments(account), creditReminderDays).length) {
        const dot = document.createElement("span");
        dot.className = "te-cred-dot";
        creditsButton.appendChild(dot);
      }
      ops.appendChild(creditsButton);

      let action;
      if (account.id === currentAccountId) {
        action = document.createElement("span");
        action.className = "te-current";
        action.textContent = "当前";
        ops.appendChild(action);
      } else {
        action = document.createElement("button");
        action.className = "te-icon-btn te-acc-switch";
        action.type = "button";
        action.title = "切换到此账号";
        action.setAttribute("aria-label", "切换到此账号");
        action.dataset.accountId = account.id;
        action.innerHTML = `
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M16 3l4 4-4 4"/>
            <path d="M20 7H8"/>
            <path d="M8 21l-4-4 4-4"/>
            <path d="M4 17h12"/>
          </svg>
        `;
        const renew = document.createElement("button");
        renew.className = "te-icon-btn te-acc-renew";
        renew.type = "button";
        renew.title =
          "续签：现在就换一份新的登录信息，把有效期推后。其他设备上的这个账号需要重新登录。";
        renew.setAttribute("aria-label", `为 ${account.displayName || "该账号"} 续签`);
        renew.dataset.accountId = account.id;
        renew.innerHTML = `
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12a9 9 0 1 1-2.64-6.36"/>
            <path d="M21 3v6h-6"/>
            <path d="M12 8v4l3 2"/>
          </svg>
        `;
        const remove = document.createElement("button");
        remove.className = "te-icon-btn te-acc-delete";
        remove.type = "button";
        remove.title = "删除本地备份";
        remove.setAttribute("aria-label", `删除 ${account.displayName || "该账号"} 的本地备份`);
        remove.dataset.accountId = account.id;
        remove.innerHTML = `
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5"/>
          </svg>
        `;
        ops.append(renew, action, remove);
      }
      row.append(main, ops);

      const creditView = accountCreditView(account);
      const meta = document.createElement("div");
      meta.className = "te-meta-row";
      const phone = document.createElement("span");
      phone.className = "te-meta-item";
      phone.innerHTML = '<span class="te-meta-label">手机</span><span class="te-meta-value"></span>';
      phone.querySelector(".te-meta-value").textContent =
        account.phone || account.maskedPhone || "未获取";
      const plan = document.createElement("span");
      plan.className = "te-meta-item";
      plan.innerHTML = '<span class="te-meta-label">套餐</span><span class="te-meta-value"></span>';
      plan.querySelector(".te-meta-value").textContent = creditView.plan || "未知";
      const checkinView = accountCheckinView(account);
      const checkin = document.createElement("span");
      checkin.className = "te-meta-item";
      checkin.innerHTML = '<span class="te-meta-label">签到</span><span class="te-meta-value te-checkin-state"></span>';
      const checkinValue = checkin.querySelector(".te-checkin-state");
      checkinValue.textContent = checkinView.label;
      checkinValue.classList.add(checkinView.state);
      checkinValue.title = checkinView.title || "";
      const credentialView = accountCredentialView(account);
      const credential = document.createElement("span");
      credential.className = "te-meta-item";
      credential.innerHTML = '<span class="te-meta-label">有效期至</span><span class="te-meta-value te-keepalive-state"></span>';
      const credentialValue = credential.querySelector(".te-keepalive-state");
      credentialValue.textContent = credentialView.label;
      credentialValue.classList.add(credentialView.state);
      credentialValue.title = credentialView.title || "";
      meta.append(phone, plan, checkin, credential);

      const credit = document.createElement("div");
      credit.className = "te-credit-block";
      const creditLabel = document.createElement("span");
      creditLabel.className = "te-credit-label";
      creditLabel.textContent = "剩余";
      const creditValue = document.createElement("strong");
      creditValue.className = "te-credit-value";
      creditValue.textContent = creditView.value;
      const creditDetail = document.createElement("span");
      creditDetail.className = "te-credit-detail";
      creditDetail.textContent = creditView.error ? "额度更新失败" : creditView.detail;
      creditDetail.title = account.insights?.error || creditDetail.textContent;
      credit.append(creditLabel, creditValue, creditDetail);

      card.append(row, meta, credit);
      list.appendChild(card);
    }
  }

  async function refresh() {
    const generation = ++refreshGeneration;
    const refreshButton = toolbar.querySelector(".te-refresh");
    refreshButton.disabled = true;
    try {
      const [health, data] = await Promise.all([api("/api/health"), api("/api/accounts")]);
      if (generation !== refreshGeneration) return;
      const status = footer.querySelector(".te-status");
      const dot = footer.querySelector(".te-dot");
      dot.classList.toggle("online", !!health.cdpConnected);
      status.textContent = health.cdpConnected ? "CDP 已连接" : "等待 CDP";
      accountCount = data.accounts.length;
      renderHeaderSubtitle();
      renderAccounts(data.accounts, data.currentAccountId, data.currentAccountState);
      return data;
    } catch (error) {
      if (generation !== refreshGeneration) return;
      const status = footer.querySelector(".te-status");
      footer.querySelector(".te-dot").classList.remove("online");
      status.textContent = "服务不可用";
      showToast(error.message || String(error), true);
      return null;
    } finally {
      refreshButton.disabled = false;
    }
  }

  /**
   * Adopts the account that is signed in right now.
   *
   * The failure is returned instead of swallowed: "nothing to adopt" and
   * "adoption failed" used to produce the same empty list, which made a broken
   * first run indistinguishable from an account that was never added.
   */
  async function autoBackupCurrent() {
    try {
      const result = await api("/api/accounts/backup", { method: "POST", body: "{}" });
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  async function retryAutoBackup(button) {
    button.disabled = true;
    button.textContent = "纳管中…";
    const backup = await autoBackupCurrent();
    adoptionError = backup.ok ? null : backup.error;
    await refresh();
    if (backup.ok) await reconcileWithDaemon();
  }

  /**
   * Keeps the header caption in step with the active tab.
   *
   * Both a tab switch and a background refresh have to write it, and the shared
   * helper is what stops a refresh from relabelling the settings tab as the
   * account count. The About pane shows the version in its own hero, so the
   * caption names the tab instead of repeating it.
   */
  function renderHeaderSubtitle() {
    header.querySelector(".te-subtitle").textContent =
      activeTab === "about" ? "关于" : activeTab === "settings" ? "设置" : `账号 ${accountCount}`;
  }

  function switchTab(name) {
    activeTab = name === "about" ? "about" : name === "settings" ? "settings" : "account";
    tabs.querySelectorAll(".te-tab").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.tab === activeTab);
    });
    content.querySelectorAll(".te-pane").forEach((pane) => {
      pane.classList.toggle("active", pane.dataset.pane === activeTab);
    });
    renderHeaderSubtitle();
    // Read once, then keep whatever the user has typed: re-reading on every tab
    // switch would silently discard an edit in progress.
    if (activeTab === "settings" && !settingsLoaded) loadSettings().catch(() => {});
    // Only the cached result is read, so switching tabs never reaches the network.
    if (activeTab === "about") loadAppUpdate().catch(() => {});
  }

  function switchSettingsSection(name) {
    const target = ["checkin", "network", "update", "maintenance"].includes(name)
      ? name
      : "checkin";
    settingsPane.querySelectorAll(".te-settings-nav-item").forEach((item) => {
      item.classList.toggle("active", item.dataset.settingsSection === target);
    });
    settingsPane.querySelectorAll(".te-settings-panel").forEach((panel) => {
      panel.classList.toggle("active", panel.dataset.settingsPanel === target);
    });
  }

  function shouldRefreshInsights(accounts) {
    const now = Date.now();
    return accounts.some((account) => {
      const updatedAt = Date.parse(account.insights?.updatedAt || "");
      return !Number.isFinite(updatedAt) || now - updatedAt > 5 * 60 * 1000;
    });
  }

  async function refreshAccountInsights({ manual = false } = {}) {
    const generation = ++insightsRefreshGeneration;
    const button = toolbar.querySelector(".te-refresh");
    if (manual) button.disabled = true;
    try {
      const result = await api("/api/accounts/insights/refresh", {
        method: "POST",
        body: "{}",
      });
      if (generation !== insightsRefreshGeneration) return;
      await refresh();
      if (manual) {
        const details = failureDetails(result);
        const base = result.failed
          ? `额度已更新，${result.failed} 个账号失败`
          : "账号额度已更新";
        showToast(details ? `${base} — ${details}` : base, result.failed > 0);
      }
    } catch (error) {
      if (manual) showToast(error.message || String(error), true);
    } finally {
      if (manual) button.disabled = false;
    }
  }

  /**
   * Asks the daemon to reconcile today's check-in state and credits, then repaints.
   *
   * Used when the panel opens and right after an import. An imported backup carries
   * only authentication state, so those accounts have no check-in record and no
   * credits until the daemon fills them in.
   *
   * `checkinOneAccount()` is idempotent: an account that is already checked in is
   * recorded as such without claiming a second reward. That is what turns the
   * reported "actually checked in, but the panel says pending" into the correct
   * display without the user pressing anything.
   *
   * Returns the daemon result, or null when the request itself failed.
   */
  async function reconcileWithDaemon() {
    let result = null;
    try {
      result = await api("/api/accounts/panel-open", { method: "POST", body: "{}" });
    } catch {
      result = null;
    } finally {
      syncingCheckin = false;
    }
    try {
      await refresh();
    } catch {
      // A later daemon push repaints the panel.
    }
    return result;
  }

  /* ----------------------------------------------------------------------- *
   * Settings tab
   *
   * The release branch only exposes user-level settings that are local and
   * directly verifiable: check-in schedule and TRAE update behaviour.
   * ----------------------------------------------------------------------- */

  const settingsUi = {
    restartButtons: Array.from(settingsPane.querySelectorAll(".te-daemon-restart")),
    traeMode: settingsPane.querySelector(".te-trae-mode"),
    traeBadge: settingsPane.querySelector(".te-trae-badge"),
    traeStatus: settingsPane.querySelector(".te-trae-status"),
    traeSave: settingsPane.querySelector(".te-trae-save"),
    traeRestartBanner: settingsPane.querySelector(".te-trae-restart"),
    checkinBadge: settingsPane.querySelector(".te-checkin-badge"),
    checkinAuto: settingsPane.querySelector(".te-checkin-auto"),
    checkinInterval: settingsPane.querySelector(".te-checkin-interval"),
    checkinReminder: settingsPane.querySelector(".te-checkin-reminder"),
    checkinClientLoad: settingsPane.querySelector(".te-checkin-clientload"),
    checkinStatus: settingsPane.querySelector(".te-checkin-status"),
    checkinSave: settingsPane.querySelector(".te-checkin-save"),
    appUpdateBadge: settingsPane.querySelector(".te-app-update-badge"),
    appUpdateAuto: settingsPane.querySelector(".te-app-update-auto"),
    appUpdateStatus: settingsPane.querySelector(".te-app-update-status"),
    appUpdateSave: settingsPane.querySelector(".te-app-update-save"),
    appUpdateCheck: settingsPane.querySelector(".te-app-update-check"),
    netPanel: settingsPane.querySelector('[data-settings-panel="network"]'),
    netBadge: settingsPane.querySelector(".te-net-badge"),
    netModeInputs: Array.from(settingsPane.querySelectorAll('input[name="te-net-mode"]')),
    netFields: settingsPane.querySelector(".te-net-fields"),
    netScheme: settingsPane.querySelector(".te-net-scheme"),
    netHost: settingsPane.querySelector(".te-net-host"),
    netPort: settingsPane.querySelector(".te-net-port"),
    netUser: settingsPane.querySelector(".te-net-user"),
    netPass: settingsPane.querySelector(".te-net-pass"),
    netNoProxy: settingsPane.querySelector(".te-net-noproxy"),
    netSocksHint: settingsPane.querySelector(".te-net-socks-hint"),
    netCredentialNote: settingsPane.querySelector(".te-net-credential-note"),
    netCredentialState: settingsPane.querySelector(".te-net-credential-state"),
    netResult: settingsPane.querySelector(".te-net-result"),
    netStatus: settingsPane.querySelector(".te-net-status"),
    netSave: settingsPane.querySelector(".te-net-save"),
    netTest: settingsPane.querySelector(".te-net-test"),
  };
  let settingsLoaded = false;
  let traeUpdateNoticeShown = false;

  function appendStatusLine(container, label, value) {
    const line = document.createElement("div");
    line.className = "te-status-line";
    const key = document.createElement("b");
    key.textContent = label;
    const text = document.createElement("span");
    text.textContent = value;
    line.append(key, text);
    container.append(line);
  }

  /**
   * Renders the TRAE auto-update section.
   *
   * The value in the file and the saved preference are reported separately: TRAE
   * reads `update.mode` when it starts, so a freshly written value is not live yet,
   * and a section that only said "已禁止" would be wrong until TRAE restarts.
   */
  function renderTraeUpdate(update) {
    if (!update) return;
    const readable = update.readable !== false;
    const suppressed = Boolean(update.settingsSuppressed);
    settingsUi.traeBadge.className = `te-badge te-trae-badge${readable ? (suppressed ? " ok" : " warn") : " warn"}`;
    settingsUi.traeBadge.textContent = readable ? (suppressed ? "已禁止" : "未禁止") : "读取失败";
    settingsUi.traeMode.value = update.suppress ? "suppress" : "allow";

    settingsUi.traeStatus.textContent = "";
    appendStatusLine(settingsUi.traeStatus, "设置文件", update.path ?? "-");
    appendStatusLine(
      settingsUi.traeStatus,
      "文件中的值",
      readable
        ? update.settingsExists
          ? update.fileMode
            ? `update.mode = ${update.fileMode}`
            : "未写入（TRAE 使用默认值，每 60 分钟检查一次）"
          : "文件不存在"
        : "无法读取",
    );
    if (update.error) appendStatusLine(settingsUi.traeStatus, "错误", update.error);
    if (update.backupPath) {
      appendStatusLine(settingsUi.traeStatus, "改动前备份", update.backupPath);
    }
    if (update.startupNotice && !traeUpdateNoticeShown) {
      traeUpdateNoticeShown = true;
      appendStatusLine(
        settingsUi.traeStatus,
        "本次启动",
        "已自动写入一次（这是默认设置）。不想改动 TRAE 的配置文件，就在下面选择「允许自动更新」并保存。",
      );
      showToast("已自动为 TRAE 关闭自动更新，可在设置里改回");
    }
  }

  async function saveTraeUpdate() {
    const suppress = settingsUi.traeMode.value !== "allow";
    settingsUi.traeSave.disabled = true;
    try {
      const data = await api("/api/settings/trae-update", {
        method: "POST",
        body: JSON.stringify({ suppress }),
      });
      renderTraeUpdate(data.traeUpdate);
      if (data.traeUpdate?.changed === false) {
        settingsUi.traeRestartBanner.classList.remove("show");
        showToast("TRAE 的设置本来就是这个值，没有改动");
      } else {
        settingsUi.traeRestartBanner.classList.add("show");
        showToast(suppress ? "已禁止 TRAE 自动更新，重启 TRAE 后生效" : "已恢复 TRAE 自动更新，重启 TRAE 后生效");
      }
    } catch (error) {
      showToast(error.message || String(error), true);
    } finally {
      settingsUi.traeSave.disabled = false;
    }
  }

  /**
   * Enables or disables the two fields the master switch governs.
   *
   * Disabled rather than hidden, so the values that come back on re-enabling stay
   * visible. It covers the automatic runs only: opening the panel and the
   * 「立即签到」 button are deliberate user actions and stay available either way.
   */
  function applyCheckinVisibility(auto) {
    settingsUi.checkinInterval.disabled = !auto;
    settingsUi.checkinClientLoad.disabled = !auto;
  }

  function renderCheckin(checkin) {
    if (!checkin) return;
    // The allowed intervals come from the daemon, so the panel cannot drift away
    // from the values the daemon will actually accept.
    settingsUi.checkinInterval.textContent = "";
    for (const minutes of checkin.options ?? []) {
      const option = document.createElement("option");
      option.value = String(minutes);
      option.textContent = `每 ${minutes} 分钟`;
      settingsUi.checkinInterval.append(option);
    }
    settingsUi.checkinInterval.value = String(checkin.intervalMinutes);
    // Same reason as the interval above: the allowed thresholds belong to the
    // daemon, and a second copy here is how the two would drift apart.
    settingsUi.checkinReminder.textContent = "";
    for (const days of checkin.reminderOptions ?? []) {
      const option = document.createElement("option");
      option.value = String(days);
      option.textContent = `${days} 天`;
      settingsUi.checkinReminder.append(option);
    }
    settingsUi.checkinReminder.value = String(checkin.reminderDays);
    settingsUi.checkinAuto.value = checkin.auto ? "on" : "off";
    settingsUi.checkinClientLoad.value = checkin.onClientLoad ? "on" : "off";
    applyCheckinVisibility(checkin.auto);
    applyCreditReminderDays(checkin);

    settingsUi.checkinBadge.className = `te-badge te-checkin-badge${checkin.auto ? " ok" : ""}`;
    settingsUi.checkinBadge.textContent = checkin.auto ? "已开启" : "已关闭";

    // When it is on, the rows above already spell out the interval and the
    // restart behaviour, so repeating them here is noise. The note is only worth
    // a line when it is off: that is the state where "nothing runs by itself any
    // more" has to be said out loud. An empty list collapses on its own.
    settingsUi.checkinStatus.textContent = "";
    if (!checkin.auto) {
      appendStatusLine(
        settingsUi.checkinStatus,
        "说明",
        "已关闭自动签到。打开面板仍会核对今日状态，「立即签到」按钮照常可用。",
      );
    }
  }

  async function saveCheckinConfig() {
    const body = {
      auto: settingsUi.checkinAuto.value === "on",
      intervalMinutes: Number(settingsUi.checkinInterval.value),
      onClientLoad: settingsUi.checkinClientLoad.value === "on",
      reminderDays: Number(settingsUi.checkinReminder.value),
    };
    settingsUi.checkinSave.disabled = true;
    try {
      const data = await api("/api/settings/checkin", {
        method: "POST",
        body: JSON.stringify(body),
      });
      renderCheckin(data.checkin);
      applyAboutCheckinText(data.checkin);
      // The daemon rebuilds its schedule in place, so "已保存" and "已生效"
      // are the same moment.
      showToast("已保存，立即生效");
    } catch (error) {
      showToast(error.message || String(error), true);
    } finally {
      settingsUi.checkinSave.disabled = false;
    }
  }

  /**
   * Keeps the feature list honest.
   *
   * The entry used to read "每天自动检查", which stops being true the moment the
   * switch is turned off or the interval changes.
   */
  function applyAboutCheckinText(checkin) {
    const target = aboutPane.querySelector(".te-feature-checkin");
    if (!target || !checkin) return;
    if (!checkin.auto) {
      target.textContent =
        "自动领取已关闭。想手动领就点工具栏上的「立即签到」；打开这个面板时也会自动核对一次。";
      return;
    }
    const every = `每 ${checkin.intervalMinutes} 分钟检查一次，当天还没领的账号自动补领`;
    target.textContent = checkin.onClientLoad
      ? `${every}；TRAE 重启后也会立刻补一次。`
      : `${every}。`;
  }

  /**
   * Read once when the panel opens, so the feature list matches the saved settings
   * even when the settings tab was never visited. Not a poll: it runs on open.
   */
  async function refreshAboutCheckinText() {
    try {
      const data = await api("/api/settings");
      applyAboutCheckinText(data.checkin);
      applyCreditReminderDays(data.checkin);
    } catch {
      // The generic wording stays; it is not worth an error in the panel footer.
    }
  }

  /**
   * Keeps the account list's reminder threshold in step with the saved setting.
   *
   * The list paints before the settings are read, so the first pass uses the
   * default. Repainting from the accounts already on screen is what makes a saved
   * threshold take effect without reopening the panel, and it costs no request:
   * the threshold is a view decision, not account state.
   */
  function applyCreditReminderDays(checkin) {
    const days = Number(checkin?.reminderDays);
    if (!Number.isFinite(days) || days === creditReminderDays) return;
    creditReminderDays = days;
    repaintAccounts();
  }

  function repaintAccounts() {
    if (!accountsView) return;
    renderAccounts(accountsView.accounts, accountsView.currentAccountId, accountsView.currentAccountState);
  }

  /* -----------------------------------------------------------------------
   * Network proxy
   *
   * The saved username and password are never sent back to the panel — the
   * daemon only reports whether a credential exists — so the two credential
   * fields start empty and an untouched field means "keep what is stored".
   * Clearing is therefore an explicit action, offered as a link in the warning
   * line, and a save only sends empty strings when the user asked for that.
   * --------------------------------------------------------------------- */

  let netClearCredentials = false;

  function currentNetMode() {
    return settingsUi.netModeInputs.find((input) => input.checked)?.value ?? "off";
  }

  /**
   * Shows only what the chosen mode needs: nothing for direct, the exception
   * list for the system proxy, and every field for a custom proxy.
   */
  function applyNetVisibility() {
    const mode = currentNetMode();
    const custom = mode === "custom";
    settingsUi.netFields.hidden = mode === "off";
    for (const row of settingsUi.netPanel.querySelectorAll(".te-net-custom-only")) {
      row.hidden = !custom;
    }
    settingsUi.netSocksHint.hidden = !custom || settingsUi.netScheme.value !== "socks5";
    settingsUi.netCredentialNote.hidden = !custom;
    for (const input of settingsUi.netModeInputs) {
      input.closest(".te-net-mode")?.classList.toggle("selected", input.checked);
    }
    // The hairline belongs to the row below, so the first row still visible has
    // to drop it once its predecessors are hidden.
    let first = true;
    for (const row of settingsUi.netPanel.querySelectorAll(".te-net-fields .te-set-row")) {
      if (row.hidden) {
        row.classList.remove("te-row-first");
        continue;
      }
      row.classList.toggle("te-row-first", first);
      first = false;
    }
  }

  function setNetCredentialState(hasCredentials) {
    settingsUi.netCredentialState.textContent = "";
    if (!hasCredentials) return;
    const label = document.createElement("span");
    label.textContent = " 已保存账号密码。留空表示继续使用；";
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "te-net-clear";
    clear.textContent = "清除已保存的账号密码";
    clear.addEventListener("click", () => {
      netClearCredentials = true;
      settingsUi.netUser.value = "";
      settingsUi.netPass.value = "";
      setNetCredentialState(false);
      showToast("保存后会清除已存账号密码");
    });
    settingsUi.netCredentialState.append(label, clear);
  }

  function netProxyFromForm() {
    const proxy = {
      mode: currentNetMode(),
      scheme: settingsUi.netScheme.value,
      host: settingsUi.netHost.value.trim(),
      port: Number(settingsUi.netPort.value.trim()) || 0,
      noProxy: settingsUi.netNoProxy.value.trim(),
    };
    const username = settingsUi.netUser.value.trim();
    const password = settingsUi.netPass.value;
    if (netClearCredentials) {
      proxy.username = "";
      proxy.password = "";
      return proxy;
    }
    // Omitted means "keep the stored value" on the daemon side. The password is
    // compared against "" rather than trimmed: a leading or trailing space can
    // be part of it.
    if (username) proxy.username = username;
    if (password !== "") proxy.password = password;
    return proxy;
  }

  function renderNetVerdict(conclusionText, severity) {
    settingsUi.netResult.className = `te-net-verdict te-net-result show ${severity || "hint"}`;
    settingsUi.netResult.textContent = conclusionText || "";
  }

  function formatNetTarget(state) {
    if (!state?.host) return "无";
    return `${state.scheme}://${state.host}:${state.port}`;
  }

  /**
   * The probe host is already the line label, so this renders only the outcome.
   *
   * The daemon's own formatter is not reachable from here: the panel runs in the
   * workbench renderer, which only ever sees the JSON the daemon sent.
   */
  function formatNetProbeLine(entry) {
    if (Number.isInteger(entry?.httpStatus)) return `可达，HTTP ${entry.httpStatus}`;
    if (entry?.dnsError) return `DNS 失败 → ${entry.dnsError}`;
    if (entry?.error) return `连接失败 → ${entry.error}`;
    return "未知状态";
  }

  function renderNetwork(network) {
    const state = network?.state;
    if (!state) return;
    netClearCredentials = false;

    const mode = ["off", "system", "custom"].includes(state.mode) ? state.mode : "off";
    for (const input of settingsUi.netModeInputs) input.checked = input.value === mode;

    if (mode === "custom") {
      settingsUi.netScheme.value = state.scheme || "http";
      settingsUi.netHost.value = state.host || "";
      settingsUi.netPort.value = state.port ? String(state.port) : "";
      settingsUi.netUser.value = "";
      settingsUi.netPass.value = "";
      settingsUi.netUser.placeholder = state.hasCredentials ? "已设置，留空则不修改" : "可留空";
      settingsUi.netPass.placeholder = state.hasCredentials ? "已设置，留空则不修改" : "可留空";
    }
    // In system mode the reported host and port are the ones derived from the
    // registry, not the user's own entries, so writing them into the hidden
    // fields would overwrite what the custom mode should still remember.
    settingsUi.netNoProxy.value = state.noProxy
      ? // Loopback is always appended by the daemon; showing it back would only
        // invite the user to delete an entry that is put back on save.
        state.noProxy
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry && !["127.0.0.1", "localhost", "::1"].includes(entry))
          .join(", ")
      : "";
    setNetCredentialState(Boolean(state.hasCredentials));
    applyNetVisibility();

    settingsUi.netBadge.className = `te-badge te-net-badge${state.active ? " ok" : ""}`;
    settingsUi.netBadge.textContent =
      state.source === "custom"
        ? "自定义代理"
        : state.source === "system"
          ? state.active
            ? "系统代理"
            : "系统代理不可用"
          : "未使用代理";

    settingsUi.netStatus.textContent = "";
    appendStatusLine(settingsUi.netStatus, "当前目标", formatNetTarget(state));
    appendStatusLine(settingsUi.netStatus, "生效状态", state.active ? "已生效" : "未启用（直连）");
    if (state.reasonText) appendStatusLine(settingsUi.netStatus, "原因", state.reasonText);
    for (const note of state.notes ?? []) appendStatusLine(settingsUi.netStatus, "提示", note);
    if (network.configPath) appendStatusLine(settingsUi.netStatus, "配置文件", network.configPath);
    if (state.system) {
      appendStatusLine(
        settingsUi.netStatus,
        "系统代理",
        state.system.hasServer || state.system.hasAutoConfigUrl
          ? `${state.system.enabled ? "已启用" : "未启用"}｜${
              state.system.server ? `ProxyServer=${state.system.server}` : "无 ProxyServer"
            }${state.system.hasAutoConfigUrl ? "｜仅配置了 PAC 自动脚本" : ""}`
          : "未配置",
      );
    }
    if (state.systemReadError) appendStatusLine(settingsUi.netStatus, "读取系统代理", state.systemReadError);
  }

  /**
   * Splits a pasted `scheme://user:pass@host:port` into the separate fields.
   *
   * Tutorials hand out the whole string and a form that only accepts separate
   * fields leaves the user stuck, so the address box accepts either.
   */
  function maybeSplitProxyUrl() {
    const raw = settingsUi.netHost.value.trim();
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return;
    let url;
    try {
      url = new URL(raw);
    } catch {
      showToast("这段代理链接无法识别，请检查后重试", true);
      return;
    }
    const scheme = url.protocol.replace(":", "").toLowerCase();
    if (scheme !== "http" && scheme !== "https" && scheme !== "socks5") {
      showToast(`不支持的代理协议：${scheme}`, true);
      return;
    }
    settingsUi.netScheme.value = scheme;
    settingsUi.netHost.value = url.hostname;
    settingsUi.netPort.value = url.port || "";
    if (url.username) settingsUi.netUser.value = decodeURIComponent(url.username);
    if (url.password) settingsUi.netPass.value = decodeURIComponent(url.password);
    applyNetVisibility();
    showToast("已从链接中填入代理信息");
  }

  async function saveNetworkConfig() {
    settingsUi.netSave.disabled = true;
    try {
      const data = await api("/api/settings/network", {
        method: "POST",
        body: JSON.stringify({ proxy: netProxyFromForm() }),
      });
      renderNetwork(data.network);
      renderNetVerdict(
        data.network?.state?.active ? "已保存，立即生效。" : "已保存。当前没有启用代理。",
        data.network?.state?.active ? "ok" : "hint",
      );
      showToast("已保存，立即生效");
    } catch (error) {
      showToast(error.message || String(error), true);
    } finally {
      settingsUi.netSave.disabled = false;
    }
  }

  async function testNetworkConfig() {
    settingsUi.netTest.disabled = true;
    renderNetVerdict("正在测试连接…", "hint");
    try {
      const data = await api("/api/settings/network/test", {
        method: "POST",
        body: JSON.stringify({ proxy: netProxyFromForm() }),
      });
      renderNetVerdict(data.conclusionText, data.severity);
      settingsUi.netStatus.textContent = "";
      appendStatusLine(settingsUi.netStatus, "测试模式", currentNetModeLabel());
      for (const entry of data.direct ?? []) {
        appendStatusLine(settingsUi.netStatus, `直连 ${entry.host}`, formatNetProbeLine(entry));
      }
      for (const entry of data.proxied ?? []) {
        appendStatusLine(settingsUi.netStatus, `代理 ${entry.host}`, formatNetProbeLine(entry));
      }
      if (data.proxyReason) {
        appendStatusLine(settingsUi.netStatus, "代理不可用", data.proxyReason);
      }
      for (const note of data.proxyNotes ?? []) appendStatusLine(settingsUi.netStatus, "提示", note);
      if (data.proxyError) appendStatusLine(settingsUi.netStatus, "错误", data.proxyError);
    } catch (error) {
      renderNetVerdict(error.message || String(error), "error");
    } finally {
      settingsUi.netTest.disabled = false;
    }
  }

  function currentNetModeLabel() {
    const mode = currentNetMode();
    return mode === "custom" ? "自定义代理" : mode === "system" ? "系统代理" : "不使用代理";
  }

  /* -----------------------------------------------------------------------
   * Assistant update
   *
   * The panel never talks to GitHub itself: the workbench CSP blocks that, and
   * the daemon already checks once a day. Opening the About tab only reads the
   * daemon's cached result, and a new release arrives as a pushed event.
   * --------------------------------------------------------------------- */

  let appUpdateSnapshot = null;
  let appUpdateConfig = null;
  let appUpdateBusy = false;
  /**
   * The upgrade as the daemon last reported it.
   *
   * Deliberately kept apart from the box below, because the box can be dismissed
   * and this cannot: the button's label has to keep reflecting what the daemon
   * actually knows. Read from every push and every *freshly fetched* payload —
   * never from a snapshot already in hand, since that is the difference between
   * "the daemon says it is downloading" and "the daemon said so once, before the
   * download died".
   */
  let appUpdateStage = "idle";
  /**
   * The upgrade in flight, as the progress box renders it.
   *
   * It lives here rather than inside the click handler on purpose: the About card
   * is repainted from every `/api/update` payload, and a state kept only inside
   * the handler is wiped by the next repaint — which is exactly how the button
   * used to come back to life mid-download and turn a running upgrade into
   * "安装失败" on the second click.
   */
  let appUpdateInstall = null;

  /**
   * The stages that mean the daemon still knows about a live upgrade.
   *
   * These are restored from `/api/update` when the panel is opened, so a panel
   * that was closed and reopened during an upgrade still shows where it is —
   * the handed-over stage included, because its whole job is to tell the user
   * where to find a wizard that opened behind TRAE. `failed` and `cancelled` are
   * deliberately not restored: both have already been said out loud once, and a
   * box that came back on every open would read as a fresh failure.
   */
  const INSTALL_RESUMABLE_STAGES = new Set(["downloading", "verifying", "installing"]);

  const INSTALL_MB = (bytes) =>
    Number.isFinite(bytes) && bytes >= 0 ? (bytes / 1024 / 1024).toFixed(1) : null;

  /**
   * Bytes as "1.4 / 23.7 MB".
   *
   * The bytes are shown next to the percentage on purpose: a percentage alone
   * cannot tell a slow download apart from one that has stopped, and "it is stuck
   * at 6%" is the difference between waiting and reporting a broken proxy.
   */
  function installSizePair(received, total) {
    const done = INSTALL_MB(received);
    const all = INSTALL_MB(total);
    return done !== null && all !== null ? `${done} / ${all} MB` : "";
  }

  /**
   * An upgrade the daemon is still working on — the handed-over stage included,
   * since a wizard that has been started is the most fixed thing here: it may be
   * sitting behind TRAE, and it stops the service on its way in.
   */
  function isUpgradeRunning() {
    return INSTALL_RESUMABLE_STAGES.has(appUpdateStage);
  }

  /**
   * Renders the small Markdown subset used by release notes.
   *
   * Every string comes from GitHub and is therefore untrusted, so nothing is
   * parsed as HTML — headings, bullets, code and bold text are built as nodes
   * with `textContent`. Links are shown as text plus their address rather than
   * an <a>: following one inside the workbench page would navigate the IDE away
   * from its own UI.
   */
  function appendUpdateInline(node, text) {
    const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
    let lastIndex = 0;
    let match;
    while ((match = pattern.exec(text))) {
      if (match.index > lastIndex) node.append(text.slice(lastIndex, match.index));
      if (match[1] !== undefined) {
        const code = document.createElement("code");
        code.textContent = match[1];
        node.append(code);
      } else if (match[2] !== undefined) {
        const strong = document.createElement("strong");
        strong.textContent = match[2];
        node.append(strong);
      } else {
        node.append(`${match[3]} `);
        const code = document.createElement("code");
        code.textContent = match[4];
        node.append(code);
      }
      lastIndex = pattern.lastIndex;
    }
    if (lastIndex < text.length) node.append(text.slice(lastIndex));
  }

  function renderUpdateNotes(container, markdown) {
    container.textContent = "";
    let list = null;
    for (const raw of String(markdown || "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) {
        list = null;
        continue;
      }
      const heading = /^#{1,4}\s+(.*)$/.exec(line);
      if (heading) {
        list = null;
        const element = document.createElement("h4");
        element.textContent = heading[1];
        container.append(element);
        continue;
      }
      const bullet = /^[-*+]\s+(.*)$/.exec(line);
      if (bullet) {
        if (!list) {
          list = document.createElement("ul");
          container.append(list);
        }
        const item = document.createElement("li");
        appendUpdateInline(item, bullet[1]);
        list.append(item);
        continue;
      }
      list = null;
      const paragraph = document.createElement("p");
      appendUpdateInline(paragraph, line);
      container.append(paragraph);
    }
  }

  /**
   * Paints the progress box, or takes it away when there is nothing to report.
   *
   * Every sentence here is about what has actually happened, in the order it
   * happened: the download is the only phase with a percentage, verification is
   * one that never has one, and the last one hands the user over to the installer
   * window that has just opened in front of them.
   */
  function renderInstallMask() {
    const state = appUpdateInstall;
    if (!state) {
      installMask.classList.remove("open");
      return;
    }
    installMask.classList.add("open");

    const version = state.version ? ` v${state.version}` : "";
    const percent = Number.isFinite(state.percent) ? state.percent : null;
    let title = `正在升级助手${version}`;
    let status = "";
    let showBar = false;
    let showClose = false;
    let showRetry = false;

    if (state.stage === "downloading") {
      const size = installSizePair(state.received, state.total);
      status =
        `正在下载安装包${percent === null ? "" : ` ${percent}%`}` +
        `${size ? `（${size}）` : ""}…请不要关闭 TRAE。`;
      showBar = true;
    } else if (state.stage === "verifying") {
      status = "下载完成，正在校验安装包的完整性…";
      showBar = true;
    } else if (state.stage === "installing") {
      title = "安装程序已启动";
      /**
       * Said out loud because it is the one part of this flow TRAE cannot do for
       * the user: Windows only lets the window that owns the foreground hand it
       * to someone else, so a wizard started by the background service shows up
       * on the taskbar and stays behind TRAE. A user who does not know to look
       * there concludes the upgrade did nothing.
       */
      status =
        "安装向导已经打开。如果它没有出现在 TRAE 前面，请到任务栏点一下" +
        "「Trae Meta 安装」窗口。安装期间助手服务会短暂停止，" +
        "向导结束后回到面板点「重载界面」即可。";
      showClose = true;
    } else if (state.stage === "failed") {
      title = "升级失败";
      status = state.error || "安装未能完成。";
      showClose = true;
      showRetry = true;
    } else {
      installMask.classList.remove("open");
      return;
    }

    installUi.title.textContent = title;
    installUi.status.textContent = status;
    installUi.bar.hidden = !showBar;
    installUi.fill.style.width = `${percent ?? 0}%`;
    installUi.close.hidden = !showClose;
    installUi.retry.hidden = !showRetry;
  }

  /**
   * Paints the About card from one `/api/update` payload.
   *
   * A failed check is reported as a failed check, never as "已是最新": the two
   * look identical to the user otherwise, and only one of them is true.
   *
   * `fresh` says the payload came off the wire just now, which is the only case
   * where a live stage may be picked up. A repaint from the snapshot already in
   * hand must not: the snapshot is whatever `/api/update` happened to say at some
   * earlier moment, so restoring from it would resurrect a download that has since
   * died and park the box on its last percentage forever.
   */
  function renderAppUpdate(update, { fresh = false } = {}) {
    if (!update) return;
    appUpdateSnapshot = update;
    /**
     * A panel opened after the upgrade started learns about it here, which is the
     * whole reason the daemon publishes the state on `/api/update` too: the pushes
     * only reach a panel that was already listening.
     */
    if (fresh) {
      appUpdateStage = update.install?.stage ?? "idle";
      if (!appUpdateInstall && INSTALL_RESUMABLE_STAGES.has(update.install?.stage)) {
        appUpdateInstall = { ...update.install };
        renderInstallMask();
      }
    }
    const hasUpdate = Boolean(update.hasUpdate);
    const latest = update.latest;
    updateTabDot.hidden = !hasUpdate;

    let tone = "";
    let badge = "未检查";
    if (hasUpdate) {
      badge = `有新版 v${latest.version}`;
      tone = " warn";
    } else if (update.error) {
      badge = "检查失败";
      tone = " warn";
    } else if (update.checkedAt) {
      badge = "已是最新";
      tone = " ok";
    }
    updateUi.badge.className = `te-badge te-update-badge${tone}`;
    updateUi.badge.textContent = badge;

    const lines = [];
    if (hasUpdate) lines.push(`发现新版本 v${latest.version}，当前 v${update.current}。`);
    else if (update.checkedAt) lines.push(`已是最新版本（v${update.current}）。`);
    else lines.push("还没有检查过更新。点「检查更新」可以立刻查一次。");
    if (update.error) lines.push(`上次检查失败：${update.error}`);
    else if (update.checkedAt) lines.push(`上次检查：${formatExpiry(update.checkedAt)}`);
    // A release the helper refuses to install is said out loud, with the reason:
    // a disabled button on its own would look like a bug in the panel.
    if (hasUpdate && !latest?.installer) {
      lines.push(
        latest?.installerError
          ? `这个版本无法自动安装：${latest.installerError}。`
          : "这个版本无法自动安装。",
      );
    }
    updateUi.state.textContent = lines.join(" ");

    const notes = hasUpdate ? String(latest?.notes || "").trim() : "";
    if (notes) {
      renderUpdateNotes(updateUi.notes, notes);
      updateUi.notes.hidden = false;
    } else {
      updateUi.notes.textContent = "";
      updateUi.notes.hidden = true;
    }
    // The upgrade steps only make sense next to a version to upgrade to, and the
    // button only next to an installer the helper is willing to run.
    updateUi.steps.hidden = !hasUpdate;
    updateUi.open.hidden = !hasUpdate;
    // A running upgrade keeps the button out of reach, so a second click cannot
    // turn "already installing" into a failure message. The label comes from the
    // daemon's own stage, not from the box: a failure the user dismissed is still
    // the last known outcome, so the next click is a retry.
    updateUi.open.disabled = (hasUpdate && !latest?.installer) || isUpgradeRunning();
    updateUi.open.textContent = isUpgradeRunning()
      ? "升级中…"
      : appUpdateStage === "failed"
        ? "重试"
        : "立即升级";
    updateUi.reload.hidden = !hasUpdate;
    updateUi.check.textContent = hasUpdate ? "重新检查" : "检查更新";
    if (appUpdateConfig) renderAppUpdateConfig(appUpdateConfig, update);
  }

  async function loadAppUpdate() {
    try {
      renderAppUpdate(await api("/api/update"), { fresh: true });
    } catch {
      // The daemon is unreachable; the card keeps its previous state and the
      // footer already reports the outage.
    }
  }

  async function checkAppUpdate({ silent = false } = {}) {
    if (appUpdateBusy) return null;
    appUpdateBusy = true;
    updateUi.check.disabled = true;
    settingsUi.appUpdateCheck.disabled = true;
    try {
      const data = await api("/api/update/check", {
        method: "POST",
        body: JSON.stringify({ force: true }),
      });
      renderAppUpdate(data, { fresh: true });
      if (!silent) {
        if (data.hasUpdate) showToast(`发现新版本 v${data.latest.version}`);
        else if (data.error) showToast(`检查更新失败：${data.error}`, true);
        else showToast("已是最新版本");
      }
      return data;
    } catch (error) {
      if (!silent) showToast(error.message || String(error), true);
      return null;
    } finally {
      appUpdateBusy = false;
      updateUi.check.disabled = false;
      settingsUi.appUpdateCheck.disabled = false;
    }
  }

  /**
   * Downloads, verifies and installs the newer release, because the user asked.
   *
   * The request stays open for the whole download, so this only starts the state
   * machine: the box is painted from the daemon's progress pushes, and this
   * function's job is to open it, and to translate the request's own outcome into
   * the same shape. Two things are deliberately not failures — a 409 saying an
   * upgrade is already running (that is progress, and the pushes will drive it),
   * and a dropped connection, which is the installer stopping the daemon on its
   * way in and looks identical to a failure from here.
   */
  async function installAppUpdate() {
    const latest = appUpdateSnapshot?.latest;
    if (!latest?.installer) {
      showToast(latest?.installerError || "还没有可安装的新版本，请先检查更新", true);
      return;
    }
    appUpdateStage = "downloading";
    appUpdateInstall = {
      stage: "downloading",
      version: latest.version,
      percent: 0,
      received: 0,
      total: latest.installer.size,
      error: null,
    };
    renderInstallMask();
    updateUi.check.disabled = true;
    renderAppUpdate(appUpdateSnapshot);
    try {
      await api("/api/update/install", { method: "POST", body: "{}" });
      /**
       * The daemon pushes this stage as well, so this is normally a no-op. It is
       * here so a push that never arrived cannot leave the box frozen at the last
       * download percentage while the installer window is already open: a reply
       * this endpoint only sends after the checks passed is proof enough.
       */
      if (isUpgradeRunning()) {
        appUpdateStage = "installing";
        appUpdateInstall = { ...appUpdateInstall, stage: "installing", percent: 100 };
        renderInstallMask();
      }
      showToast("安装程序已启动");
    } catch (error) {
      if (error?.code === "install-in-flight") {
        /**
         * The daemon is already upgrading, so the optimistic "正在下载 0%" set a
         * moment ago is a lie and is dropped before anything is painted: leaving
         * it up is what made a refused second click look like a second download
         * that then hung. The daemon is the only side that knows whether the
         * download is still running or the wizard is already open, so its own
         * stage is read back — `renderAppUpdate` restores it from there.
         */
        appUpdateInstall = null;
        renderInstallMask();
        await loadAppUpdate();
        showToast("升级已经开始了");
        return;
      }
      if (error instanceof TypeError) {
        appUpdateStage = "installing";
        appUpdateInstall = { ...appUpdateInstall, stage: "installing", percent: 100 };
        renderInstallMask();
        showToast("助手正在重启，稍等片刻");
        return;
      }
      const message = error?.message || String(error);
      appUpdateStage = "failed";
      appUpdateInstall = { ...appUpdateInstall, stage: "failed", error: message, percent: null };
      renderInstallMask();
      showToast(`升级失败：${message}`, true);
    } finally {
      updateUi.check.disabled = false;
      renderAppUpdate(appUpdateSnapshot);
    }
  }

  /**
   * Applies one progress push from the daemon.
   *
   * A push is always the newest thing known about the upgrade, so it overwrites
   * whatever the panel holds: the daemon only sends one when something actually
   * changed, and that change is newer than anything this side inferred.
   */
  function handleUpdateProgress(detail) {
    if (!detail || typeof detail !== "object" || detail.stage === "idle") return;
    appUpdateStage = detail.stage;
    /**
     * The daemon is still alive and saw the wizard exit, which means nothing was
     * installed — it was closed, or it never started. The box has to go away and
     * the button has to come back, or the panel keeps claiming an installer is
     * running that no longer exists.
     */
    if (detail.stage === "cancelled") {
      appUpdateInstall = null;
      renderInstallMask();
      renderAppUpdate(appUpdateSnapshot);
      showToast("安装向导已关闭，本次升级没有完成");
      return;
    }
    appUpdateInstall = { ...detail };
    renderInstallMask();
    renderAppUpdate(appUpdateSnapshot);
  }

  function handleUpdateProgressEvent(event) {
    handleUpdateProgress(event?.detail);
  }
  window.addEventListener(UPDATE_PROGRESS_EVENT, handleUpdateProgressEvent);

  // Dismisses the box and nothing else: `appUpdateStage` keeps what the daemon
  // last said, so the button below still reads "重试" and the repaint from the
  // snapshot already in hand cannot bring the box back.
  installUi.close.addEventListener("click", () => {
    appUpdateInstall = null;
    renderInstallMask();
    renderAppUpdate(appUpdateSnapshot);
  });

  installUi.retry.addEventListener("click", () => {
    installAppUpdate().catch(() => {});
  });

  /**
   * Re-injects the panel from the running daemon.
   *
   * `POST /api/inject` hands the current script to the renderer, whose first
   * lines remove this panel and its style, so this instance is gone the moment
   * the daemon answers. The pause is only so the toast is visible before the
   * panel disappears under the user's cursor.
   */
  async function reloadPanel() {
    updateUi.reload.disabled = true;
    showToast("正在重载界面…");
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      await api("/api/inject", { method: "POST", body: "{}" });
    } catch (error) {
      updateUi.reload.disabled = false;
      showToast(error.message || String(error), true);
    }
  }

  function handleUpdateAvailable() {
    updateTabDot.hidden = false;
    if (activeTab === "about") loadAppUpdate().catch(() => {});
    else showToast("发现新版本，可在「关于」页查看");
  }
  window.addEventListener(UPDATE_AVAILABLE_EVENT, handleUpdateAvailable);

  function renderAppUpdateConfig(appUpdate, update) {
    if (!appUpdate) return;
    appUpdateConfig = appUpdate;
    settingsUi.appUpdateAuto.value = appUpdate.autoCheck ? "on" : "off";
    settingsUi.appUpdateBadge.className =
      `te-badge te-app-update-badge${appUpdate.autoCheck ? " ok" : ""}`;
    settingsUi.appUpdateBadge.textContent = appUpdate.autoCheck ? "已开启" : "已关闭";

    settingsUi.appUpdateStatus.textContent = "";
    appendStatusLine(
      settingsUi.appUpdateStatus,
      "检查频率",
      appUpdate.autoCheck ? "每天一次" : "自动检查已关闭，「立即检查」仍然可用",
    );
    if (update?.error) {
      appendStatusLine(settingsUi.appUpdateStatus, "上次结果", `检查失败：${update.error}`);
    } else if (update?.checkedAt) {
      appendStatusLine(
        settingsUi.appUpdateStatus,
        "上次结果",
        update.hasUpdate ? `发现新版本 v${update.latest.version}` : "已是最新版本",
      );
      appendStatusLine(settingsUi.appUpdateStatus, "上次检查", formatExpiry(update.checkedAt));
    }
  }

  async function saveAppUpdateConfig() {
    const autoCheck = settingsUi.appUpdateAuto.value === "on";
    settingsUi.appUpdateSave.disabled = true;
    try {
      const data = await api("/api/settings/app-update", {
        method: "POST",
        body: JSON.stringify({ autoCheck }),
      });
      renderAppUpdateConfig(data.appUpdate, appUpdateSnapshot);
      showToast(autoCheck ? "已保存：后台每天检查一次更新" : "已关闭自动检查");
      // Turning it on is the user's own click, so this is the same deliberate
      // request as「立即检查」— and it is the only way a result appears without
      // waiting for the next daily sweep.
      if (autoCheck && !appUpdateSnapshot?.checkedAt) {
        await checkAppUpdate({ silent: true });
      }
    } catch (error) {
      showToast(error.message || String(error), true);
    } finally {
      settingsUi.appUpdateSave.disabled = false;
    }
  }

  async function loadSettings({ silent = false } = {}) {
    try {
      const [data, update] = await Promise.all([
        api("/api/settings"),
        api("/api/update").catch(() => null),
      ]);
      renderTraeUpdate(data.traeUpdate);
      renderCheckin(data.checkin);
      renderNetwork(data.network);
      // `/api/update` is the cached result, so the section reports the last check
      // without the settings tab ever reaching the network.
      renderAppUpdateConfig(data.appUpdate, update ?? appUpdateSnapshot);
      settingsLoaded = true;
    } catch (error) {
      settingsUi.traeBadge.className = "te-badge te-trae-badge warn";
      settingsUi.traeBadge.textContent = "读取失败";
      settingsUi.traeStatus.textContent = "";
      appendStatusLine(settingsUi.traeStatus, "错误", error.message || String(error));
      if (!silent) showToast(error.message || String(error), true);
    }
  }

  /**
   * Polls health until the daemon answers again. The restart is asynchronous by
   * design: the helper has to outlive the process it replaces.
   */
  async function waitForDaemonReady({ timeoutMs = 60000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    await new Promise((resolve) => setTimeout(resolve, 800));
    while (Date.now() < deadline) {
      try {
        // 通过 WS 探测：合并版 CSP 禁止 `connect-src http:`，fetch 会被拦截；守护
        // 进程重启期间 socket 会断开并被上面的 onclose 拒绝，恢复后这里就通了。
        await api("/api/health");
        return true;
      } catch {
        // Still down; keep waiting.
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    return false;
  }

  async function requestDaemonRestart() {
    for (const button of settingsUi.restartButtons) button.disabled = true;
    showToast("正在重启守护进程...");
    try {
      await api("/api/daemon/restart", { method: "POST", body: "{}" });
    } catch (error) {
      for (const button of settingsUi.restartButtons) button.disabled = false;
      showToast(error.message || String(error), true);
      return;
    }
    const ready = await waitForDaemonReady();
    for (const button of settingsUi.restartButtons) button.disabled = false;
    if (!ready) {
      showToast("守护进程没有在预期时间内恢复，请查看日志", true);
      return;
    }
    showToast("守护进程已重启");
    settingsUi.restartBanner.classList.remove("show");
    await loadSettings();
    refresh().catch(() => {});
  }

  /**
   * The daemon pushes this after any account state change. Nothing is requested
   * while the panel is closed, and the handler never asks for a credit refresh:
   * the daemon already pushes after its own refresh, so asking again here would
   * loop. The 150ms debounce collapses a burst of changes into one repaint.
   *
   * The listener is removed by `__traeMetaCleanup`, because the daemon
   * re-injects this script every time CDP reconnects.
   */
  let accountsUpdatedPending = false;
  let accountsUpdatedTimer = null;
  function handleAccountsUpdated() {
    if (!panel.classList.contains("open") || accountsUpdatedPending) return;
    accountsUpdatedPending = true;
    accountsUpdatedTimer = setTimeout(() => {
      accountsUpdatedPending = false;
      if (panel.classList.contains("open")) refresh().catch(() => {});
    }, 150);
  }
  window.addEventListener(ACCOUNTS_UPDATED_EVENT, handleAccountsUpdated);

  /**
   * The launcher's way of speaking to a user whose window it could not bring to
   * the front. One-shot with no retry, so a panel that happens to be closed is
   * opened first — otherwise the toast would render inside a hidden panel and
   * nothing would be seen at all.
   */
  function handleNotice(event) {
    const message = event?.detail?.message;
    if (!message) return;
    if (!panel.classList.contains("open")) openPanel();
    showToast(message, true);
  }
  window.addEventListener(NOTICE_EVENT, handleNotice);

  function failureDetails(result) {
    const failures = Array.isArray(result?.results)
      ? result.results.filter((entry) => entry && entry.ok === false && entry.error)
      : [];
    if (!failures.length) return "";
    const shown = failures.slice(0, 2).map((entry) => String(entry.error));
    const extra = failures.length - shown.length;
    return `${shown.join(" / ")}${extra > 0 ? ` （另有 ${extra} 个）` : ""}`;
  }

  async function runAccountCheckin() {
    if (checkinBusy) return;
    const button = toolbar.querySelector(".te-run-checkin");
    checkinBusy = true;
    button.disabled = true;
    showToast("正在检查全部账号的签到状态...");
    try {
      const result = await api("/api/checkin/run", {
        method: "POST",
        body: "{}",
      });
      await refresh();
      const summary = [
        result.checkedIn ? `新签到 ${result.checkedIn}` : "",
        result.skipped ? `已签到 ${result.skipped}` : "",
        result.failed ? `失败 ${result.failed}` : "",
      ].filter(Boolean).join("，");
      const details = failureDetails(result);
      const base = summary ? `签到完成：${summary}` : "全部账号今日均已签到";
      showToast(details ? `${base} — ${details}` : base, result.failed > 0);
      if (result.checkedIn > 0) {
        refreshAccountInsights().catch(() => {});
      }
    } catch (error) {
      showToast(error.message || String(error), true);
    } finally {
      checkinBusy = false;
      button.disabled = false;
    }
  }

  function openSwitchDialog(account) {
    switchAccountId = account.id;
    switchAccountName = account.displayName || "目标账号";
    switchBusy = false;
    switchMask.querySelector(".te-switch-status").textContent =
      `切换到「${switchAccountName}」会先关闭正在运行的 TRAE（未保存的内容会丢失），再用该账号重新打开。是否继续？`;
    const cancel = switchMask.querySelector(".te-switch-cancel");
    const submit = switchMask.querySelector(".te-switch-submit");
    cancel.disabled = false;
    submit.disabled = false;
    cancel.focus();
    switchMask.classList.add("open");
  }

  function closeSwitchDialog() {
    switchMask.classList.remove("open");
    switchAccountId = null;
    switchAccountName = "";
    switchBusy = false;
  }

  /**
   * Runs the switch after the user confirms.
   *
   * The panel lives inside the TRAE that is about to be closed, so on success it
   * usually dies before this promise resolves and never gets to show the farewell
   * toast — that is expected. The failure path (a rejected request while the
   * renderer is still alive) is what this keeps interactive.
   */
  async function confirmSwitchAccount() {
    if (!switchAccountId || switchBusy) return;
    switchBusy = true;
    const cancel = switchMask.querySelector(".te-switch-cancel");
    const submit = switchMask.querySelector(".te-switch-submit");
    const status = switchMask.querySelector(".te-switch-status");
    cancel.disabled = true;
    submit.disabled = true;
    status.textContent =
      `正在切换到「${switchAccountName}」...TRAE 会先退出，再用该账号自动重启，请稍候。`;
    try {
      await api("/api/accounts/switch", {
        method: "POST",
        body: JSON.stringify({ accountId: switchAccountId }),
      });
      const switchedName = switchAccountName;
      closeSwitchDialog();
      showToast(`已切换到「${switchedName}」`);
      await refresh();
    } catch (error) {
      status.textContent = error.message || String(error);
      switchBusy = false;
      cancel.disabled = false;
      submit.disabled = false;
    }
  }

  /**
   * Asks the daemon to exchange this account's credentials right now.
   *
   * The card's「有效期至」is the only thing the user is asked to read; the panel
   * never mentions token kinds. When the server does not hand back a new expiry
   * the stored date is unchanged, and the panel says exactly that rather than
   * reporting a renewal it cannot prove.
   */
  async function renewAccount(button, accountId) {
    const card = button.closest(".te-card");
    const name = card?.querySelector(".te-name")?.textContent || "目标账号";
    button.disabled = true;
    showToast(`正在为「${name}」续签...`);
    try {
      const result = await api("/api/accounts/renew", {
        method: "POST",
        body: JSON.stringify({ accountId }),
      });
      if (result.renewed) {
        showToast(`「${name}」已续签，有效期至 ${formatExpiry(result.accessExpiresAt)}`);
      } else {
        showToast("未取得新的到期时间，无法确认是否续期", true);
      }
      await refresh();
    } catch (error) {
      showToast(error.message || String(error), true);
      await refresh();
    } finally {
      button.disabled = false;
    }
  }

  function openDeleteDialog(account) {
    deleteAccountId = account.id;
    deleteAccountName = account.displayName || "该账号";
    const status = deleteMask.querySelector(".te-delete-status");
    status.textContent = `将删除「${deleteAccountName}」的本地备份。不会退出 TRAE 当前登录，也不能在助手内撤销。`;
    deleteMask.querySelector(".te-delete-submit").disabled = false;
    deleteMask.querySelector(".te-delete-cancel").focus();
    deleteMask.classList.add("open");
  }

  function closeDeleteDialog() {
    deleteMask.classList.remove("open");
    deleteAccountId = null;
    deleteAccountName = "";
  }

  async function confirmDeleteAccount() {
    if (!deleteAccountId) return;
    const submit = deleteMask.querySelector(".te-delete-submit");
    const status = deleteMask.querySelector(".te-delete-status");
    submit.disabled = true;
    status.textContent = `正在删除「${deleteAccountName}」的本地备份...`;
    try {
      await api("/api/accounts/delete", {
        method: "POST",
        body: JSON.stringify({ accountId: deleteAccountId }),
      });
      const deletedName = deleteAccountName;
      closeDeleteDialog();
      showToast(`已删除「${deletedName}」的本地备份`);
      await refresh();
    } catch (error) {
      status.textContent = error.message || String(error);
      submit.disabled = false;
    }
  }

  function setLoginStatus(message, error = false) {
    const status = oauthMask.querySelector(".te-modal-status");
    status.textContent = message;
    status.style.color = error ? "#ef4444" : "";
  }

  function showLoginProgress(title, message, { reopen = false } = {}) {
    oauthMask.querySelector(".te-login-progress-title").textContent = title;
    oauthMask.querySelector(".te-oauth-reopen").hidden = !reopen;
    oauthMask.querySelector(".te-oauth-cancel").textContent = "取消";
    setLoginStatus(message);
    oauthMask.classList.add("open");
  }

  function stopOAuthPolling() {
    clearTimeout(oauthPollTimer);
    oauthPollTimer = null;
  }

  function closeOAuthDialog({ cancel = false } = {}) {
    stopOAuthPolling();
    if (cancel && oauthSession?.loginId) {
      api("/api/oauth/cancel", {
        method: "POST",
        body: JSON.stringify({ loginId: oauthSession.loginId }),
      }).catch(() => {});
    }
    oauthSession = null;
    oauthMask.classList.remove("open");
  }

  async function pollOAuthStatus() {
    if (!oauthSession?.loginId) return;
    try {
      const result = await api(
        `/api/oauth/status?loginId=${encodeURIComponent(oauthSession.loginId)}`,
      );
      if (result.status === "pending") {
        setLoginStatus("请在浏览器中完成扫码或账号授权，完成后会自动加入账号列表。");
      } else if (result.status === "exchanging") {
        setLoginStatus("授权已收到，正在保存账号登录信息...");
      } else if (result.status === "syncing") {
        setLoginStatus("账号已保存，正在同步额度和签到...");
      } else if (result.status === "complete") {
        setLoginStatus("账号已加入列表，当前登录账号不会被切换。");
        await refresh();
        setTimeout(() => closeOAuthDialog(), 1200);
        return;
      } else if (result.status === "error") {
        setLoginStatus(result.error || "登录失败", true);
        return;
      } else if (result.status === "cancelled") {
        closeOAuthDialog();
        return;
      }
      oauthPollTimer = setTimeout(pollOAuthStatus, 1000);
    } catch (error) {
      setLoginStatus(error.message || String(error), true);
    }
  }

  async function startOAuth() {
    const button = toolbar.querySelector(".te-login-new");
    button.disabled = true;
    showLoginProgress("无感登录", "正在创建授权会话...", { reopen: true });
    try {
      const result = await api("/api/oauth/start", {
        method: "POST",
        body: "{}",
      });
      oauthSession = result;
      if (result.browserOpened) {
        setLoginStatus("请在浏览器中完成扫码或账号授权，完成后会自动加入账号列表。");
      } else {
        setLoginStatus(result.browserError || "浏览器未能自动打开，请点击“重新打开”。", true);
      }
      oauthPollTimer = setTimeout(pollOAuthStatus, 800);
    } catch (error) {
      setLoginStatus(error.message || String(error), true);
    } finally {
      button.disabled = false;
    }
  }

  function setTransferStatus(message, error = false) {
    const status = transferMask.querySelector(".te-transfer-status");
    status.textContent = message;
    status.style.color = error ? "#ef4444" : "";
  }

  function closeTransferDialog() {
    transferMask.classList.remove("open");
    transferMask.querySelector(".te-transfer-body").replaceChildren();
    setTransferStatus("");
    transferSubmit = null;
    transferBusy = false;
  }

  function openTransferDialog({ title, confirmText }) {
    transferMask.querySelector(".te-transfer-title").textContent = title;
    transferMask.querySelector(".te-transfer-confirm").textContent = confirmText;
    transferMask.querySelector(".te-transfer-confirm").disabled = false;
    transferMask.querySelector(".te-transfer-cancel").disabled = false;
    const body = transferMask.querySelector(".te-transfer-body");
    body.replaceChildren();
    setTransferStatus("");
    transferMask.classList.add("open");
    return body;
  }

  function createTransferNote(text) {
    const note = document.createElement("div");
    note.className = "te-transfer-note";
    note.textContent = text;
    return note;
  }

  function createField(labelText, { type = "password", autocomplete = "new-password" } = {}) {
    const label = document.createElement("label");
    label.className = "te-field";
    const caption = document.createElement("span");
    caption.textContent = labelText;
    const input = document.createElement("input");
    input.type = type;
    input.autocomplete = autocomplete;
    label.append(caption, input);
    return { label, input };
  }

  function downloadTransfer(result, fallbackName) {
    const blob = new Blob([result.content], {
      type: result.mimeType || "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = result.filename || fallbackName;
    document.body.appendChild(anchor);
    anchor.click();
    setTimeout(() => {
      anchor.remove();
      URL.revokeObjectURL(url);
    }, 300);
  }

  async function openExportDialog() {
    try {
      const data = await api("/api/accounts");
      if (!data.accounts.length) {
        showToast("没有可导出的账号备份", true);
        return;
      }
      const body = openTransferDialog({
        title: "导出账号",
        confirmText: "导出",
      });
      body.append(
        createTransferNote(
          "导出的是此刻的登录信息，不是可以两台设备共用的副本。导入到其他设备后，本机上的这些账号会被顶下线，需要重新登录才能恢复 —— 请当作搬迁，不要在两台设备上同时管理同一个账号。",
        ),
      );
      const selected = new Set(data.accounts.map((account) => account.id));
      const heading = document.createElement("div");
      heading.className = "te-transfer-select-head";
      const headingLabel = document.createElement("span");
      headingLabel.textContent = "选择账号";
      const toggle = document.createElement("button");
      toggle.className = "te-transfer-toggle";
      toggle.type = "button";
      toggle.textContent = "取消全选";
      heading.append(headingLabel, toggle);

      const options = document.createElement("div");
      options.className = "te-transfer-options";
      for (const account of data.accounts) {
        const label = document.createElement("label");
        label.className = "te-transfer-option selected";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = true;
        input.dataset.accountId = account.id;
        const copy = document.createElement("span");
        copy.className = "te-transfer-option-copy";
        const name = document.createElement("span");
        name.className = "te-transfer-option-name";
        name.textContent = account.displayName || "TRAE account";
        const meta = document.createElement("span");
        meta.className = "te-transfer-option-meta";
        meta.textContent = accountMeta(account);
        copy.append(name, meta);
        label.append(input, copy);
        input.addEventListener("change", () => {
          if (input.checked) selected.add(account.id);
          else selected.delete(account.id);
          label.classList.toggle("selected", input.checked);
          toggle.textContent = selected.size === data.accounts.length ? "取消全选" : "全选";
        });
        options.appendChild(label);
      }
      toggle.addEventListener("click", () => {
        const selectAll = selected.size !== data.accounts.length;
        selected.clear();
        if (selectAll) {
          data.accounts.forEach((account) => selected.add(account.id));
        }
        options.querySelectorAll("input[data-account-id]").forEach((input) => {
          input.checked = selectAll;
          input.closest(".te-transfer-option")?.classList.toggle("selected", selectAll);
        });
        toggle.textContent = selectAll ? "取消全选" : "全选";
      });

      const password = createField("密码");
      const confirmation = createField("确认密码");
      body.append(heading, options, password.label, confirmation.label);
      password.input.focus();

      transferSubmit = async () => {
        if (!selected.size) throw new Error("请至少选择一个账号");
        if (password.input.value.trim().length < 8) {
          throw new Error("密码至少需要 8 个字符");
        }
        if (password.input.value !== confirmation.input.value) {
          throw new Error("两次输入的密码不一致");
        }
        setTransferStatus("正在加密账号备份...");
        const result = await api("/api/accounts/export", {
          method: "POST",
          body: JSON.stringify({
            accountIds: [...selected],
            password: password.input.value,
          }),
        });
        downloadTransfer(result, "TraeMeta-accounts.json");
        showToast(`已导出 ${result.count} 个账号（已加密）`);
        closeTransferDialog();
      };
    } catch (error) {
      showToast(error.message || String(error), true);
      closeTransferDialog();
    }
  }

  async function openImportDialog(file) {
    try {
      if (file.size > 32 * 1024 * 1024) {
        throw new Error("导入文件过大");
      }
      const content = await file.text();
      const body = openTransferDialog({
        title: "导入账号",
        confirmText: "导入",
      });
      const fileName = document.createElement("div");
      fileName.className = "te-transfer-file";
      fileName.textContent = file.name;
      const password = createField("密码", { autocomplete: "current-password" });
      body.append(
        createTransferNote(
          "这是某台设备导出的登录信息。如果原设备仍在运行并自动续期，这里导入的登录会失效（401），需要重新登录 —— 搬迁完成后，请在原设备上停用这些账号。",
        ),
        fileName,
        password.label,
      );
      password.input.focus();

      transferSubmit = async () => {
        if (!password.input.value.trim()) throw new Error("密码不能为空");
        setTransferStatus("正在解密并校验账号备份...");
        const result = await api("/api/accounts/import", {
          method: "POST",
          body: JSON.stringify({
            content,
            password: password.input.value,
          }),
        });
        const detail = result.updated
          ? `，新增 ${result.imported}，更新 ${result.updated}`
          : "";
        showToast(`已导入 ${result.count} 个账号${detail}`);
        closeTransferDialog();
        // An imported backup carries only authentication state, so these accounts
        // have no check-in record and no credits. Ask the daemon to reconcile them
        // right away instead of leaving them pending until the panel is reopened.
        syncingCheckin = true;
        await refresh();
        await reconcileWithDaemon();
      };
    } catch (error) {
      showToast(error.message || String(error), true);
      closeTransferDialog();
    }
  }

  function openPanel() {
    panel.classList.add("open");
    // Anchored per open: the widget may have been dragged since the last time, so
    // the side with room for the panel is not a constant.
    positionPanel();
    adoptionError = null;
    // The daemon adopts the signed-in account on its own now, so this is only a
    // fallback for the moment the panel is opened. Kept because it is the one path
    // that works when the daemon has been running since before TRAE was signed in.
    void refreshAboutCheckinText();
    // Paints whatever the daemon last found, so the About card is filled before
    // the tab is ever opened.
    void loadAppUpdate();
    // Paint "同步中" first: until the daemon answers, an account with no local
    // check-in record may well already be checked in on the server.
    syncingCheckin = true;
    refresh()
      .then(async (data) => {
        if (
          data?.accounts?.length === 0 &&
          data.currentAccountState === "not-managed"
        ) {
          const backup = await autoBackupCurrent();
          if (backup.ok) {
            adoptionError = null;
            data = await refresh();
          } else {
            adoptionError = backup.error;
            // Repaint so the reason replaces the bare empty state right away.
            renderAccounts(
              data.accounts,
              data.currentAccountId,
              data.currentAccountState,
            );
          }
        }
        const result = await reconcileWithDaemon();
        // The daemon orchestrates check-in and credits whenever it is free. When it
        // is busy or blocked by Cockpit Tools, fall back to v1.0.0's own credit
        // refresh so opening the panel never regresses.
        if (!result || result.busy || result.skipped) {
          if (data?.accounts && shouldRefreshInsights(data.accounts)) {
            refreshAccountInsights().catch(() => {});
          }
        }
      })
      .catch(() => {
        syncingCheckin = false;
      });
  }

  function closePanel() {
    panel.classList.remove("open");
  }

  /**
   * Moving the widget, and putting it back where it was left.
   *
   * It was pinned to the bottom-right corner, which on a wide window lands on top
   * of the editor's own floating controls with no way to get it out of the way.
   * The icon and the panel header both drag the whole widget, and the position is
   * stored so a reload returns it. Nothing here is required for the panel to work:
   * with no stored position the original corner is used unchanged.
   */
  const POSITION_KEY = "traemeta:widget-position";
  // Movement smaller than this is still a click; without it every click would
  // jitter the widget by a pixel or two and be remembered as a move.
  const DRAG_THRESHOLD = 4;
  let dragState = null;
  let ignoreNextFabClick = false;

  function clampToViewport(left, top) {
    const width = root.offsetWidth || 42;
    const height = root.offsetHeight || 42;
    return {
      left: Math.min(Math.max(0, left), Math.max(0, window.innerWidth - width)),
      top: Math.min(Math.max(0, top), Math.max(0, window.innerHeight - height)),
    };
  }

  /** Places the widget; `left` and `right` must never both be set, or the fixed
   * box stretches across the window instead of moving. */
  function moveWidget(left, top) {
    const next = clampToViewport(left, top);
    root.style.left = `${next.left}px`;
    root.style.top = `${next.top}px`;
    root.style.right = "auto";
    root.style.bottom = "auto";
    return next;
  }

  function storedWidgetPosition() {
    try {
      const saved = JSON.parse(localStorage.getItem(POSITION_KEY) ?? "null");
      return Number.isFinite(saved?.left) && Number.isFinite(saved?.top) ? saved : null;
    } catch {
      // Unreadable means "never moved"; it must not take the panel down.
      return null;
    }
  }

  const savedWidgetPosition = storedWidgetPosition();
  if (savedWidgetPosition) moveWidget(savedWidgetPosition.left, savedWidgetPosition.top);

  /** Anchors the panel to whichever side of the icon has room for it, so a widget
   * dragged to the left or top edge does not open its panel past the window. */
  function positionPanel() {
    const rect = root.getBoundingClientRect();
    panel.style.left = "";
    panel.style.right = "";
    panel.style.top = "";
    panel.style.bottom = "";
    // Anchored to the side that actually has room, measured against the panel's
    // own size. `right: 0` grows the panel leftward from the icon's right edge, so
    // it needs that much space to the left; `left: 0` mirrors it to the right.
    panel.style[rect.right >= panel.offsetWidth ? "right" : "left"] = "0";
    // Vertical works the same way: `bottom: 50px` sits the panel above the icon,
    // so the room it needs is the distance from the viewport top down to the
    // icon's bottom edge. Near the top the panel flips below instead.
    panel.style[rect.bottom >= panel.offsetHeight ? "bottom" : "top"] = "50px";
  }

  function wireDrag(handle, canStart) {
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || (canStart && !canStart(event))) return;
      const rect = root.getBoundingClientRect();
      dragState = {
        x: event.clientX,
        y: event.clientY,
        left: rect.left,
        top: rect.top,
        moved: false,
      };
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointermove", (event) => {
      if (!dragState) return;
      const dx = event.clientX - dragState.x;
      const dy = event.clientY - dragState.y;
      // Below the threshold this is still a click, so nothing moves yet.
      if (!dragState.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
      dragState.moved = true;
      moveWidget(dragState.left + dx, dragState.top + dy);
    });
    const finish = (event) => {
      if (!dragState) return;
      const moved = dragState.moved;
      dragState = null;
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      if (!moved) return;
      if (handle === fab) ignoreNextFabClick = true;
      const rect = root.getBoundingClientRect();
      const next = moveWidget(rect.left, rect.top);
      try {
        localStorage.setItem(POSITION_KEY, JSON.stringify(next));
      } catch {
        // Remembering the spot is a convenience; blocked or full storage must not
        // turn a drag into a visible error.
      }
    };
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
  }

  wireDrag(fab);
  // Buttons in the header keep their own click, so drags starting on one are left
  // alone — otherwise the close button would become a drag handle.
  wireDrag(header, (event) => !event.target.closest("button, a, input, select"));

  // A window that shrank can leave the widget past the new edge, so it is pulled
  // back. The stored value is left as it is: the window may grow again.
  window.addEventListener("resize", () => {
    if (!root.style.left) return;
    moveWidget(root.getBoundingClientRect().left, root.getBoundingClientRect().top);
  });

  fab.addEventListener("click", () => {
    // A drag ends with a click on the button it started on, and that click must
    // not also toggle the panel.
    if (ignoreNextFabClick) {
      ignoreNextFabClick = false;
      return;
    }
    if (panel.classList.contains("open")) closePanel();
    else openPanel();
  });
  header.querySelector(".te-close").addEventListener("click", closePanel);
  toolbar.querySelector(".te-refresh").addEventListener("click", () => {
    refreshAccountInsights({ manual: true }).catch(() => {});
  });
  toolbar.querySelector(".te-run-checkin").addEventListener("click", () => {
    runAccountCheckin().catch(() => {});
  });
  toolbar.querySelector(".te-login-new").addEventListener("click", () => {
    startOAuth().catch(() => {});
  });
  toolbar.querySelector(".te-export-accounts").addEventListener("click", () => {
    openExportDialog().catch(() => {});
  });
  toolbar.querySelector(".te-import-accounts").addEventListener("click", () => {
    importFileInput.click();
  });
  importFileInput.addEventListener("change", () => {
    const file = importFileInput.files?.[0];
    importFileInput.value = "";
    if (file) openImportDialog(file).catch(() => {});
  });
  tabs.querySelectorAll(".te-tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });
  settingsPane.querySelectorAll(".te-settings-nav-item").forEach((item) => {
    item.addEventListener("click", () => switchSettingsSection(item.dataset.settingsSection));
  });
  settingsUi.traeSave.addEventListener("click", () => {
    saveTraeUpdate().catch(() => {});
  });
  settingsUi.checkinSave.addEventListener("click", () => {
    saveCheckinConfig().catch(() => {});
  });
  // The master switch takes effect on the form immediately, so the two governed
  // fields never look editable while they are ignored.
  settingsUi.checkinAuto.addEventListener("change", () => {
    applyCheckinVisibility(settingsUi.checkinAuto.value === "on");
  });
  settingsUi.netSave.addEventListener("click", () => {
    saveNetworkConfig().catch(() => {});
  });
  settingsUi.netTest.addEventListener("click", () => {
    testNetworkConfig().catch(() => {});
  });
  // Choosing a mode reshapes the form at once, so the fields a mode ignores are
  // never left on screen looking editable.
  for (const input of settingsUi.netModeInputs) {
    input.addEventListener("change", () => {
      // Switching away from a custom proxy drops a pending "clear credentials"
      // request, which only ever applies to the credentials of that proxy.
      netClearCredentials = false;
      applyNetVisibility();
    });
  }
  settingsUi.netScheme.addEventListener("change", () => applyNetVisibility());
  settingsUi.netHost.addEventListener("input", () => maybeSplitProxyUrl());
  updateUi.check.addEventListener("click", () => {
    checkAppUpdate().catch(() => {});
  });
  updateUi.open.addEventListener("click", () => {
    installAppUpdate().catch(() => {});
  });
  updateUi.reload.addEventListener("click", () => {
    reloadPanel().catch(() => {});
  });
  settingsUi.appUpdateSave.addEventListener("click", () => {
    saveAppUpdateConfig().catch(() => {});
  });
  settingsUi.appUpdateCheck.addEventListener("click", () => {
    checkAppUpdate().catch(() => {});
  });
  for (const button of settingsUi.restartButtons) {
    button.addEventListener("click", () => {
      requestDaemonRestart().catch(() => {});
    });
  }
  list.addEventListener("click", (event) => {
    const creditsButton = event.target.closest(".te-acc-credits");
    if (creditsButton?.dataset.accountId) {
      const account = accountsById.get(creditsButton.dataset.accountId);
      if (account) toggleCreditPopover(creditsButton, account);
      return;
    }
    const deleteButton = event.target.closest(".te-acc-delete");
    if (deleteButton?.dataset.accountId) {
      const account = accountsById.get(deleteButton.dataset.accountId);
      if (account) openDeleteDialog(account);
      return;
    }
    const renewButton = event.target.closest(".te-acc-renew");
    if (renewButton?.dataset.accountId) {
      renewAccount(renewButton, renewButton.dataset.accountId).catch(() => {});
      return;
    }
    const button = event.target.closest(".te-acc-switch");
    if (button?.dataset.accountId) {
      const account = accountsById.get(button.dataset.accountId);
      if (account) openSwitchDialog(account);
    }
  });
  // Capture phase, so a click anywhere else closes the popover before whatever it
  // was aimed at acts on it. The icon's own mousedown is ignored, otherwise the
  // popover would close and reopen on the same click.
  function handleCreditPopoverDismiss(event) {
    if (!creditPopoverAnchor) return;
    if (creditPopover.contains(event.target)) return;
    if (event.target.closest?.(".te-acc-credits")) return;
    closeCreditPopover();
  }
  function handleCreditPopoverEscape(event) {
    if (event.key === "Escape") closeCreditPopover();
  }
  document.addEventListener("mousedown", handleCreditPopoverDismiss, true);
  document.addEventListener("keydown", handleCreditPopoverEscape);
  // A fixed-position popover does not follow its anchor, so a scroll of the list
  // behind it would leave it pointing at the wrong row. Closing is the honest
  // answer there — but the popover scrolls its own content as soon as an account
  // has more segments than fit, and a capture-phase listener on the window sees
  // that scroll too. Acting on it closed the popover the instant its scrollbar
  // moved, which is what made the scrollbar impossible to drag.
  function handleCreditPopoverScroll(event) {
    if (creditPopover.contains(event.target)) return;
    closeCreditPopover();
  }
  window.addEventListener("scroll", handleCreditPopoverScroll, true);
  window.addEventListener("resize", closeCreditPopover);
  deleteMask.querySelector(".te-delete-cancel").addEventListener("click", closeDeleteDialog);
  deleteMask.querySelector(".te-delete-submit").addEventListener("click", () => {
    confirmDeleteAccount().catch(() => {});
  });
  deleteMask.addEventListener("click", (event) => {
    if (event.target === deleteMask) closeDeleteDialog();
  });
  deleteMask.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDeleteDialog();
  });
  switchMask.querySelector(".te-switch-cancel").addEventListener("click", () => {
    if (!switchBusy) closeSwitchDialog();
  });
  switchMask.querySelector(".te-switch-submit").addEventListener("click", () => {
    confirmSwitchAccount().catch(() => {});
  });
  switchMask.addEventListener("click", (event) => {
    if (event.target === switchMask && !switchBusy) closeSwitchDialog();
  });
  switchMask.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !switchBusy) closeSwitchDialog();
  });
  oauthMask.querySelector(".te-oauth-reopen").addEventListener("click", () => {
    if (!oauthSession?.loginId) return;
    api("/api/oauth/open", {
      method: "POST",
      body: JSON.stringify({ loginId: oauthSession.loginId }),
    })
      .then((result) => {
        if (!result.opened) setLoginStatus("浏览器未能打开，请稍后重试。", true);
      })
      .catch((error) => setLoginStatus(error.message || String(error), true));
  });
  oauthMask.querySelector(".te-oauth-cancel").addEventListener("click", () => {
    closeOAuthDialog({ cancel: true });
  });
  transferMask.querySelector(".te-transfer-cancel").addEventListener("click", () => {
    if (!transferBusy) closeTransferDialog();
  });
  transferMask.querySelector(".te-transfer-confirm").addEventListener("click", async () => {
    if (!transferSubmit || transferBusy) return;
    transferBusy = true;
    const confirm = transferMask.querySelector(".te-transfer-confirm");
    const cancel = transferMask.querySelector(".te-transfer-cancel");
    confirm.disabled = true;
    cancel.disabled = true;
    try {
      await transferSubmit();
    } catch (error) {
      setTransferStatus(error.message || String(error), true);
    } finally {
      transferBusy = false;
      confirm.disabled = false;
      cancel.disabled = false;
    }
  });
  transferMask.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !transferBusy) {
      closeTransferDialog();
      return;
    }
    if (event.key === "Enter" && event.target?.tagName === "INPUT") {
      event.preventDefault();
      transferMask.querySelector(".te-transfer-confirm").click();
    }
  });

  window.__traeMetaCleanup = () => {
    clearTimeout(toastTimer);
    clearTimeout(accountsUpdatedTimer);
    window.removeEventListener(ACCOUNTS_UPDATED_EVENT, handleAccountsUpdated);
    window.removeEventListener(NOTICE_EVENT, handleNotice);
    window.removeEventListener(UPDATE_AVAILABLE_EVENT, handleUpdateAvailable);
    window.removeEventListener(UPDATE_PROGRESS_EVENT, handleUpdateProgressEvent);
    document.removeEventListener("mousedown", handleCreditPopoverDismiss, true);
    document.removeEventListener("keydown", handleCreditPopoverEscape);
    window.removeEventListener("scroll", handleCreditPopoverScroll, true);
    window.removeEventListener("resize", closeCreditPopover);
    stopOAuthPolling();
    root.remove();
    style.remove();
    delete window.__traeMetaCleanup;
  };
})();
