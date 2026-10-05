// Point d'entrée du daemon noko.

import { startClaudeSession } from "./claude-session.ts";
import { Daemon } from "./daemon.ts";
import { errorFields, log } from "./log.ts";
import { resolveSocketPath } from "./runtime-dir.ts";

async function main(): Promise<void> {
  let socketPath: string;
  try {
    socketPath = resolveSocketPath();
  } catch (err) {
    // Message sans donnée sensible : il décrit seulement la vérification qui a échoué.
    process.stderr.write(`noko : ${(err as Error).message}\n`);
    process.exit(1);
  }

  const daemon = new Daemon(socketPath, startClaudeSession);
  try {
    await daemon.start();
  } catch (err) {
    process.stderr.write(`noko : ${(err as Error).message}\n`);
    process.exit(1);
  }

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("daemon.stopping", { signal });
    daemon.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        log("daemon.stop_failed", errorFields(err));
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  log("daemon.started", { pid: process.pid });
}

void main();
