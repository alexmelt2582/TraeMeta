import { CdpClient } from "../src/cdp/client.js";
import {
  APP_NAME,
  DEFAULT_CDP_PORT,
  DEFAULT_UI_PORT,
  parsePort,
} from "../src/constants.js";

const cdpPort = parsePort(process.env.TRAEMETA_ENHANCER_CDP_PORT, DEFAULT_CDP_PORT);
const uiPort = parsePort(process.env.TRAEMETA_ENHANCER_UI_PORT, DEFAULT_UI_PORT);
const keepOpen = process.argv.includes("--keep-open");

function report(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

async function main() {
  const health = await fetch(`http://127.0.0.1:${uiPort}/api/health`)
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);

  const client = new CdpClient({
    port: cdpPort,
    getInjectScript: async () => "",
  });
  const target = await client.findTarget();
  if (!target) {
    report({
      name: APP_NAME,
      daemon: health,
      cdpPort,
      targetFound: false,
    });
    return;
  }

  await client.connect(target.webSocketDebuggerUrl);
  const panelWasOpen = await client.evaluate(
    `!!document.querySelector("#traemeta-root .te-panel.open")`,
  );
  if (!panelWasOpen) {
    await client.evaluate(`document.querySelector("#traemeta-root .te-fab")?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  const dom = await client.evaluate(`
    ({
      root: !!document.getElementById("traemeta-root"),
      floatingButton: !!document.querySelector("#traemeta-root .te-fab"),
      panel: !!document.querySelector("#traemeta-root .te-panel"),
      panelOpen: !!document.querySelector("#traemeta-root .te-panel.open"),
      accountCards: document.querySelectorAll("#traemeta-root .te-card").length,
      statusText: document.querySelector("#traemeta-root .te-status")?.textContent || ""
    })
  `);
  const identity = await client.getLiveIdentity();

  report({
    name: APP_NAME,
    daemon: health,
    cdpPort,
    targetFound: true,
    target: {
      title: target.title,
      type: target.type,
    },
    dom,
    liveIdentity: identity
      ? {
          userId: Boolean(identity.userId),
          email: Boolean(identity.email),
          phone: Boolean(identity.phone),
          nickname: Boolean(identity.nickname),
        }
      : null,
  });
  if (!panelWasOpen && !keepOpen) {
    await client.evaluate(`document.querySelector("#traemeta-root .te-fab")?.click()`);
  }
  await client.closeSocket();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
