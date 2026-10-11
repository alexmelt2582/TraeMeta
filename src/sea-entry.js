/**
 * Entry point of the bundled single executable.
 *
 * The bundle contains the service CLI, the launcher, the daemon and the
 * watchdog. Which one runs is decided by an internal argv switch, because a
 * single executable cannot load sibling script files from disk.
 *
 * Without a switch the executable behaves exactly like `scripts/service.js`,
 * so `TraeMeta.exe status` and `node scripts/service.js status` agree. The
 * service CLI re-enters this executable with the launcher switch when it needs
 * to start TRAE, which keeps a single user-facing command surface.
 *
 * No top-level await: the bundle is emitted as CommonJS, which does not support
 * it, so the dynamic imports are wrapped in an async function.
 */
import { classifyInternal } from "./lib/launch-spec.js";

async function dispatch() {
  const target = classifyInternal() ?? "service";
  switch (target) {
    case "daemon":
      await import("./daemon.js");
      return;
    case "watchdog":
      await import("../scripts/watchdog.js");
      return;
    case "launcher":
      await import("./launcher.js");
      return;
    default:
      await import("../scripts/service.js");
  }
}

dispatch().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
